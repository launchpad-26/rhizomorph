import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  UNATTRIBUTED_LANE,
  type AgentRole,
  type Collector,
  type CollectorContext,
  type ObservatoryEvent,
  type PollResult,
} from '@observatory/core'
import { parseAssistantLine } from './parse-session-line.js'
import { parseWorktreePaths } from './parse-worktree-paths.js'
import { readNewLines } from './tail.js'
import type { SessionlogSnapshot, TailedFileState } from './types.js'
import { worktreePathToProjectSlug } from './worktree-slug.js'

const COLLECTOR_NAME = 'sessionlog'
const JSONL_SUFFIX = '.jsonl'

export interface SessionlogCollectorConfig {
  /**
   * Root of Claude Code's per-project session logs. Defaults to
   * `~/.claude/projects`. Tests point this at a fixture directory so they
   * never depend on (or pollute) the real one.
   */
  claudeProjectsRoot?: string
  /**
   * Extra session sources to tail as `role: 'conductor'`, each shaped
   * `<path>[:<lane>]` (`--extra-sessions`; CLI wiring is a separate issue).
   * `<path>` is tried two ways, dir-first:
   *
   * 1. **Directly**, as the session-log directory itself (contains
   *    `*.jsonl`) — no slug inference, no assumption about where the
   *    conductor's projects root lives or what OS it runs. This is the path
   *    that makes a Windows/foreign-filesystem conductor work at all: point
   *    it straight at the mounted session dir.
   * 2. **As a fallback**, if step 1 finds no `*.jsonl`: treated as a cwd and
   *    slug-inferred under `claudeProjectsRoot`, same as today (local
   *    conductor convenience).
   *
   * `<lane>` names the lane for every session under this dir. Left off, it
   * defaults to `conductor` for the first `--extra-sessions` (index 0), then
   * `conductor-2`, `conductor-3`… for the rest — never the raw project-dir
   * slug, and never inferred from the log content either (see
   * `defaultConductorLane`). A spec that resolves neither way emits one
   * `collector.error` instead of silently doing nothing.
   */
  extraSessionDirs?: readonly string[]
  /**
   * When a session file is seen for the very first time (no persisted offset
   * — including one rehydrated from a snapshot), read it from byte 0 instead
   * of seeking to its current end. Off by default: a fresh boot must start at
   * zero, not ingest every line a log has ever held. CLI flag wiring is a
   * separate issue.
   */
  backfill?: boolean
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
 * Tails `~/.claude/projects/<slug>/*.jsonl` for every worktree of the watched
 * repo (discovered the same way the git collector does, via
 * `git worktree list --porcelain`) plus any configured extra session dirs.
 * Assistant lines become `llm.usage` (once per `requestId`, since a single
 * reply can span several lines that all repeat the same usage block) and
 * `tool.activity` (one per `tool_use` content block). Missing or
 * undiscoverable session dirs never crash the poll loop — either the whole
 * collector disables itself once (no `~/.claude/projects` at all, or git
 * itself unusable), or a single worktree's project dir is treated as "no
 * session yet" and retried next poll.
 */
export function createSessionlogCollector(
  config: SessionlogCollectorConfig = {},
): Collector<SessionlogSnapshot> {
  const claudeProjectsRoot = config.claudeProjectsRoot ?? path.join(homedir(), '.claude', 'projects')
  const extraSessionDirs = config.extraSessionDirs ?? []
  const backfill = config.backfill ?? false

  return {
    name: COLLECTOR_NAME,

    initialSnapshot(): SessionlogSnapshot {
      return { disabled: false, files: {}, erroredExtraSessionDirs: {} }
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

      const events: ObservatoryEvent[] = []
      const nextErroredExtraSessionDirs: Record<string, true> = {}
      const extraWatchedDirs: WatchedDir[] = []

      const extraResolutions = await Promise.all(
        extraSessionDirs.map((spec, index) => resolveExtraSessionDir(spec, claudeProjectsRoot, index)),
      )
      for (const resolution of extraResolutions) {
        if (resolution.dir) {
          extraWatchedDirs.push(resolution.dir)
          continue
        }
        nextErroredExtraSessionDirs[resolution.spec] = true
        if (!prevSnapshot.erroredExtraSessionDirs[resolution.spec]) {
          events.push(context.emit('collector.error', { collector: COLLECTOR_NAME, message: resolution.reason }))
        }
      }

      // `git worktree list --porcelain` always lists the main working tree
      // first, then linked worktrees in the order they were added — a stable
      // ordering, not an assumption. Linked worktrees only exist because the
      // swarm made them, so `role: 'worker'` is correct there; the main tree
      // is where a human (or a conductor) drives the repo directly, so unless
      // the operator has declared it via `--extra-sessions` (kept exactly as
      // declared, never overridden here), it is `unattributed` — a setup gap
      // to fill in, never silently booked as worker spend (#62).
      const worktreePaths = parseWorktreePaths(worktreeListResult.stdout)
      const mainWorktreePath = worktreePaths[0]
      const declaredWorktreePaths = new Set(extraWatchedDirs.map((dir) => dir.worktreePath))

      const watchedDirs: WatchedDir[] = [
        ...worktreePaths
          .filter((worktreePath) => !declaredWorktreePaths.has(worktreePath))
          .map((worktreePath): WatchedDir =>
            worktreePath === mainWorktreePath
              ? { worktreePath, role: 'unattributed', laneOverride: UNATTRIBUTED_LANE }
              : { worktreePath, role: 'worker' },
          ),
        ...extraWatchedDirs,
      ]

      const nextFiles: Record<string, TailedFileState> = { ...prevSnapshot.files }

      for (const dir of watchedDirs) {
        await tailProjectDir(claudeProjectsRoot, dir, context, events, nextFiles, backfill)
      }

      return {
        nextSnapshot: { disabled: false, files: nextFiles, erroredExtraSessionDirs: nextErroredExtraSessionDirs },
        events,
      }
    },
  }
}

/** A parsed `<path>[:<lane>]` extra-sessions spec, before we know which resolution mode applies. */
interface ExtraSessionSpec {
  path: string
  lane: string | null
}

/**
 * Splits on the last `:` only when what follows looks like a lane name, not
 * a path fragment (no `/`) — real session dirs on this project are POSIX
 * paths with no colons, so this never fires on a bare path.
 */
function parseExtraSessionSpec(spec: string): ExtraSessionSpec {
  const separatorIndex = spec.lastIndexOf(':')
  if (separatorIndex === -1) return { path: spec, lane: null }

  const candidateLane = spec.slice(separatorIndex + 1)
  if (candidateLane.length === 0 || candidateLane.includes('/')) {
    return { path: spec, lane: null }
  }
  return { path: spec.slice(0, separatorIndex), lane: candidateLane }
}

type ExtraSessionResolution =
  | { spec: string; dir: WatchedDir; reason?: undefined }
  | { spec: string; dir: null; reason: string }

/**
 * Default lane for an `--extra-sessions` spec with no explicit `:<lane>`:
 * `conductor` for the first extra dir (index 0), `conductor-2`, `conductor-3`…
 * for the rest, keyed by the spec's position in `--extra-sessions` — never the
 * raw project-dir slug, and never inferred from the log content (gitBranch,
 * cwd) either. The dir path stays exactly what the operator passed; only the
 * presentation label defaults.
 */
function defaultConductorLane(index: number): string {
  return index === 0 ? 'conductor' : `conductor-${index + 1}`
}

/**
 * Resolves one `--extra-sessions` spec dir-first: tries `path` directly as a
 * session-log dir (contains `*.jsonl`), then falls back to slug-inferring it
 * as a cwd under `claudeProjectsRoot` (today's behaviour). Neither working
 * means the spec is a misconfiguration, not "no session yet" — that becomes
 * a `collector.error` at the call site rather than silence.
 */
async function resolveExtraSessionDir(
  spec: string,
  claudeProjectsRoot: string,
  index: number,
): Promise<ExtraSessionResolution> {
  const { path: rawPath, lane: explicitLane } = parseExtraSessionSpec(spec)
  const lane = explicitLane ?? defaultConductorLane(index)

  const directInfo = await statOrNull(rawPath)
  if (directInfo?.isDirectory()) {
    const entries = await readdir(rawPath).catch(() => [] as string[])
    if (entries.some((name) => name.endsWith(JSONL_SUFFIX))) {
      return {
        spec,
        dir: {
          worktreePath: rawPath,
          role: 'conductor',
          sessionDirOverride: rawPath,
          laneOverride: lane,
        },
      }
    }
  }

  const fallbackProjectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(rawPath))
  const fallbackInfo = await statOrNull(fallbackProjectDir)
  if (fallbackInfo?.isDirectory()) {
    return {
      spec,
      dir: { worktreePath: rawPath, role: 'conductor', laneOverride: lane },
    }
  }

