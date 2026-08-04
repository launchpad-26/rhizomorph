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
 * case where the log is already in fold order.
 */
export function isSorted(events: readonly RhizomorphEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.ts < events[i - 1]!.ts) return false
  }
  return true
}

/**
 * Sorts once, defensively. The server serves events in fold order, so the
 * common case is the O(n) sortedness check below finding nothing to do and
 * handing back the same array reference (no allocation, and every downstream
 * `useMemo` keyed on `events` stays stable). A genuinely unsorted log still
 * gets folded correctly — it costs one `O(n log n)` sort instead of silently
 * producing a wrong prefix.
 */
export function sortEvents(events: readonly RhizomorphEvent[]): RhizomorphEvent[] {
  if (isSorted(events)) return events as RhizomorphEvent[]
  return [...events].sort((a, b) => a.ts - b.ts)
}

/**
 * The index of the first event with `ts > T` in a `ts`-ascending array — i.e.
 * the count of events at or before `T`. Binary search, `O(log n)`, replacing
 * the full `filter` a scrub used to pay on every tick (#160).
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
 * per tick to answer.
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
 * The events at or before scrub time T, in fold order. `StreamContext` uses
 * this directly to serve panels the same raw-event shape they read live.
 * Precondition: `events` is already `ts`-ascending (pass it through
 * {@link sortEvents} once, not per call — see {@link buildSessionIndex}).
 */
export function eventsUpTo(
  events: readonly RhizomorphEvent[],
  ts: number,
): RhizomorphEvent[] {
  return events.slice(0, boundaryIndex(events, ts))
}

/**
 * State at scrub time T, folding the whole prefix from scratch every call —
 * the reference implementation. Correct at any log size, but `O(n)` per call,
 * so `useReplaySession` uses this only as the oracle incremental folding
 * (`foldFrom`) is tested against, never as the hot path (#160).
 */
export function foldUpTo(events: readonly RhizomorphEvent[], ts: number): SessionState {
  const sorted = sortEvents(events)
  return reduceAll(eventsUpTo(sorted, ts), initialSessionState())
}

/** A `SessionState` pinned to a known position in a sorted event log. */
export interface FoldCursor {
  /** Count of events folded to reach `state` — an index into a `SessionIndex`'s `events`. */
  index: number
  state: SessionState
}

/** A cursor at the very start of any log, before its first event. */
export function initialFoldCursor(): FoldCursor {
  return { index: 0, state: initialSessionState() }
}

/** Every `keyframeInterval`-th cursor, `keyframes[0]` always the empty one at index 0. */
export interface SessionIndex {
  events: readonly RhizomorphEvent[]
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
 * Sorts the log once and precomputes keyframes once — the "once per session
 * load" work #160 calls for. Everything downstream (`foldFrom`) is `O(log n)`
 * plus the events actually crossed.
 */
export function buildSessionIndex(
  events: readonly RhizomorphEvent[],
  keyframeInterval = DEFAULT_KEYFRAME_INTERVAL,
): SessionIndex {
  const sorted = sortEvents(events)
  const keyframes: FoldCursor[] = [initialFoldCursor()]
  let state = initialSessionState()
  for (let i = 0; i < sorted.length; i++) {
    state = reduce(state, sorted[i]!)
    if ((i + 1) % keyframeInterval === 0) {
      keyframes.push({ index: i + 1, state })
    }
  }
  return { events: sorted, keyframes, keyframeInterval }
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
 * or the first fold of a fresh session). Either way the result is identical
 * to {@link foldUpTo} — folding a prefix and then continuing over the next
 * chunk is the same left-fold as folding the whole thing at once, since
 * `reduce(state, event)` depends only on that pair, never on how `state` was
 * built (#160's identity law).
 */
export function foldFrom(index: SessionIndex, ts: number, from: FoldCursor): FoldCursor {
  const target = boundaryIndex(index.events, ts)
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

/** The scrubber's bounds — null for a session with no events yet. */
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
