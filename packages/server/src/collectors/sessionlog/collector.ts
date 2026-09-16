import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  type AdapterCapabilities,
  type AgentRole,
  type AgentThread,
  type Collector,
  type CollectorContext,
  createEvent,
  type PollResult,
  type RhizomorphEvent,
  UNATTRIBUTED_LANE,
} from '@rhizomorph/core'
import { USER_LEVEL_SESSION_LOGS } from '../../harness-roster.js'
import {
  agentStatusEmissionFor,
  deriveLaneState,
  type LaneStateReading,
  needsProcessProbe,
  quietMsOf,
} from './lane-state.js'
import { parseWorktreePaths } from './parse-worktree-paths.js'
import { defaultProcessProbe, type ProcessLiveness, type ProcessProbe } from './process-probe.js'
import { isRotated, readNewLines } from './tail.js'
import type { TurnGrammar } from './turn-grammar.js'
import { CLAUDE_JSONL_GRAMMAR } from './turn-grammar-claude.js'
import { advanceTurnShape, initialTurnShape, type TurnShapeState } from './turn-shape.js'
import type { LaneLiveness, SessionlogSnapshot, TailedFileState } from './types.js'
import { worktreePathToProjectSlug } from './worktree-slug.js'

/**
 * The lane a remembered conductor comes back as — derived from the roster's own
 * `claude` entry rather than spelled a second time, so the discovered lane and
 * the remembered one cannot drift apart.
 */
const CONDUCTOR_LANE = USER_LEVEL_SESSION_LOGS.find((d) => d.id === 'claude')?.lane ?? 'conductor'

const COLLECTOR_NAME = 'sessionlog'
const JSONL_SUFFIX = '.jsonl'

/**
 * prd15 ruling 5's L0 ceiling: the transcript organ is the richest
 * zero-cooperation source there is — structural identity, a live four-state
 * liveness read (`lane-state.ts`), and a full per-message activity+usage
 * timeline. Attention is `partial`, not `provided`, on purpose: the organ
 * *infers* waiting/frozen/gone from turn shape (this is the exact example
 * the prd15 direction names — "inferred from transcript shape; a hook
 * beacon declares it (#282)"). Since #281 (ADR-0037) the organ does publish
 * its working/waiting transitions as `agent.status` signed
 * `source: 'sessionlog'` — edge-triggered, frozen and gone withheld
 * (`agentStatusEmissionFor`). `attention` stays `partial`: a published
 * inference is still an inference. prd-27 w4 (#218) set the remedy these
 * strings carry — it names the emitter that now exists rather than a beacon
 * that "would" declare it. Cost
 * stays `absent` — tokens only, never dollars, until OTLP env is wired in
 * (L1).
 */
export const SESSIONLOG_CAPABILITIES: AdapterCapabilities = {
  identity: { level: 'provided' },
  liveness: { level: 'provided' },
  activity: { level: 'provided' },
  attention: {
    level: 'partial',
    reason: 'inferred from transcript shape via the turn-shape state machine, not declared by the CLI',
    remedy:
      'install the Claude Code hooks — `rhizomorph env <lane> --hooks claude` — so the harness declares it (prd-27 ruling 3)',
  },
  telemetry: { level: 'provided' },
  cost: {
    level: 'absent',
    reason: 'the transcript carries tokens, never dollars',
    remedy: 'env vars at launch (`rhizomorph env <lane>`) bring OTLP dollars for CLIs that report cost',
  },
}

