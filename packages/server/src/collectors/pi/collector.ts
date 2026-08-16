import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  createEvent,
  UNATTRIBUTED_LANE,
  type AgentRole,
  type AgentThread,
  type Collector,
  type CollectorContext,
  type RhizomorphEvent,
  type PollResult,
} from '@rhizomorph/core'
import { deriveLaneState, needsProcessProbe, quietMsOf, type LaneStateReading } from '../sessionlog/lane-state.js'
import { parseWorktreePaths } from '../sessionlog/parse-worktree-paths.js'
import { defaultProcessProbe, type ProcessLiveness, type ProcessProbe } from '../sessionlog/process-probe.js'
import { isRotated, readNewLines } from '../sessionlog/tail.js'
import { advanceTurnShape, initialTurnShape, type TurnShapeState } from '../sessionlog/turn-shape.js'
import { PI_CAPABILITIES } from './capabilities.js'
import { PI_JSONL_GRAMMAR } from './grammar.js'
import type { PiLaneLiveness, PiSnapshot, PiTailedFileState } from './types.js'

const COLLECTOR_NAME = 'pi'
const JSONL_SUFFIX = '.jsonl'
const HARNESS = 'pi'

/**
 * pi's own tailing organ — issue #546, the wiring #324/#538 made possible.
 * `PI_JSONL_GRAMMAR` and `PI_CAPABILITIES` are real, capture-backed facts;
 * this file is the first thing that actually calls `emit()` with them.
 *
 * **Deliberately not a generalisation of `../sessionlog/collector.ts`.** That
 * file is claude's organ (`collectors/sessionlog/collector.ts` and
 * `parse-session-line.ts` are out of this issue's fence) — this is an
 * independent implementation that reuses only the dialect-agnostic pieces
 * sessionlog already exports for exactly this purpose: the tail/rotation
 * primitives (`tail.ts`), the turn-shape fold (`turn-shape.ts`, a pure
 * function of the generic `TurnEntry` contract), the transcript-tail state
 * machine (`lane-state.ts`), the worktree-list parser
 * (`parse-worktree-paths.ts`), and the process probe (`process-probe.ts`,
 * which already names `pi` in `AGENT_COMMANDS`). None of that is
 * claude-specific; all of it is public, tested, and shared by design.
 *
 * **Where pi's shape genuinely differs from claude's, and what that costs:**
 *
 * - claude's collector discovers session directories by mapping a worktree
 *   path to a project-dir slug (`worktreePathToProjectSlug`) under one root.
 *   pi's session directory layout under `~/.pi/agent/sessions/` was never
 *   independently captured — every real capture in `fixtures/CAPTURE.md` was
 *   written to a scratch dir via `--session-dir`, not the default location —
 *   so this organ does not assume a slug convention it cannot back. It walks
 *   `piSessionsRoot` recursively for `*.jsonl` files instead, and identifies
 *   each session by the `cwd` its own header line reports (see below), never
 *   by where the file happens to sit on disk.
 * - claude's collector reads `cwd`/`gitBranch` off every assistant line,
 *   because claude repeats them there. pi's grammar deliberately extracts
 *   `null` for all four of `sessionId`/`cwd`/`gitBranch`/`requestId` on a
 *   `message` line (`grammar.ts`'s header comment) — those facts exist
 *   exactly once, on the `type: "session"` header line, which is outside
 *   `TurnGrammar`'s one-line, message-only contract. This organ reads that
 *   header line itself, once per file, and caches the result — the one place
 *   it looks at a pi transcript line without going through the grammar.
 * - pi has no branch concept at all (no capture ever shows one), so `branch`
 *   is always `null` here — an honest per-dialect fact, not an omission.
 * - `git worktree list` failing degrades lane *attribution* (role falls back
 *   to `unattributed`) rather than disabling the whole collector, unlike
 *   sessionlog: pi's data is not fundamentally dependent on this repo's git
 *   state the way a project-dir slug lookup is.
 * - `llm.cost`'s primary source is `EVENT_SOURCE_BY_TYPE['llm.cost'] ===
 *   'otel'` (core/src/events/index.ts) — the shared `context.emit` helper has
 *   no way to override that default, and giving it one is a `packages/core`
 *   change outside this fence. Emitting a `sessionlog`-sourced `llm.cost` (a
 *   value `envelopeWithSources` already allows — ADR-0021, telemetry.ts:174)
 *   therefore goes through `createEvent` directly here, exactly the way
 *   `otel`'s own non-primary emitters already do (see
 *   `conformance/codex.test.ts`'s `makeEmitter`) — using the *public* API,
 *   not a workaround of it.
 */

