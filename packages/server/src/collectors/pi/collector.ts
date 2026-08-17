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
import { isInside } from '../../paths/containment.js'
import { deriveLaneState, needsProcessProbe, quietMsOf, type LaneStateReading } from '../sessionlog/lane-state.js'
import { parseWorktreePaths } from '../sessionlog/parse-worktree-paths.js'
import { defaultProcessProbe, type ProcessLiveness, type ProcessProbe } from '../sessionlog/process-probe.js'
import { isRotated, readNewLines } from '../sessionlog/tail.js'
import { advanceTurnShape, initialTurnShape, type TurnShapeState } from '../sessionlog/turn-shape.js'
import { PI_CAPABILITIES } from './capabilities.js'
import { PI_JSONL_GRAMMAR } from './grammar.js'
import type { PiHeader, PiLaneLiveness, PiSnapshot, PiTailedFileState } from './types.js'

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
 *
 *   **That walk is a machine-wide one, so its results are scoped before they
 *   are used** (#609). `~/.pi/agent/sessions/` holds every pi session the
 *   operator has ever run, across every unrelated project on the machine.
 *   `worktreesInScope` below resolves each session's header `cwd` to the
 *   watched worktree containing it (`isInside`, so a session started in a
 *   subdirectory still resolves to its worktree root), and a session that
 *   resolves to none is skipped entirely — not tailed, not emitted, not
 *   recorded. Without that, two unrelated projects sharing a leaf directory
 *   name (`api`, `web`, `server` — the common case, not the exotic one)
 *   both key to the same lane, `deriveLanes`' freshest-wins fold discards
 *   one of them outright, and the other's telemetry lands on a dashboard
 *   lane belonging to a different codebase. This is the discipline
 *   sessionlog gets structurally, by only ever reading the project-dir slug
 *   of a worktree it already watches; pi has to apply it explicitly because
 *   its walk cannot be scoped by path shape.
 * - claude's collector reads `cwd`/`gitBranch` off every assistant line,
 *   because claude repeats them there. pi's grammar deliberately extracts
 *   `null` for all four of `sessionId`/`cwd`/`gitBranch`/`requestId` on a
 *   `message` line (`grammar.ts`'s header comment) — those facts exist
 *   exactly once, on the `type: "session"` header line, which is outside
 *   `TurnGrammar`'s one-line, message-only contract. This organ reads that
 *   header line itself, once per file, and caches the result — the one place
 *   it looks at a pi transcript line without going through the grammar.
 * - pi has no branch concept at all (no capture ever shows one), so `branch`
 *   is always `null` here — an honest per-dialect fact, not an omission. It
 *   is also why the lane key cannot fall back to a branch the way
 *   sessionlog's does (`facts.gitBranch ?? basenameOf(...)`), and therefore
 *   why the scoping above is load-bearing rather than belt-and-braces: a
 *   worktree basename is the *only* disambiguator this organ has.
 * - `git worktree list` failing does not disable the collector, unlike
 *   sessionlog. It narrows this poll's scope to the watched repo path itself,
 *   on top of every worktree already remembered in `knownWorktrees` — so a
 *   transient git failure costs at most the discovery of a worktree added
 *   during it, never the lanes already being watched.
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

      // `git worktree list --porcelain` always names the main working tree
      // first, then linked worktrees in the order they were added. When it
      // cannot be read at all, the watched repo path itself is the only scope
      // this collector can honestly claim — never "everything on the machine".
      const worktreeResult = await context.exec('git', ['worktree', 'list', '--porcelain'], {
        cwd: context.repoPath,
      })
      const parsedWorktreePaths = worktreeResult.failed ? [] : parseWorktreePaths(worktreeResult.stdout)
      const liveWorktreePaths = parsedWorktreePaths.length > 0 ? parsedWorktreePaths : [context.repoPath]
      const mainWorktreePath = liveWorktreePaths[0]!

      // The fold sessionlog keeps for the same reason (#165): a worker
      // worktree is removed once its work lands, but its pi transcript lives
      // on under `~/.pi` and must stay attributable to the lane that wrote it.
      // A folded worktree keeps whatever role it was last seen with.
      const knownWorktrees: Record<string, AgentRole> = { ...(prevSnapshot.knownWorktrees ?? {}) }
      for (const worktreePath of liveWorktreePaths) {
        knownWorktrees[worktreePath] = worktreePath === mainWorktreePath ? 'unattributed' : 'worker'
      }
      const worktreesInScope = Object.keys(knownWorktrees)

      const events: RhizomorphEvent[] = []
      const nextFiles: Record<string, PiTailedFileState> = { ...prevSnapshot.files }
      const nextHeaders: Record<string, PiHeader> = {}
      // One resolution per distinct `cwd` per poll — `isInside` canonicalizes
      // both sides through `realpath(3)` on every call, and unrelated sessions
      // of the same project share a `cwd`.
      const ownerByCwd = new Map<string, string | null>()

      const filePaths = await findJsonlFilesRecursive(piSessionsRoot)
      for (const filePath of filePaths) {
        // Cached so a session belonging to another project costs one header
        // read ever, not one per poll. Only a resolved `cwd` is cached; a
        // truncated or not-yet-written header is retried next poll.
        const header = prevSnapshot.headers?.[filePath] ?? (await readPiHeader(filePath))
        const cwd = header?.cwd ?? null
        if (header !== null && cwd !== null) nextHeaders[filePath] = header

        const worktreePath = cwd === null ? null : resolveOwningWorktree(cwd, worktreesInScope, ownerByCwd)
        if (worktreePath === null) {
          // Out of scope: some other project's session, or one whose header
          // this organ cannot read and therefore cannot attribute. Drop any
          // state a previous build recorded for it rather than leaving a lane
          // behind that nothing will ever refresh.
          delete nextFiles[filePath]
          continue
        }

        await tailPiFile(filePath, context, events, nextFiles, backfill, {
          worktreePath,
          role: knownWorktrees[worktreePath] ?? 'unattributed',
          sessionId: header?.sessionId ?? null,
        })
      }

      const lanes = await deriveLanes(nextFiles, prevSnapshot.lanes ?? {}, context.now, processProbe)

      return {
        nextSnapshot: { disabled: false, files: nextFiles, lanes, knownWorktrees, headers: nextHeaders },
        events,
      }
    },
  }
}