export interface SessionlogCollectorConfig {
  /**
   * Root of Claude Code's per-project session logs. Defaults to
   * `~/.claude/projects`. Tests point this at a fixture directory so they
   * never depend on (or pollute) the real one.
   */
  claudeProjectsRoot?: string
  /**
   * The user's home, for per-dialect session-log discovery — prd-57 ruling 8.
   *
   * Injectable so a test can point the whole mechanism at a temp directory
   * without mocking `os.homedir()`. Defaults to the real one.
   */
  home?: string
  /**
   * When a session file is seen for the very first time (no persisted offset
   * — including one rehydrated from a snapshot), read it from byte 0 instead
   * of seeking to its current end. Off by default: a fresh boot must start at
   * zero, not ingest every line a log has ever held. CLI flag wiring is a
   * separate issue.
   */
  backfill?: boolean
  /**
   * Process-aliveness probe for the transcript-tail state machine (prd15
   * ruling 1 input (c)). Defaults to `/proc` on Linux and WSL2 and to an
   * honest "unknown" everywhere else; tests inject a stub so the tmuxless boot
   * can be proven without any real process. Consulted only for lanes whose
   * transcript has already stalled — a healthy fleet costs zero probes.
   */
  processProbe?: ProcessProbe
  /**
   * Which CLI dialect these transcripts are written in. Claude's JSONL today;
   * codex and pi are later prd15 waves and land as new {@link TurnGrammar}
   * implementations, not as changes to the organ.
   */
  turnGrammar?: TurnGrammar
}

interface WatchedDir {
  worktreePath: string
  role: AgentRole
  /** Set only for a dir-first extra session dir: tail this dir literally, skipping slug inference. */
  sessionDirOverride?: string
  /** Set for extra session dirs: wins over any lane inferred from the JSONL content. */
  laneOverride?: string
}

/**
 * Tails `~/.claude/projects/<slug>/*.jsonl` for every worktree the watched
 * repo has ever had (discovered live the same way the git collector does,
 * via `git worktree list --porcelain`, **and** remembered past a worktree's
 * removal — #165) plus any configured extra session dirs. `git worktree
 * list` only answers "what exists now"; a lane's worktree is gone the moment
 * it lands and folds, which is exactly when its transcript is most wanted,
 * so the slug set is the union of what git reports live this poll and every
 * worktree path this collector has ever seen (`snapshot.knownWorktrees`),
 * not the live list alone. Assistant lines become `llm.usage` (once per
 * `requestId`, since a single reply can span several lines that all repeat
 * the same usage block) and `tool.activity` (one per `tool_use` content
 * block). Missing or undiscoverable session dirs never crash the poll loop —
 * either the whole collector disables itself once (no `~/.claude/projects`
 * at all, or git itself unusable), or a single worktree's project dir is
 * treated as "no session yet" and retried next poll.
 */