export interface PiCollectorConfig {
  /**
   * Root of pi's session logs. Defaults to `~/.pi/agent/sessions`. Tests
   * point this at a fixture directory so they never depend on the real one.
   */
  piSessionsRoot?: string
  /**
   * When a session file is seen for the very first time, read it from byte 0
   * instead of seeking to its current end. Off by default, matching
   * sessionlog's own default.
   */
  backfill?: boolean
  /** Process-aliveness probe for the transcript-tail state machine. Defaults to `/proc` on Linux/WSL2, honest "unknown" elsewhere. */
  processProbe?: ProcessProbe
}

/** A parsed session header (`type: "session"`), the one line pi's own `cwd`/session id live on. */
interface PiHeader {
  cwd: string | null
  sessionId: string | null
}

export function createPiCollector(config: PiCollectorConfig = {}): Collector<PiSnapshot> {
  const piSessionsRoot = config.piSessionsRoot ?? path.join(homedir(), '.pi', 'agent', 'sessions')
  const backfill = config.backfill ?? false
  const processProbe = config.processProbe ?? defaultProcessProbe()

  return {
    name: COLLECTOR_NAME,
    capabilities: PI_CAPABILITIES,

    initialSnapshot(): PiSnapshot {
      return { disabled: false, files: {} }
    },

    async poll(prevSnapshot, context: CollectorContext): Promise<PollResult<PiSnapshot>> {
      if (prevSnapshot.disabled) {
        return { nextSnapshot: prevSnapshot, events: [] }
      }

      const rootInfo = await statOrNull(piSessionsRoot)
      if (!rootInfo?.isDirectory()) {
        return disable(context, `no pi session directory at ${piSessionsRoot}`)
      }

      // Best-effort only — pi's own facts don't depend on this repo's git
      // state, so a failure here degrades attribution, not tailing.
      const worktreeResult = await context.exec('git', ['worktree', 'list', '--porcelain'], {
        cwd: context.repoPath,
      })
      const worktreePaths = worktreeResult.failed ? [] : parseWorktreePaths(worktreeResult.stdout)
      const mainWorktreePath = worktreePaths[0] ?? null

      const events: RhizomorphEvent[] = []
      const nextFiles: Record<string, PiTailedFileState> = { ...prevSnapshot.files }

      const filePaths = await findJsonlFilesRecursive(piSessionsRoot)
      for (const filePath of filePaths) {
        await tailPiFile(filePath, context, events, nextFiles, backfill, worktreePaths, mainWorktreePath)
      }

      const lanes = await deriveLanes(nextFiles, prevSnapshot.lanes ?? {}, context.now, processProbe)

      return {
        nextSnapshot: { disabled: false, files: nextFiles, lanes },
        events,
      }
    },
  }
}

/**
 * The transcript-tail state machine, run over everything this poll tailed —
 * identical in shape to sessionlog's `deriveLanes`, minus the worktree-fold
 * memory sessionlog needs to keep a landed lane's transcript attributable
 * past its worktree's removal (#165). pi sessions aren't scoped to *this*
 * repo's worktree lifecycle the way a project-dir slug is, so there is
 * nothing here to remember past a poll where the file itself still exists.
 */
