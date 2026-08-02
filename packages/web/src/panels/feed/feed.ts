import {
  isEventOfType,
  selectRecentCommits,
  type AgentStatus,
  type CommitRecord,
  type RhizomorphEvent,
  type SessionState,
} from '@rhizomorph/core'
import type { Lane } from '../../fleet/buildFleet.js'

/**
 * THE ACTIVITY FEED's fold (ruling 15) — the commit ticker's one kind grows
 * into four: commits, landings (a worktree removed — the lane landed and
 * folded), lane starts/stops (`agent.status`) and collector events. Every kind
 * reads facts core already recorded; nothing here is a new derivation of "is
 * this lane in trouble" — that stays `buildFleet`'s job.
 */

export type FeedKind = 'commit' | 'landing' | 'lane' | 'collector'

export const FEED_KINDS: readonly FeedKind[] = ['commit', 'landing', 'lane', 'collector']

export const FEED_KIND_LABEL: Record<FeedKind, string> = {
  commit: 'Commits',
  landing: 'Landings',
  lane: 'Lanes',
  collector: 'Collectors',
}

/** How many entries the feed keeps on screen, newest first (the bounded window). */
export const FEED_LIMIT = 30

/**
 * How many recent commits to pull from the fold before merging with the other
 * three kinds. Generous relative to `FEED_LIMIT`: a session with many commits
 * on one lane and a quiet everything-else must not starve the merge before
 * filtering gets a chance to narrow it.
 */
const COMMIT_POOL = 300

interface FeedEntryBase {
  /** Stable across re-renders, so React never remounts (and re-pulses) a row. */
  id: string
  ts: number
  laneId: string | null
  /**
   * True when this entry's fact happened after the feed connected — the
   * news-vs-history tag `streamState.ts` already computes for the whole
   * stream. History builds the feed and lights nothing (ruling 32); only a
   * `news` entry is allowed to pulse once on arrival.
   */
  news: boolean
}

export interface CommitFeedEntry extends FeedEntryBase {
  kind: 'commit'
  commit: CommitRecord
}

export interface LandingFeedEntry extends FeedEntryBase {
  kind: 'landing'
  label: string
  branch: string | null
  path: string
}

export interface LaneFeedEntry extends FeedEntryBase {
  kind: 'lane'
  handle: string
  status: AgentStatus
  branch: string | null
  detail: string | null
}

export interface CollectorFeedEntry extends FeedEntryBase {
  kind: 'collector'
  collector: string
  state: 'disabled' | 'error'
  message: string | null
}

export type FeedEntry = CommitFeedEntry | LandingFeedEntry | LaneFeedEntry | CollectorFeedEntry

/**
 * branch / worktree path / handle → the `Lane.id` `buildFleet` resolved it to.
 * Built once from the one derived fleet object so the feed's lane filter
 * points at exactly the lane the fleet table and the scene would highlight —
 * never a re-derivation of "which lane is this" from the raw event alone.
 */
export interface LaneIndex {
  byBranch: ReadonlyMap<string, string>
  byWorktree: ReadonlyMap<string, string>
  byHandle: ReadonlyMap<string, string>
}

export function buildLaneIndex(lanes: readonly Lane[]): LaneIndex {
  const byBranch = new Map<string, string>()
  const byWorktree = new Map<string, string>()
  const byHandle = new Map<string, string>()
  for (const lane of lanes) {
    if (lane.branch !== null) byBranch.set(lane.branch, lane.id)
    if (lane.worktreePath !== null) byWorktree.set(lane.worktreePath, lane.id)
    for (const handle of lane.handles) byHandle.set(handle, lane.id)
  }
  return { byBranch, byWorktree, byHandle }
}

/** The first candidate (branch, path or handle) that resolves to a known lane. */
function resolveLane(
  index: LaneIndex,
  candidates: readonly (string | null | undefined)[],
): string | null {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue
    const id = index.byBranch.get(candidate) ?? index.byWorktree.get(candidate) ?? index.byHandle.get(candidate)
    if (id !== undefined) return id
  }
  return null
}