export function createSessionlogCollector(
  config: SessionlogCollectorConfig = {},
): Collector<SessionlogSnapshot> {
  const claudeProjectsRoot = config.claudeProjectsRoot ?? path.join(homedir(), '.claude', 'projects')
  const home = config.home ?? homedir()
  const backfill = config.backfill ?? false
  const processProbe = config.processProbe ?? defaultProcessProbe()
  const turnGrammar = config.turnGrammar ?? CLAUDE_JSONL_GRAMMAR

  return {
    name: COLLECTOR_NAME,
    capabilities: SESSIONLOG_CAPABILITIES,

    initialSnapshot(): SessionlogSnapshot {
      return { disabled: false, files: {}, erroredExtraSessionDirs: {}, knownWorktrees: {}, lanes: {} }
    },

    async poll(prevSnapshot, context: CollectorContext): Promise<PollResult<SessionlogSnapshot>> {
      if (prevSnapshot.disabled) {
        return { nextSnapshot: prevSnapshot, events: [] }
      }

      const rootInfo = await statOrNull(claudeProjectsRoot)
      if (!rootInfo?.isDirectory()) {
        return disable(context, `no Claude Code session log directory at ${claudeProjectsRoot}`)
      }

      const worktreeListResult = await context.exec('git', ['worktree', 'list', '--porcelain'], {
        cwd: context.repoPath,
      })
      if (worktreeListResult.failed) {
        return disable(
          context,
          worktreeListResult.errorMessage ?? 'git worktree list --porcelain failed',
        )
      }

      const events: RhizomorphEvent[] = []
      const nextErroredExtraSessionDirs: Record<string, true> = {}
      const extraWatchedDirs: WatchedDir[] = []

      // PER-DIALECT DISCOVERY — prd-57 ruling 8, in place of `--extra-sessions`.
      //
      // Deferred until the main worktree is known, a few lines below: the whole
      // of what this replaces is "the main tree is my conductor", and the main
      // tree is what `git worktree list --porcelain` names first.

      // `git worktree list --porcelain` always lists the main working tree
      // first, then linked worktrees in the order they were added — a stable
      // ordering, not an assumption. Linked worktrees only exist because the
      // swarm made them, so `role: 'worker'` is correct there.
      //
      // THE MAIN TREE IS THE CONDUCTOR'S, AND IT IS NOW DISCOVERED (prd-57
      // ruling 8). It used to be `unattributed` unless the operator declared it
      // with `--extra-sessions` — #62's ruling, and the right one: silently
      // booking a conductor's spend as worker spend is worse than an honest
      // gap. What changed is not that ruling but the alternative to it. The
      // gap existed because nothing could tell the instrument where a
      // conductor's transcript lived, and that was never a fact only the
      // operator knew — it is a fact about the DIALECT, which the roster now
      // states (`USER_LEVEL_SESSION_LOGS`).
      //
      // So the main tree is attributed `conductor` when a dialect's user-level
      // root actually holds a session directory for it, and stays
      // `unattributed` when none does. The honest gap survives for the case it
      // was written for — nothing discovered means nothing claimed — and stops
      // being the default for the case a flag existed to fix.
      const liveWorktreePaths = parseWorktreePaths(worktreeListResult.stdout)
      const mainWorktreePath = liveWorktreePaths[0]

      if (mainWorktreePath !== undefined) {
        for (const dialect of USER_LEVEL_SESSION_LOGS) {
          // ALWAYS from `home`, never from `claudeProjectsRoot`. The two
          // coincide in production — `claudeProjectsRoot` defaults to
          // `<home>/.claude/projects` — and they answer different questions,
          // which is why the special case that read the override here was
          // wrong. `claudeProjectsRoot` is where a transcript is READ from, an
          // override a test or a foreign mount may repoint. `home` is where the
          // DIALECT keeps its own sessions, which is what discovery asks about.
          // Collapsing them made "the main tree has a transcript" and "the
          // dialect declares this directory" the same fact, and they are not:
          // the first is true of any slug dir, the second is what licenses
          // calling its owner the conductor.
          const discovered = path.join(home, ...dialect.segments, worktreePathToProjectSlug(mainWorktreePath))
          const info = await statOrNull(discovered)
          if (!info?.isDirectory()) continue
          extraWatchedDirs.push({
            worktreePath: mainWorktreePath,
            role: 'conductor',
            sessionDirOverride: discovered,
            laneOverride: dialect.lane,
          })
        }
      }

      const declaredWorktreePaths = new Set(extraWatchedDirs.map((dir) => dir.worktreePath))

      const liveDiscoveredDirs: WatchedDir[] = liveWorktreePaths
        .filter((worktreePath) => !declaredWorktreePaths.has(worktreePath))
        .map((worktreePath): WatchedDir =>
          worktreePath === mainWorktreePath
            ? { worktreePath, role: 'unattributed', laneOverride: UNATTRIBUTED_LANE }
            : { worktreePath, role: 'worker' },
        )

      // The fold's own memory of every worktree it has ever discovered live,
      // updated with this poll's live set before it is used below — so a
      // worktree seen for the very first time this poll is already part of
      // its own "known" set, and one that just folded (present in
      // `prevSnapshot.knownWorktrees` but absent from `liveDiscoveredDirs`
      // this time) stays in it (#165).
      const knownWorktrees: Record<string, AgentRole> = { ...prevSnapshot.knownWorktrees }
      for (const dir of liveDiscoveredDirs) knownWorktrees[dir.worktreePath] = dir.role
      // The DISCOVERED conductor is remembered too — prd-57 ruling 8. It is not
      // in `liveDiscoveredDirs` (that set excludes every declared path), so
      // without this line a main tree that folds is forgotten entirely, where a
      // linked worker that folds is remembered. #165's whole claim is that a
      // folded worktree keeps its role; a conductor is not the exception to it.
      for (const dir of extraWatchedDirs) knownWorktrees[dir.worktreePath] = dir.role

      const liveDiscoveredPaths = new Set(liveDiscoveredDirs.map((dir) => dir.worktreePath))
      const foldedDirs: WatchedDir[] = Object.entries(knownWorktrees)
        .filter(([worktreePath]) => !liveDiscoveredPaths.has(worktreePath) && !declaredWorktreePaths.has(worktreePath))
        .map(([worktreePath, role]): WatchedDir => {
          // A remembered role brings its LANE back with it, for the two roles
          // whose lane is a property of the role rather than of the log's
          // content. `unattributed` always did; `conductor` now must, because a
          // discovered conductor's lane comes from the roster and a folded one
          // would otherwise fall back to whatever its transcript happens to
          // name (`main`, a branch, a directory) — the same leak #165 closed
          // for `unattributed`, one role over.
          if (role === 'unattributed') return { worktreePath, role, laneOverride: UNATTRIBUTED_LANE }
          if (role === 'conductor') return { worktreePath, role, laneOverride: CONDUCTOR_LANE }
          return { worktreePath, role }
        })

      const watchedDirs: WatchedDir[] = [...liveDiscoveredDirs, ...foldedDirs, ...extraWatchedDirs]

      const nextFiles: Record<string, TailedFileState> = { ...prevSnapshot.files }

      for (const dir of watchedDirs) {
        await tailProjectDir(claudeProjectsRoot, dir, context, events, nextFiles, backfill, turnGrammar)
      }

      const lanes = await deriveLanes(nextFiles, prevSnapshot.lanes ?? {}, context.now, processProbe)

      // prd-27 ruling 2 (#281, ADR-0037): the organ publishes its transitions
      // as `agent.status` signed with its own name. Edge-triggered through
      // `agentStatusEmissionFor` — a poll that changed nothing emits nothing,
      // and frozen/gone are withheld for the reasons that function states.
      // Sorted so two polls over the same snapshot emit in the same order.
      for (const lane of Object.keys(lanes).sort()) {
        const liveness = lanes[lane]
        if (liveness === undefined) continue
        // The main working tree's session is a setup gap, not a lane (#62);
        // minting an agent record for it would give the fleet a lane it
        // deliberately does not have.
        if (lane === UNATTRIBUTED_LANE) continue
        const emission = agentStatusEmissionFor({
          handle: lane,
          worktreePath: liveness.worktreePath,
          branch: liveness.branch,
          previous: liveness.previousState,
          reading: liveness,
        })
        if (emission === null) continue
        events.push(
          createEvent('agent.status', emission, {
            id: context.nextId(),
            ts: context.now,
            source: 'sessionlog',
          }),
        )
      }

      return {
        nextSnapshot: {
          disabled: false,
          files: nextFiles,
          erroredExtraSessionDirs: nextErroredExtraSessionDirs,
          knownWorktrees,
          lanes,
        },
        events,
      }
    },
  }
}