/**
 * The transcript-tail state machine, run over everything this poll tailed —
 * identical in shape to sessionlog's `deriveLanes`. The worktree-fold memory
 * that keeps a landed lane's transcript attributable past its worktree's
 * removal (#165) lives in `poll` above, as `knownWorktrees`: once the file
 * walk is scoped to watched worktrees (#609), a removed worktree would
 * otherwise take its own still-readable transcript out of scope with it.
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
    if (file.worktreePath !== null && file.worktreePath !== undefined && needsProcessProbe(shape.shape, quietMs)) {
      stalledWorktrees.push(file.worktreePath)
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
      processAlive:
        file.worktreePath === null || file.worktreePath === undefined
          ? null
          : (liveness.get(file.worktreePath) ?? null),
      lastSidechainTs: shape.lastSidechainTs,
    })
    if (reading === null) continue

    lanes[lane] = {
      ...reading,
      lane,
      worktreePath: file.worktreePath ?? null,
      sessionFile: filePath,
      derivedAt: now,
      previousState: previousLanes[lane]?.state ?? null,
    }
  }
  return lanes
}

/** What `poll` resolved about this session before deciding to tail it at all. */
interface PiSessionAttribution {
  /** The watched worktree containing this session's header `cwd`. Never the raw `cwd`. */
  worktreePath: string
  /** The role that worktree carries, remembered across its own removal (#165). */
  role: AgentRole
  /** The header's session id, when it had one. */
  sessionId: string | null
}

async function tailPiFile(
  filePath: string,
  context: CollectorContext,
  events: RhizomorphEvent[],
  nextFiles: Record<string, PiTailedFileState>,
  backfill: boolean,
  attribution: PiSessionAttribution,
): Promise<void> {
  const { worktreePath, role } = attribution
  const prevFile: PiTailedFileState = nextFiles[filePath] ?? {
    offset: await initialOffset(filePath, backfill),
    turnShape: initialTurnShape(),
    lastWriteTs: null,
    lane: null,
    worktreePath: null,
  }

  const { lines, nextOffset, lastWriteTs, identity } = await readNewLines(filePath, prevFile.offset, prevFile.identity)
  const rotated = isRotated(prevFile.identity, identity)
  let turnShape: TurnShapeState = rotated ? initialTurnShape() : prevFile.turnShape ?? initialTurnShape()
  let lane = rotated ? null : prevFile.lane ?? null

  // Mirrors sessionlog's own key exactly — the main working tree is where a
  // human drives the repo directly, so it is `unattributed` rather than a lane
  // of its own (#62), and a linked worktree keys on its basename. Matching it
  // is not cosmetic: the lane key is the join across collectors, so a pi lane
  // that spelled itself differently from the git/tmux/workmux reading of the
  // same worktree would simply never join.
  const laneForFile = role === 'unattributed' ? UNATTRIBUTED_LANE : basenameOf(worktreePath) ?? UNATTRIBUTED_LANE

  for (const rawLine of lines) {
    const entry = PI_JSONL_GRAMMAR.classify(rawLine)
    if (entry !== null) turnShape = advanceTurnShape(turnShape, entry)

    const facts = PI_JSONL_GRAMMAR.extractFacts(rawLine)
    if (!facts) continue

    lane = laneForFile
    const resolvedSessionId = attribution.sessionId ?? fallbackSessionId(filePath)
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
    lane: lane ?? laneForFile,
    worktreePath,
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

/**
 * The watched worktree a session's `cwd` belongs to, or `null` when it belongs
 * to none of them — the scope check of #609.
 *
 * **Longest match wins**, so a worktree nested inside another (git allows it)
 * claims its own sessions rather than losing them to its parent. `isInside`
 * canonicalizes both sides through the same `realpath`, which is what makes
 * this survive a symlinked worktree path and, on macOS, `/var` → `/private/var`
 * (#228) — a raw string prefix test would read a genuinely contained session as
 * an escape there and drop it.
 *
 * `isInside` can throw on a path whose ancestor denies `realpath` (EACCES, not
 * ENOENT). Out of scope is the safe answer for a directory this process cannot
 * even resolve: it declines to attribute, rather than guessing a lane.
 */
function resolveOwningWorktree(
  cwd: string,
  worktreesInScope: readonly string[],
  memo: Map<string, string | null>,
): string | null {
  const cached = memo.get(cwd)
  if (cached !== undefined) return cached

  let owner: string | null = null
  for (const candidate of worktreesInScope) {
    let contained: boolean
    try {
      contained = isInside(candidate, cwd)
    } catch {
      contained = false
    }
    if (contained && (owner === null || candidate.length > owner.length)) owner = candidate
  }

  memo.set(cwd, owner)
  return owner
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