/**
 * Mirrors `app/streamState.ts`'s `isNews` exactly (`ts >= connectedAt -
 * graceMs`), against a plain timestamp rather than an `RhizomorphEvent` — a
 * folded `CommitRecord` keeps its first-sighting `landedAt` but not the event
 * object that produced it, so entries built from the fold and entries built
 * from raw events share this one predicate instead of two.
 */
function isRecent(ts: number, connectedAt: number, graceMs: number): boolean {
  return ts >= connectedAt - graceMs
}

export interface BuildFeedOptions {
  /** When this feed's stream connected — the news/history boundary. */
  connectedAt: number
  /** How stale a fact may be and still count as news. Pass `NEWS_GRACE_MS`. */
  newsGraceMs: number
}

/**
 * Every entry the log supports, newest first, unfiltered and unbounded. The
 * caller filters by kind/lane and only then takes the top `FEED_LIMIT` — the
 * window is measured on what survives the filter, not before it, so a lane
 * filter still fills the panel rather than mostly emptying it.
 */
export function buildFeedEntries(
  events: readonly RhizomorphEvent[],
  session: SessionState,
  laneIndex: LaneIndex,
  options: BuildFeedOptions,
): FeedEntry[] {
  const { connectedAt, newsGraceMs } = options

  const commitEntries: CommitFeedEntry[] = selectRecentCommits(session, COMMIT_POOL).map((commit) => ({
    id: `commit-${commit.sha}`,
    ts: commit.landedAt,
    kind: 'commit',
    laneId: resolveLane(laneIndex, commit.branches),
    news: isRecent(commit.landedAt, connectedAt, newsGraceMs),
    commit,
  }))

  const landingEntries: LandingFeedEntry[] = []
  const laneEntries: LaneFeedEntry[] = []
  const collectorEntries: CollectorFeedEntry[] = []

  for (const event of events) {
    if (isEventOfType(event, 'worktree.removed')) {
      // A removed *main* worktree is not a lane landing — it never was one.
      const worktree = session.worktrees[event.payload.path]
      if (worktree?.isMain === true) continue
      landingEntries.push({
        id: `landing-${event.id}`,
        ts: event.ts,
        kind: 'landing',
        laneId: resolveLane(laneIndex, [worktree?.branch ?? null, event.payload.path]),
        news: isRecent(event.ts, connectedAt, newsGraceMs),
        label: worktree?.branch ?? worktree?.name ?? event.payload.path,
        branch: worktree?.branch ?? null,
        path: event.payload.path,
      })
    } else if (isEventOfType(event, 'agent.status')) {
      const { handle, status, branch, detail } = event.payload
      laneEntries.push({
        id: `lane-${event.id}`,
        ts: event.ts,
        kind: 'lane',
        laneId: resolveLane(laneIndex, [handle, branch ?? null]),
        news: isRecent(event.ts, connectedAt, newsGraceMs),
        handle,
        status,
        branch: branch ?? null,
        detail: detail ?? null,
      })
    } else if (isEventOfType(event, 'collector.disabled')) {
      collectorEntries.push({
        id: `collector-${event.id}`,
        ts: event.ts,
        kind: 'collector',
        laneId: null,
        news: isRecent(event.ts, connectedAt, newsGraceMs),
        collector: event.payload.collector,
        state: 'disabled',
        message: event.payload.reason,
      })
    } else if (isEventOfType(event, 'collector.error')) {
      collectorEntries.push({
        id: `collector-${event.id}`,
        ts: event.ts,
        kind: 'collector',
        laneId: null,
        news: isRecent(event.ts, connectedAt, newsGraceMs),
        collector: event.payload.collector,
        state: 'error',
        message: event.payload.message,
      })
    }
  }

  return [...commitEntries, ...landingEntries, ...laneEntries, ...collectorEntries].sort(
    (a, b) => b.ts - a.ts || a.id.localeCompare(b.id),
  )
}

/** By kind, and — when a lane is selected — to that lane alone. */
export function filterFeedEntries(
  entries: readonly FeedEntry[],
  activeKinds: ReadonlySet<FeedKind>,
  selectedLaneId: string | null,
): FeedEntry[] {
  return entries.filter((entry) => {
    if (!activeKinds.has(entry.kind)) return false
    if (selectedLaneId !== null && entry.laneId !== selectedLaneId) return false
    return true
  })
}