async function deriveLanes(
  files: Readonly<Record<string, PiTailedFileState>>,
  previousLanes: Readonly<Record<string, PiLaneLiveness>>,
  now: number,
  processProbe: ProcessProbe,
): Promise<Record<string, PiLaneLiveness>> {
  const freshestByLane = new Map<string, { filePath: string; file: PiTailedFileState }>()
  for (const [filePath, file] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (file.lane === null || file.lane === undefined) continue
    const incumbent = freshestByLane.get(file.lane)
    if (incumbent === undefined || (file.lastWriteTs ?? 0) > (incumbent.file.lastWriteTs ?? 0)) {
      freshestByLane.set(file.lane, { filePath, file })
    }
  }

  const stalledWorktrees: string[] = []
  for (const { file } of freshestByLane.values()) {
    const shape = file.turnShape ?? initialTurnShape()
    const quietMs = quietMsOf(now, shape.lastEntryTs, file.lastWriteTs ?? null)
    if (file.cwd !== null && file.cwd !== undefined && needsProcessProbe(shape.shape, quietMs)) {
      stalledWorktrees.push(file.cwd)
    }
  }
  const liveness: Map<string, ProcessLiveness> =
    stalledWorktrees.length === 0 ? new Map() : await processProbe.probe(stalledWorktrees)

  const lanes: Record<string, PiLaneLiveness> = {}
  for (const [lane, { filePath, file }] of freshestByLane) {
    const shape = file.turnShape ?? initialTurnShape()
    const reading: LaneStateReading | null = deriveLaneState({
      now,
      shape: shape.shape,
      lastEntryTs: shape.lastEntryTs,
      lastWriteTs: file.lastWriteTs ?? null,
      processAlive: file.cwd === null || file.cwd === undefined ? null : (liveness.get(file.cwd) ?? null),
      lastSidechainTs: shape.lastSidechainTs,
    })
    if (reading === null) continue

    lanes[lane] = {
      ...reading,
      lane,
      worktreePath: file.cwd ?? null,
      sessionFile: filePath,
      derivedAt: now,
      previousState: previousLanes[lane]?.state ?? null,
    }
  }
  return lanes
}

async function tailPiFile(
  filePath: string,
  context: CollectorContext,
  events: RhizomorphEvent[],
  nextFiles: Record<string, PiTailedFileState>,
  backfill: boolean,
  worktreePaths: readonly string[],
  mainWorktreePath: string | null,
): Promise<void> {
  const prevFile: PiTailedFileState = nextFiles[filePath] ?? {
    offset: await initialOffset(filePath, backfill),
    turnShape: initialTurnShape(),
    lastWriteTs: null,
    lane: null,
    cwd: null,
    sessionId: null,
  }

  const { lines, nextOffset, lastWriteTs, identity } = await readNewLines(filePath, prevFile.offset, prevFile.identity)
  const rotated = isRotated(prevFile.identity, identity)
  let turnShape: TurnShapeState = rotated ? initialTurnShape() : prevFile.turnShape ?? initialTurnShape()
  let cwd = rotated ? null : prevFile.cwd ?? null
  let sessionId = rotated ? null : prevFile.sessionId ?? null
  let lane = rotated ? null : prevFile.lane ?? null

  // The header (`type: "session"`) is always line 1 and never repeats its
  // facts elsewhere — read it once, directly, the one place this organ looks
  // at a pi line without going through `PI_JSONL_GRAMMAR` (see this file's
  // header comment).
  if (cwd === null) {
    const header = await readPiHeader(filePath)
    if (header !== null) {
      cwd = header.cwd
      sessionId = sessionId ?? header.sessionId
    }
  }

  const worktreePath = cwd
  const role: AgentRole =
    worktreePath === null || worktreePath === mainWorktreePath || !worktreePaths.includes(worktreePath)
      ? 'unattributed'
      : 'worker'

  for (const rawLine of lines) {
    const entry = PI_JSONL_GRAMMAR.classify(rawLine)
    if (entry !== null) turnShape = advanceTurnShape(turnShape, entry)

    const facts = PI_JSONL_GRAMMAR.extractFacts(rawLine)
    if (!facts) continue

    lane = basenameOf(cwd) ?? UNATTRIBUTED_LANE
    const resolvedSessionId = sessionId ?? fallbackSessionId(filePath)
    const emitOptions = facts.timestamp === null ? undefined : { ts: facts.timestamp }
    const thread: AgentThread = facts.isSidechain ? 'subagent' : 'main'

    events.push(
      context.emit(
        'llm.usage',
        {
          lane,
          sessionId: resolvedSessionId,
          worktreePath,
          branch: null,
          thread,
          role,
          model: facts.model,
          tokens: facts.tokens,
          requestId: null,
          durationMs: null,
          harness: HARNESS,
        },
        emitOptions,
      ),
    )

    // pi's authoritative per-turn dollar cost (`CAPTURE.md`'s cost finding) —
    // not exposed by `AssistantLineFacts` (shared with claude, which has no
    // cost field at all), so read straight off the raw line here.
    const costUsd = extractCostUsd(rawLine)
    if (costUsd !== null) {
      events.push(
        createEvent(
          'llm.cost',
          {
            lane,
            sessionId: resolvedSessionId,
            worktreePath,
            branch: null,
            thread,
            role,
            model: facts.model,
            costUsd,
            authoritative: true,
            harness: HARNESS,
          },
          {
            id: context.nextId(),
            ts: emitOptions === undefined ? context.now : Math.floor(emitOptions.ts),
            source: 'sessionlog',
          },
        ),
      )
    }

    for (const toolUse of facts.toolUses) {
      events.push(
        context.emit(
          'tool.activity',
          {
            lane,
            sessionId: resolvedSessionId,
            worktreePath,
            branch: null,
            thread,
            tool: toolUse.tool,
            role,
            durationMs: null,
            filePath: repoRelativeFilePath(toolUse.filePath, worktreePath),
            toolUseId: toolUse.toolUseId,
            harness: HARNESS,
          },
          emitOptions,
        ),
      )
    }
  }

  nextFiles[filePath] = {
    offset: nextOffset,
    turnShape,
    lastWriteTs,
    identity,
    lane: lane ?? basenameOf(cwd) ?? UNATTRIBUTED_LANE,
    cwd,
    sessionId,
  }
}