/**
 * The transcript-tail state machine, run over everything this poll tailed
 * (prd15 ruling 1). Pure apart from the one process probe, which is batched
 * into a single read and skipped entirely when no lane has stalled.
 *
 * **A lane's freshest transcript speaks for it.** A project dir accumulates
 * one `*.jsonl` per session, and a lane that has been resumed several times
 * has several — all but the newest describing a conversation that ended. The
 * most recently written file is the only one that can say anything about
 * *now*; ties break on path so the choice is deterministic under replay.
 */
async function deriveLanes(
  files: Readonly<Record<string, TailedFileState>>,
  previousLanes: Readonly<Record<string, LaneLiveness>>,
  now: number,
  processProbe: ProcessProbe,
): Promise<Record<string, LaneLiveness>> {
  const freshestByLane = new Map<string, { filePath: string; file: TailedFileState }>()
  for (const [filePath, file] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (file.lane === null || file.lane === undefined) continue
    const incumbent = freshestByLane.get(file.lane)
    if (incumbent === undefined || (file.lastWriteTs ?? 0) > (incumbent.file.lastWriteTs ?? 0)) {
      freshestByLane.set(file.lane, { filePath, file })
    }
  }

  // Only lanes already past their threshold can have their state changed by
  // the probe, so only those are asked about — the observer touches nothing
  // outside its own transcripts while the fleet is healthy.
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

  const lanes: Record<string, LaneLiveness> = {}
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
    // A transcript with no conversational entry has told us nothing. It gets
    // no lane reading at all rather than a fabricated one.
    if (reading === null) continue

    lanes[lane] = {
      ...reading,
      lane,
      worktreePath: file.worktreePath ?? null,
      branch: file.branch ?? null,
      sessionFile: filePath,
      derivedAt: now,
      previousState: previousLanes[lane]?.state ?? null,
    }
  }
  return lanes
}

