import {
  initialSessionState,
  reduce,
  reduceAll,
  type RhizomorphEvent,
  type SessionState,
} from '@rhizomorph/core'

/**
 * True when `events` is already sorted ascending by `ts` — the shape the
 * server serves a session's history in. An O(n) scan, but cheap next to a
 * sort, and it lets {@link sortEvents} skip allocating a copy in the common
 * case where the log is already `ts`-ascending.
 */
export function isSorted(events: readonly RhizomorphEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.ts < events[i - 1]!.ts) return false
  }
  return true
}

/**
 * A `ts`-ascending COPY of `events` — for time NAVIGATION only, never for
 * folding.
 *
 * **prd17 ruling 3.4 (#205): a record's own append order is the truth.**
 * `docs/record-format.md` says so directly, and `reduce.test.ts`'s fold-order
 * law pins why it matters: a real log can be non-monotonic in `ts` (a tailed
 * line can be older than the line above it, exactly what era-1's own capture
 * does), the reducer is order-sensitive (last-write-wins `agent.status`,
 * create-vs-delete on `branches`, first-sighting `commitOrder`), so re-sorting
 * a log before folding it does not just re-address time — it silently picks a
 * *different* answer to "what is the state at this point," diverging from the
 * live dashboard's own arrival-order fold of the very same log.
 *
 * Nothing that folds — {@link buildSessionIndex}, {@link foldFrom},
 * {@link foldUpTo} — ever calls this to decide what order to `reduce` events
 * in; each of them walks the log's own order, always. This function exists
 * only so a scrub position can be turned into a *count* of events at or
 * before it ({@link boundaryIndex}/{@link lowerBoundaryIndex}) — a count is
 * the same number regardless of which order those events get folded in, so
 * handing it to a fold as a prefix LENGTH (never as a re-ordering) is what
 * lets the scrubber address time without the fold ever sorting its input.
 */
export function sortEvents(events: readonly RhizomorphEvent[]): RhizomorphEvent[] {
  if (isSorted(events)) return events as RhizomorphEvent[]
  return [...events].sort((a, b) => a.ts - b.ts)
}

/**
 * The index of the first event with `ts > T` in a `ts`-ascending array — i.e.
 * the count of events at or before `T`. Binary search, `O(log n)`, replacing
 * the full `filter` a scrub used to pay on every tick (#160).
 *
 * The array must already be `ts`-ascending — pass it {@link sortEvents}'
 * output (or a `SessionIndex.sortedEvents`), never a fold's own append-order
 * `events`. The count this returns is a navigation offset, not a claim about
 * which specific events precede `T` in any particular fold.
 */
