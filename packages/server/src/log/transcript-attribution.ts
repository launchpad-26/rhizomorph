import path from 'node:path'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { transcriptCaptureDir, transcriptCaptureFileName } from './paths.js'

/**
 * WHO a lane's session log belongs to — shared between the live transcript
 * tail (`api/transcript.ts`, prd3 ruling 17) and transcript capture on close
 * (prd16 ruling 3). Neither reads a lane's transcript without first answering
 * this: which Claude Code session id, in which worktree, is the newest thing
 * the event log ever said about it.
 */

const JSONL_SUFFIX = '.jsonl'

/** Telemetry events carry the collector's own lane→session attribution. */
const ATTRIBUTED_TYPES = new Set(['llm.usage', 'tool.activity', 'llm.cost'])

export interface Attribution {
  sessionId: string
  worktreePath: string | null
}

/**
 * The `:lane` the conductor's own session answers to (prd6 ruling 5) — see
 * `api/transcript.ts` for the full rationale (`role: 'conductor'`, not a name).
 */
export const CONDUCTOR_LANE = 'main'

/**
 * The newest attribution the log carries for `lane`, or null when nothing in
 * the session ever named it. Matches on the payload's `lane` *or* its `branch`,
 * because a lane's id in the derived fleet is its branch when one is known —
 * so a drawer opened from the fleet table asks by branch, and the collector may
 * have recorded the handle.
 */
export function findLaneAttribution(
  events: readonly RhizomorphEvent[],
  lane: string,
): Attribution | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || !ATTRIBUTED_TYPES.has(event.type)) continue

    const payload = event.payload as {
      lane?: unknown
      branch?: unknown
      sessionId?: unknown
      worktreePath?: unknown
    }
    if (payload.lane !== lane && payload.branch !== lane) continue
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) continue

    return {
      sessionId: payload.sessionId,
      worktreePath: typeof payload.worktreePath === 'string' ? payload.worktreePath : null,
    }
  }
  return null
}

/**
 * The newest attribution the log carries for the **conductor**, whatever handle
 * the operator gave it. See `api/transcript.ts`'s `findConductorAttribution`
 * doc for the full rationale (role, not name).
 */
export function findConductorAttribution(events: readonly RhizomorphEvent[]): Attribution | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || !ATTRIBUTED_TYPES.has(event.type)) continue

    const payload = event.payload as {
      role?: unknown
      sessionId?: unknown
      worktreePath?: unknown
    }
    if (payload.role !== 'conductor') continue
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) continue

    return {
      sessionId: payload.sessionId,
      worktreePath: typeof payload.worktreePath === 'string' ? payload.worktreePath : null,
    }
  }
  return null
}

/**
 * Every lane (including the conductor, as {@link CONDUCTOR_LANE}) the event log
 * ever attributed to a real session id — what transcript capture on close
 * (prd16 ruling 3) walks, so it captures exactly the lanes a reader could ever
 * ask this session's transcript route about, and nothing it invented.
 */
export function allAttributedLanes(
  events: readonly RhizomorphEvent[],
): Array<{ lane: string; attribution: Attribution }> {
  const lanes = new Set<string>()
  for (const event of events) {
    if (!ATTRIBUTED_TYPES.has(event.type)) continue
    const payload = event.payload as { lane?: unknown; branch?: unknown; role?: unknown }
    if (payload.role === 'conductor') {
      lanes.add(CONDUCTOR_LANE)
      continue
    }
    if (typeof payload.lane === 'string') lanes.add(payload.lane)
    else if (typeof payload.branch === 'string') lanes.add(payload.branch)
  }

  const result: Array<{ lane: string; attribution: Attribution }> = []
  for (const lane of lanes) {
    const attribution =
      lane === CONDUCTOR_LANE
        ? (findConductorAttribution(events) ?? findLaneAttribution(events, lane))
        : findLaneAttribution(events, lane)
    if (attribution !== null) result.push({ lane, attribution })
  }
  return result
}

/**
 * The one shape check standing between a `sessionId` — off the wire, or off a
 * log a less-trusted source could have written; the core schema
 * (`events/telemetry.ts:113`) validates it as `nonEmptyString` only, no
 * format constraint — and a filesystem path built from it. A session id is
 * always a bare filename, never a path: `path.basename` must return exactly
 * what went in, which rejects any `/`, any `..` segment, and any absolute
 * path in one check. A NUL byte is invisible to `path.basename` (it is not a
 * separator), so it is refused explicitly.
 */
export function isSafeSessionId(sessionId: string): boolean {
  return !sessionId.includes('\0') && path.basename(sessionId) === sessionId
}

/**
 * The second gate, independent of {@link isSafeSessionId}: a candidate must
 * resolve to somewhere inside the root it was joined onto, not merely have
 * been built from a filename that looked safe. Catches anything the shape
 * check did not anticipate rather than trusting construction alone — the
 * audit's ask was both checks, not either.
 */
export function isPathContained(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep)
}

/**
 * Every place a lane's session file could be LIVE, in preference order — the
 * same two the collector itself tails: the slug-inferred project dir under
 * `~/.claude/projects`, and (for an `--extra-sessions` dir passed directly) the
 * declared directory itself.
 *
 * Refuses the shape of `attribution.sessionId` (via {@link isSafeSessionId})
 * before any path is built, and re-checks each built path stays under its own
 * root (via {@link isPathContained}) before offering it — the traversal guard
 * lives here, once, rather than in the reader that opens whatever this hands
 * back.
 */
export function candidateTranscriptPaths(
  attribution: Attribution,
  claudeProjectsRoot: string,
): string[] {
  if (attribution.worktreePath === null) return []
  if (!isSafeSessionId(attribution.sessionId)) return []

  const fileName = `${attribution.sessionId}${JSONL_SUFFIX}`
  const projectPath = path.join(
    claudeProjectsRoot,
    worktreePathToProjectSlug(attribution.worktreePath),
    fileName,
  )
  const worktreeSessionPath = path.join(attribution.worktreePath, fileName)

  return [
    isPathContained(claudeProjectsRoot, projectPath) ? projectPath : null,
    isPathContained(attribution.worktreePath, worktreeSessionPath) ? worktreeSessionPath : null,
  ].filter((candidate): candidate is string => candidate !== null)
}

/**
 * Where a lane's transcript would be if it was CAPTURED on close (prd16
 * ruling 3) — `recordingSessionId` is this instrument's own session id (the
 * one being closed or replayed), never Claude Code's. Both ids pass through
 * {@link isSafeSessionId} before anything is joined, and the result is
 * re-checked with {@link isPathContained} — the same double gate
 * {@link candidateTranscriptPaths} applies to the live paths, applied here to
 * the one path capture ever reads or writes.
 */
export function capturedTranscriptPath(
  sessionDir: string,
  recordingSessionId: string,
  attribution: Attribution,
): string | null {
  if (!isSafeSessionId(recordingSessionId)) return null
  if (!isSafeSessionId(attribution.sessionId)) return null

  const dir = transcriptCaptureDir(sessionDir, recordingSessionId)
  const filePath = path.join(dir, transcriptCaptureFileName(attribution.sessionId))
  return isPathContained(sessionDir, filePath) ? filePath : null
}