async function tailProjectDir(
  claudeProjectsRoot: string,
  dir: WatchedDir,
  context: CollectorContext,
  events: RhizomorphEvent[],
  nextFiles: Record<string, TailedFileState>,
  backfill: boolean,
  turnGrammar: TurnGrammar,
): Promise<void> {
  const projectDir = dir.sessionDirOverride ?? path.join(claudeProjectsRoot, worktreePathToProjectSlug(dir.worktreePath))
  const projectInfo = await statOrNull(projectDir)
  if (!projectInfo?.isDirectory()) return // no session started here (yet) — not an error

  const entries = await readdir(projectDir).catch(() => [] as string[])
  const jsonlFiles = entries.filter((name) => name.endsWith(JSONL_SUFFIX))

  for (const fileName of jsonlFiles) {
    const filePath = path.join(projectDir, fileName)
    const fallbackSessionId = fileName.slice(0, -JSONL_SUFFIX.length)
    // Absent from nextFiles means genuinely unseen — either a brand-new file
    // this poll, or one never persisted before this process started. A file
    // whose offset was rehydrated from a snapshot is already present here
    // (copied in from prevSnapshot.files before this loop runs) and resumes
    // from it rather than re-triggering first-sight behaviour.
    const prevFile: TailedFileState = nextFiles[filePath] ?? {
      offset: await initialOffset(filePath, backfill),
      lastUsageRequestId: null,
      turnShape: initialTurnShape(),
      lastWriteTs: null,
      lane: null,
      worktreePath: dir.worktreePath,
      branch: null,
    }

    const { lines, nextOffset, lastWriteTs, identity } = await readNewLines(filePath, prevFile.offset, prevFile.identity)
    // A rotation replaces the file wholesale — none of the predecessor's fold
    // belongs to what's here now. Resuming it would fold the replacement's
    // first lines onto a stale mid-turn shape, let a coincidentally-repeated
    // requestId suppress the replacement's own usage block, and misattribute
    // its lane and branch until an assistant line happens to overwrite them.
    const rotated = isRotated(prevFile.identity, identity)
    let lastUsageRequestId = rotated ? null : prevFile.lastUsageRequestId
    // A snapshot persisted before the organ existed has no fold to resume, so
    // it starts one here. Its shape then only reflects lines appended from now
    // on, which is the same contract `offset` already gives every other reader
    // of this file — never a claim about bytes this process never saw.
    let turnShape: TurnShapeState = rotated ? initialTurnShape() : prevFile.turnShape ?? initialTurnShape()
    // Which lane this transcript belongs to, remembered on the file so a poll
    // that reads no new lines still knows whose liveness it is looking at.
    let fileLane = rotated ? null : prevFile.lane ?? null
    let fileBranch = rotated ? null : prevFile.branch ?? null

    for (const rawLine of lines) {
      // Input (a) of the state machine, folded over the very bytes the
      // telemetry readers below are already consuming — the organ costs this
      // collector no extra I/O at all.
      const entry = turnGrammar.classify(rawLine)
      if (entry !== null) turnShape = advanceTurnShape(turnShape, entry)

      const facts = turnGrammar.extractFacts(rawLine)
      if (!facts) continue

      const lane =
        dir.laneOverride ?? facts.gitBranch ?? basenameOf(facts.cwd ?? dir.worktreePath) ?? UNATTRIBUTED_LANE
      fileLane = lane
      fileBranch = facts.gitBranch
      const sessionId = facts.sessionId ?? fallbackSessionId
      const emitOptions = facts.timestamp === null ? undefined : { ts: facts.timestamp }
      const thread: AgentThread = facts.isSidechain ? 'subagent' : 'main'

      if (facts.requestId && facts.requestId !== lastUsageRequestId) {
        events.push(
          context.emit(
            'llm.usage',
            {
              lane,
              sessionId,
              worktreePath: dir.worktreePath,
              branch: facts.gitBranch,
              thread,
              role: dir.role,
              model: facts.model,
              tokens: facts.tokens,
              requestId: facts.requestId,
              durationMs: null,
            },
            emitOptions,
          ),
        )
        lastUsageRequestId = facts.requestId
      }

      for (const toolUse of facts.toolUses) {
        events.push(
          context.emit(
            'tool.activity',
            {
              lane,
              sessionId,
              worktreePath: dir.worktreePath,
              branch: facts.gitBranch,
              thread,
              tool: toolUse.tool,
              role: dir.role,
              durationMs: null,
              filePath: repoRelativeFilePath(toolUse.filePath, dir.worktreePath),
              toolUseId: toolUse.toolUseId,
            },
            emitOptions,
          ),
        )
      }
    }

    nextFiles[filePath] = {
      offset: nextOffset,
      lastUsageRequestId,
      turnShape,
      lastWriteTs,
      identity,
      // The organ needs a lane for every transcript it folded, including one
      // whose lines never reached `turnGrammar.extractFacts` (a turn made
      // entirely of user entries, or an assistant line with no usage block). Falling
      // back to the watched dir keeps such a transcript's liveness legible
      // instead of silently unattributed; the *events* above keep their own
      // stricter, line-derived attribution untouched.
      lane: fileLane ?? dir.laneOverride ?? basenameOf(dir.worktreePath) ?? UNATTRIBUTED_LANE,
      worktreePath: dir.worktreePath,
      branch: fileBranch,
    }
  }
}

