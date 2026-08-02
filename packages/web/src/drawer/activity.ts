import type { AgentThread, RhizomorphEvent } from '@rhizomorph/core'
import type { Lane } from '../fleet/index.js'

/**
 * THE ACTIVITY FOLD (ruling 17) — what a lane has actually been *doing*, folded
 * out of its own events.
 *
 * This is the drawer's default reading, and the ordering is the ruling: a
 * transcript is for reading *after* the activity view has said something is
 * worth reading. Three kinds, and only three, because they are the three
 * questions an operator asks of a lane they just clicked — what is it calling,
 * what is it changing, and what has it finished:
 *
 * - **tool** — `tool.activity`, the session log's `tool_use` blocks;
 * - **file** — `worktree.dirty`, which is a *snapshot* of the uncommitted set,
 *   so the fold reports the transitions between snapshots rather than the
 *   snapshots themselves;
 * - **commit** — `commit.landed` on the lane's branch.
 *
 * Nothing is invented (ruling 32): every entry is one recorded fact or a run of
 * identical adjacent ones counted, never a synthesised summary. Adjacent
 * repeats of the same tool coalesce into `Read ×4` because forty identical
 * lines is how a real loop looks, and a reader must be able to see the shape of
 * it in one screen — the count *is* the evidence.
 */

export type ActivityKind = 'tool' | 'file' | 'commit'

interface EntryBase {
  /** Stable across rebuilds of the same log — React keys, and test anchors. */
  id: string
  ts: number
}

export interface ToolEntry extends EntryBase {
  kind: 'tool'
  tool: string
  /** Adjacent identical calls, coalesced. 1 unless the lane repeated itself. */
  count: number
  thread: AgentThread | null
}

export interface FileEntry extends EntryBase {
  kind: 'file'
  path: string
  /** The dirty-set status the collector reported: `modified`, `added`, … */
  status: string
}

export interface CommitEntry extends EntryBase {
  kind: 'commit'
  sha: string
  /** First line of the message — a ticker line, not a changelog. */
  subject: string
  fileCount: number
  insertions: number | null
  deletions: number | null
}

export type ActivityEntry = ToolEntry | FileEntry | CommitEntry

/** How many entries the view keeps. Newest wins; the drawer is a tail, not an archive. */
export const ACTIVITY_LIMIT = 200

/** The only part of a lane the fold needs — so a test can build one by hand. */
export type ActivityLane = Pick<Lane, 'id' | 'branch' | 'worktreePath' | 'handles'>

/**
 * Every name this lane answers to. A lane's id is its branch when git saw one
 * and its worktree path or handle when it did not, while the two telemetry
 * collectors may each have named it differently — so matching on the id alone
 * would empty the drawer for exactly the lanes that are hardest to attribute.
 */
function laneNames(lane: ActivityLane): Set<string> {
  const names = new Set<string>([lane.id, ...lane.handles])
  if (lane.branch !== null) names.add(lane.branch)
  return names
}

function payloadOf(event: RhizomorphEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>
}

function matchesLane(event: RhizomorphEvent, names: Set<string>, worktreePath: string | null): boolean {
  const payload = payloadOf(event)
  for (const key of ['lane', 'branch'] as const) {
    const value = payload[key]
    if (typeof value === 'string' && names.has(value)) return true
  }
  if (worktreePath === null) return false
  for (const key of ['worktreePath', 'path'] as const) {
    if (payload[key] === worktreePath) return true
  }
  return false
}

function firstLine(message: unknown): string {
  if (typeof message !== 'string') return ''
  return message.split('\n')[0] ?? ''
}

function asThread(value: unknown): AgentThread | null {
  return value === 'main' || value === 'subagent' || value === 'auxiliary' ? value : null
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

interface DirtyFile {
  path: string
  status: string
}

function dirtyFiles(payload: Record<string, unknown>): DirtyFile[] {
  if (!Array.isArray(payload.files)) return []
  return payload.files
    .map((file) => (typeof file === 'object' && file !== null ? (file as Record<string, unknown>) : null))
    .filter((file): file is Record<string, unknown> => file !== null)
    .filter((file) => typeof file.path === 'string')
    .map((file) => ({
      path: file.path as string,
      status: typeof file.status === 'string' ? file.status : 'changed',
    }))
}

export interface FoldActivityOptions {
  /** Cap on entries returned. Defaults to {@link ACTIVITY_LIMIT}. */
  limit?: number
}

/**
 * The lane's activity, **newest first**. Pure over the raw log — the same
 * events the fleet object was derived from, read a second way, never a second
 * derivation of the lane's *state*.
 */
export function foldActivity(
  events: readonly RhizomorphEvent[],
  lane: ActivityLane,
  options: FoldActivityOptions = {},
): ActivityEntry[] {
  const limit = options.limit ?? ACTIVITY_LIMIT
  const names = laneNames(lane)
  const entries: ActivityEntry[] = []

  // `worktree.dirty` replaces the whole set each time, so a transition is only
  // visible against the previous snapshot. Keyed by worktree path: one lane can
  // legitimately be reported by more than one path over a session.
  const previousDirty = new Map<string, Map<string, string>>()
  let lastTool: ToolEntry | null = null

  for (const event of events) {
    if (!matchesLane(event, names, lane.worktreePath)) continue
    const payload = payloadOf(event)

    if (event.type === 'tool.activity') {
      const tool = typeof payload.tool === 'string' ? payload.tool : null
      if (tool === null) continue
      const thread = asThread(payload.thread)
      if (lastTool !== null && lastTool.tool === tool && lastTool.thread === thread) {
        lastTool.count += 1
        lastTool.ts = event.ts
        continue
      }
      lastTool = { kind: 'tool', id: event.id, ts: event.ts, tool, count: 1, thread }
      entries.push(lastTool)
      continue
    }

    // Anything that isn't a tool call breaks the run: `Read ×4` must mean four
    // reads in a row, not four reads with a commit in the middle of them.
    lastTool = null

    if (event.type === 'worktree.dirty') {
      const key = typeof payload.path === 'string' ? payload.path : (lane.worktreePath ?? lane.id)
      const before = previousDirty.get(key) ?? new Map<string, string>()
      const after = new Map<string, string>()
      for (const file of dirtyFiles(payload)) {
        after.set(file.path, file.status)
        if (before.get(file.path) === file.status) continue
        entries.push({
          kind: 'file',
          id: `${event.id}:${file.path}`,
          ts: event.ts,
          path: file.path,
          status: file.status,
        })
      }
      previousDirty.set(key, after)
      continue
    }

    if (event.type === 'commit.landed') {
      const sha = typeof payload.sha === 'string' ? payload.sha : null
      if (sha === null) continue
      entries.push({
        kind: 'commit',
        id: event.id,
        ts: event.ts,
        sha,
        subject: firstLine(payload.message),
        fileCount: Array.isArray(payload.files) ? payload.files.length : 0,
        insertions: asCount(payload.insertions),
        deletions: asCount(payload.deletions),
      })
    }
  }

  return entries.reverse().slice(0, limit)
}

/** Counts by kind, for the view's `12 tools · 3 files · 1 commit` header. */
export function activityCounts(entries: readonly ActivityEntry[]): Record<ActivityKind, number> {
  const counts: Record<ActivityKind, number> = { tool: 0, file: 0, commit: 0 }
  for (const entry of entries) counts[entry.kind] += 1
  return counts
}