export function boundaryIndex(events: readonly RhizomorphEvent[], ts: number): number {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (events[mid]!.ts <= ts) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The index of the first event with `ts >= T` in a `ts`-ascending array —
 * {@link boundaryIndex}'s sibling for a threshold that events cross rather
 * than a scrub prefix that ends: replay's news/history split (`StreamContext`,
 * #162) sits at a single fixed `ts`, so which events are "news" is this
 * boundary intersected with a scrub prefix, not something that needs folding
 * per tick to answer. Same precondition as {@link boundaryIndex}: a
 * `ts`-ascending array, for navigation, never a fold's own order.
 */
export function lowerBoundaryIndex(events: readonly RhizomorphEvent[], ts: number): number {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (events[mid]!.ts < ts) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The events at or before scrub time T, in the order `events` was given.
 * `StreamContext` uses this directly to serve panels the same raw-event shape
 * they read live.
 * Precondition: `events` is already `ts`-ascending (pass it {@link sortEvents}'
 * output, e.g. a `SessionIndex.sortedEvents` — never a fold's own append-order
 * array, whose order this function does not touch but also does not correct).
 */
export function eventsUpTo(
  events: readonly RhizomorphEvent[],
  ts: number,
): RhizomorphEvent[] {
  return events.slice(0, boundaryIndex(events, ts))
}

/**
 * State at scrub time T, folding events in exactly the order `events` holds
 * them — the reference implementation. Correct at any log size, but `O(n)`
 * per call, so `useReplaySession` uses this only as the oracle incremental
 * folding (`foldFrom`) is tested against, never as the hot path (#160).
 *
 * **Folds append order, always (#205).** The `ts`-sorted copy below exists
 * only to compute *how many* leading events of `events` fall at or before
 * `T` — a count, not a re-ordering — and that count is then sliced straight
 * off `events` in the order it was given and reduced in that same order.
 * A genuinely non-monotonic log therefore folds exactly as recorded, never
 * as if it had been re-sorted first.
 */
export function foldUpTo(events: readonly RhizomorphEvent[], ts: number): SessionState {
  const target = boundaryIndex(sortEvents(events), ts)
  return reduceAll(events.slice(0, target))
}

/** A `SessionState` pinned to a known position in a session's own event order. */
export interface FoldCursor {
  /** Count of events folded to reach `state` — an index into a `SessionIndex`'s `events`. */
  index: number
  state: SessionState
}

/** A cursor at the very start of any log, before its first event. */
export function initialFoldCursor(): FoldCursor {
  return { index: 0, state: initialSessionState() }
}

/**
 * Every `keyframeInterval`-th cursor, `keyframes[0]` always the empty one at
 * index 0.
 */
export interface SessionIndex {
  /**
   * The record's own order — exactly what every fold below walks, unreordered
   * (#205: append order is the truth). `keyframes[i].index` and `foldFrom`'s
   * cursor `index` both count positions into this array, never into
   * `sortedEvents`.
   */
  events: readonly RhizomorphEvent[]
  /**
   * A `ts`-ascending COPY of `events`, built once beside the fold — a
   * navigation structure only ({@link sortEvents}). `foldFrom` reads this to
   * translate a scrub `ts` into a count of events at or before it; it never
   * reads this to decide what order to reduce. Exposed to consumers (via
   * `useReplaySession`'s `scrubEvents`) that need a `ts`-ascending view of
   * their own — `StreamContext`'s news/history boundary
   * ({@link lowerBoundaryIndex}) — so the whole app shares one sorted copy
   * rather than each caller sorting again.
   */
  sortedEvents: readonly RhizomorphEvent[]
  keyframes: readonly FoldCursor[]
  keyframeInterval: number
}

/**
 * Keyframes let a backward scrub avoid re-folding from event zero: restore
 * the nearest keyframe at or before the target and fold forward only the
 * remainder (#160 layer 3). 500 is picked from the timings in the #160
 * summary — at that spacing a worst-case backward scrub on a 25k-event
 * session folds at most 500 events (sub-millisecond), and the session holds
 * at most 50 snapshots, each a shallow `SessionState` (its nested maps are
 * structurally shared with neighbouring keyframes, since `reduce` only
 * replaces the branches an event actually touches) — memory that stays
 * negligible next to the event log itself.
 */
export const DEFAULT_KEYFRAME_INTERVAL = 500

/**
 * Builds the navigation index once per session load (the "once per session
 * load" work #160 calls for) — and folds the keyframes in `events`' own
 * order, never a `ts`-sorted one (#205). Everything downstream (`foldFrom`)
 * is `O(log n)` plus the events actually crossed, and every event it crosses
 * is crossed in the log's own order regardless of which keyframe it started
 * from.
 */
export function buildSessionIndex(
  events: readonly RhizomorphEvent[],
  keyframeInterval = DEFAULT_KEYFRAME_INTERVAL,
): SessionIndex {
  const sortedEvents = sortEvents(events)
  const keyframes: FoldCursor[] = [initialFoldCursor()]
  let state = initialSessionState()
  for (let i = 0; i < events.length; i++) {
    state = reduce(state, events[i]!)
    if ((i + 1) % keyframeInterval === 0) {
      keyframes.push({ index: i + 1, state })
    }
  }
  return { events, sortedEvents, keyframes, keyframeInterval }
}

/** The last keyframe at or before `index` — always `keyframes[0]` at worst. */
function nearestKeyframeAtOrBefore(keyframes: readonly FoldCursor[], index: number): FoldCursor {
  let lo = 0
  let hi = keyframes.length - 1
  let best = keyframes[0]!
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const candidate = keyframes[mid]!
    if (candidate.index <= index) {
      best = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/**
 * State at scrub time T, folding forward from whichever is cheaper: `from`
 * (the previous tick's cursor, when time moved forward — the common case
 * during playback) or the nearest keyframe at or before T (a backward scrub,
 * or the first fold of a fresh session).
 *
 * `T` is translated into a target position via `index.sortedEvents` (a count
 * of events at or before `T` — navigation only), but every event actually
 * folded, from `start.index` up to that target, is read off `index.events` —
 * the record's own order (#205). Whichever starting point folding continues
 * from, the result is identical to {@link foldUpTo}, because both walk the
 * same append-ordered prefix: folding it and then continuing over the next
 * chunk is the same left-fold as folding the whole prefix at once, since
 * `reduce(state, event)` depends only on that pair, never on how `state` was
 * built (#160's identity law).
 */
export function foldFrom(index: SessionIndex, ts: number, from: FoldCursor): FoldCursor {
  const target = boundaryIndex(index.sortedEvents, ts)
  if (target === from.index) return from

  // Whichever starting point gets us closest to `target` without folding
  // backward: `from` itself for an ordinary forward tick, or the nearest
  // keyframe when `from` is behind it (a backward scrub, or a forward seek
  // that jumped past one or more keyframes).
  const keyframe = nearestKeyframeAtOrBefore(index.keyframes, target)
  const start = from.index <= target && from.index >= keyframe.index ? from : keyframe

  let state = start.state
  for (let i = start.index; i < target; i++) {
    state = reduce(state, index.events[i]!)
  }
  return { index: target, state }
}

export interface TimeRange {
  start: number
  end: number
}

/**
 * The scrubber's bounds — null for a session with no events yet. A plain
 * min/max scan, so an honest recording's own non-monotonic `ts` order (#205)
 * never trips it up: the range is correct however the log arrived.
 */
export function timeRangeOf(events: readonly RhizomorphEvent[]): TimeRange | null {
  if (events.length === 0) return null
  let start = events[0]!.ts
  let end = events[0]!.ts
  for (const event of events) {
    if (event.ts < start) start = event.ts
    if (event.ts > end) end = event.ts
  }
  return { start, end }
}