  return {
    spec,
    dir: null,
    reason:
      `--extra-sessions "${rawPath}" is not a readable session directory: ` +
      `no *.jsonl found directly, and no project dir at ${fallbackProjectDir}`,
  }
}

async function tailProjectDir(
  claudeProjectsRoot: string,
  dir: WatchedDir,
  context: CollectorContext,
  events: ObservatoryEvent[],
  nextFiles: Record<string, TailedFileState>,
  backfill: boolean,
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
    const prevFile = nextFiles[filePath] ?? { offset: await initialOffset(filePath, backfill), lastUsageRequestId: null }

    const { lines, nextOffset } = await readNewLines(filePath, prevFile.offset)
    let lastUsageRequestId = prevFile.lastUsageRequestId

    for (const rawLine of lines) {
      const facts = parseAssistantLine(rawLine)
      if (!facts) continue

      const lane = dir.laneOverride ?? facts.gitBranch ?? basenameOf(facts.cwd ?? dir.worktreePath) ?? UNATTRIBUTED_LANE
      const sessionId = facts.sessionId ?? fallbackSessionId
      const emitOptions = facts.timestamp === null ? undefined : { ts: facts.timestamp }

      if (facts.requestId && facts.requestId !== lastUsageRequestId) {
        events.push(
          context.emit(
            'llm.usage',
            {
              lane,
              sessionId,
              worktreePath: dir.worktreePath,
              branch: facts.gitBranch,
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

      for (const tool of facts.toolUses) {
        events.push(
          context.emit(
            'tool.activity',
            {
              lane,
              sessionId,
              worktreePath: dir.worktreePath,
              branch: facts.gitBranch,
              tool,
              role: dir.role,
              durationMs: null,
            },
            emitOptions,
          ),
        )
      }
    }

    nextFiles[filePath] = { offset: nextOffset, lastUsageRequestId }
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
    nextSnapshot: { disabled: true, files: {}, erroredExtraSessionDirs: {} },
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