/**
 * Where a never-before-seen file starts reading from: byte 0 when backfill is
 * requested (today's behaviour, opt-in), otherwise its current size — a fresh
 * boot emits nothing for history already on disk, only what's appended after.
 */
async function initialOffset(filePath: string, backfill: boolean): Promise<number> {
  if (backfill) return 0
  const info = await statOrNull(filePath)
  return info ? Number(info.size) : 0
}

function disable(context: CollectorContext, reason: string): PollResult<SessionlogSnapshot> {
  return {
    nextSnapshot: { disabled: true, files: {}, erroredExtraSessionDirs: {}, knownWorktrees: {}, lanes: {} },
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

function basenameOf(target: string): string | null {
  const base = path.basename(target)
  return base.length > 0 ? base : null
}

/**
 * Normalizes a tool_use's reported `file_path` to repo-relative when it sits
 * under the lane's own worktree — the common case, since Claude Code reports
 * absolute paths from the cwd it ran in. Anywhere else (a path outside the
 * worktree, a foreign-lane conductor path, a Windows path) is kept exactly as
 * reported: honest about what we don't know rather than a guessed rewrite.
 */
function repoRelativeFilePath(filePath: string | null, worktreePath: string): string | null {
  if (filePath === null) return null
  const relative = path.relative(worktreePath, filePath)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return filePath
  return relative
}