/** pi's `message.usage.cost.total`, or `null` when this line carries none — never guessed. */
function extractCostUsd(rawLine: string): number | null {
  const trimmed = rawLine.trim()
  if (trimmed.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const line = parsed as Record<string, unknown>
  if (line.type !== 'message') return null
  const message = asRecord(line.message)
  if (!message || message.role !== 'assistant') return null
  const usage = asRecord(message.usage)
  const cost = asRecord(usage?.cost)
  const total = cost?.total
  return typeof total === 'number' && Number.isFinite(total) ? total : null
}

/** Reads and parses only the file's first line — the session header, always `type: "session"`. */
async function readPiHeader(filePath: string): Promise<PiHeader | null> {
  const HEADER_READ_BYTES = 4096
  let handle
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(HEADER_READ_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_BYTES, 0)
    const text = buffer.toString('utf8', 0, bytesRead)
    const newlineIndex = text.indexOf('\n')
    const firstLine = (newlineIndex === -1 ? text : text.slice(0, newlineIndex)).trim()
    if (firstLine.length === 0) return null
    const parsed: unknown = JSON.parse(firstLine)
    const record = asRecord(parsed)
    if (!record || record.type !== 'session') return null
    return {
      cwd: typeof record.cwd === 'string' ? record.cwd : null,
      sessionId: typeof record.id === 'string' ? record.id : null,
    }
  } catch {
    // Unparsable, truncated, or a header longer than HEADER_READ_BYTES — no
    // opinion, retried next poll, never an error (conformance rule 2).
    return null
  } finally {
    await handle?.close()
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

async function findJsonlFilesRecursive(root: string): Promise<string[]> {
  const results: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.endsWith(JSONL_SUFFIX)) results.push(full)
    }
  }
  await walk(root)
  return results.sort()
}

async function initialOffset(filePath: string, backfill: boolean): Promise<number> {
  if (backfill) return 0
  const info = await statOrNull(filePath)
  return info ? Number(info.size) : 0
}

function disable(context: CollectorContext, reason: string): PollResult<PiSnapshot> {
  return {
    nextSnapshot: { disabled: true, files: {} },
    events: [context.emit('collector.disabled', { collector: COLLECTOR_NAME, reason })],
  }
}

async function statOrNull(target: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(target)
  } catch {
    return null
  }
}

function basenameOf(target: string | null): string | null {
  if (target === null) return null
  const base = path.basename(target)
  return base.length > 0 ? base : null
}

function fallbackSessionId(filePath: string): string {
  const name = path.basename(filePath)
  return name.endsWith(JSONL_SUFFIX) ? name.slice(0, -JSONL_SUFFIX.length) : name
}

/**
 * Normalizes a tool_use's reported path to repo-relative when it sits under
 * the lane's own worktree — mirrors sessionlog's own helper exactly (prd11
 * ruling 2), duplicated rather than imported since sessionlog's copy is
 * private to that module.
 */
function repoRelativeFilePath(filePath: string | null, worktreePath: string | null): string | null {
  if (filePath === null || worktreePath === null) return filePath
  const relative = path.relative(worktreePath, filePath)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return filePath
  return relative
}
