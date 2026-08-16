import {
  initialSessionState,
  opensNewSession,
  reduce,
  type RhizomorphEvent,
  type SessionState,
} from '@rhizomorph/core'
import { lowerBoundaryIndex } from '../replay/replayFold.js'

/**
 * The shell's fold. One event log in, one `SessionState` out, through core's
 * real reducer — the same one replay folds, which is the property that makes
 * replay free (architecture.md). Keeping the fold here rather than re-reducing
 * per panel is also what lets four surfaces read one derived fleet object.
 *
 * The one thing this layer adds is the **news-vs-history tag**.
 *
 * `/api/stream` replays the whole session so far before it starts live-tailing.
 * Every one of those events is a fact the state must absorb, and none of them
 * is something that just happened. Firing an arrival flare for three thousand
 * historical commits would be a fireworks display, not an instrument — so C's
 * first motion-law rule is enforced here, at the fold, where every surface
 * inherits it: **history builds state and lights nothing.**
 *
 * The tag comes from the event's own `ts` measured against the moment we
 * connected, never from arrival order: a replay burst can arrive out of order,
 * in any interleaving, and each event still knows when it happened.
 */

/**
 * How stale an event may be and still count as news. This covers the seam where
 * the replay burst meets the live tail: an event emitted a moment before we
 * connected is genuinely news by the time it reaches us.
 */
export const NEWS_GRACE_MS = 4_000

/** How many news events to keep for the scene's arrival flares. */
const MAX_NEWS = 256

/**
 * How many raw events the live buffer retains, oldest evicted first (#176's
 * original finding, confirmed twice: this fold used to append `events: [...]`
 * with no ceiling at all, so an 8-hour session grew it without limit).
 *
 * Chosen well above what a real live session actually runs: #166/#183's own
 * benchmarks measured real sessions at ~46k-55k events, so a ceiling has to
 * clear that with headroom or it would start evicting mid-session for a
 * perfectly ordinary run. 75,000 does — and is still a real ceiling, so a
 * session that runs long enough, or busy enough, still bounds the raw window
 * instead of growing it forever.
 *
 * Eviction only ever trims this raw window, never the fold: `session` is the
 * running projection and every event it ever saw stays folded into it
 * (`core`'s `reduce`, `eventCount` included) whether or not that event is
 * still sitting in `events`. Nothing that reads only `session` — which is
 * every selector in `@rhizomorph/core` — can tell eviction happened at all.
 * {@link eventsWindowLabel} is the honest word for the surfaces that read
 * `events` directly and therefore can.
 */
export const MAX_EVENTS = 75_000

export interface StreamState {
  /**
   * The raw log in arrival order — what replay and the older panels read.
   * Capped at {@link MAX_EVENTS}, oldest evicted first; `session.eventCount`
   * (never capped) is the true total, so `events.length < session.eventCount`
   * is exactly how a reader detects eviction ({@link eventsWindowLabel}).
   *
   * This window is the window *for the recording currently folded*: it
   * empties alongside `session` when the fold crosses a session boundary
   * (`opensNewSession` in `core/src/reduce.ts` — #390 for the retarget, #592
   * for the rotation), which is what keeps
   * `events.length <= session.eventCount` true across one. Clearing one
   * without the other would leave the pair describing two different
   * recordings, and {@link eventsWindowLabel} reads exactly that pair.
   */
  events: RhizomorphEvent[]
  /** The fold, kept incrementally so nothing re-reduces the log per render. */
  session: SessionState
  /** When this connection opened: the news/history boundary. */
  connectedAt: number
  /** Most recent news events, oldest first, capped — the scene's flare queue. */
  news: RhizomorphEvent[]
  /** How many news events have arrived in total. Cheap change detection. */
  newsCount: number
}

/**
 * Honesty at the boundary: once eviction has trimmed `events` below the
 * session's true total, any surface reading raw events directly must say so
 * rather than let a bounded window pass as the whole session. `null` while
 * every event the session has ever seen is still sitting in `events` — the
 * common case for any session under {@link MAX_EVENTS} events.
 *
 * `session.eventCount` is the ground truth (`core`'s `reduce` increments it
 * on every event, uncapped) and `events.length` never exceeds it, so the two
 * disagreeing is exactly what eviction looks like from the outside.
 */
export function eventsWindowLabel(state: Pick<StreamState, 'events' | 'session'>): string | null {
  const shown = state.events.length
  const total = state.session.eventCount
  if (shown >= total) return null
  return `showing the last ${shown} events`
}

/**
 * Whether an event is *news*. Stateless on purpose, so any consumer can ask
 * about any event without the fold having had to remember it.
 */
export function isNews(state: Pick<StreamState, 'connectedAt'>, event: RhizomorphEvent): boolean {
  return event.ts >= state.connectedAt - NEWS_GRACE_MS
}

export function initialStreamState(connectedAt: number): StreamState {
  return { events: [], session: initialSessionState(), connectedAt, news: [], newsCount: 0 }
}

/**
 * The repo the fold currently describes, or `null` before any
 * `session.started` has named one.
 *
 * Exported because it is the page's **repo identity**, not just this fold's
 * private business: anything that caches a per-repo answer beside the fold has
 * to invalidate whenever the repo it was fetched for changes, or the two drift
 * apart. `FleetContext` keys `/api/lanes` off this for exactly that reason
 * (#390 review) — a lane manifest fetched for repo A must not fence repo B.
 *
 * Since #592 the fold resets on a strictly wider condition than this key
 * changes: an ordinary rotation opens a new recording of the SAME repo, so the
 * fold restarts while `foldedRepoPath` holds still. That is correct rather
 * than a gap — `/api/lanes` describes the repo's workmux lanes, not the
 * recording, so a rotation gives it nothing to re-read.
 */
export function foldedRepoPath(session: SessionState): string | null {
  return session.session?.repoPath ?? null
}

/**
 * ## The session boundary, and this layer's half of it
 *
 * **Whether a `session.started` opens a different recording is `core`'s
 * question, and `core` answers it** — `opensNewSession` in `core/src/reduce.ts`,
 * where the rule, the two non-boundaries (a reconnect's replay; anything
 * before the first `session.started`) and the case-sensitivity decision
 * (`boundary-on-case-difference`) are all argued in full. It has to live there
 * rather than here: ADR-0002 says one reducer serves live and replay, so a
 * reset spelled in the web shell would be true of the live stream and false of
 * a replayed log carrying the same boundary (#592).
 *
 * What is left for this module is the state `core` does not own. `session` is
 * reset by the reducer itself; the raw `events` window, the `news` flare queue
 * and its counter are this layer's own, and they cross the boundary with it —
 * `events` and `session.eventCount` are read as a PAIR by
 * {@link eventsWindowLabel}, so clearing one without the other would leave the
 * two describing different recordings. `connectedAt` is carried across
 * untouched: the news/history boundary belongs to this *connection*, not to
 * whichever recording it happens to be carrying.
 *
 * ## What it assumes about ordering
 *
 * That a session's `session.started` **leads** its own events. The recorder
 * provides this — a rotation opens the new log with `session.started` and
 * nothing carried over, fenced by that module's own `rotate.test.ts` (not
 * cited by path here: the recorder namespace law, prd16 ruling 2, keeps web
 * files clear of that module's paths entirely) — and `/api/stream` replays a
 * log in order. If that ever stopped holding, a new session's event arriving
 * *before* its `session.started` in the same flush would fold onto the old one
 * and then be dropped by the reset: one event lost rather than two recordings
 * merged, which is the right way round, but it is an assumption and not a
 * guarantee this module can enforce.
 * `drops-events-that-precede-the-boundary` pins the behaviour so a change here
 * is a decision.
 */
export function foldStreamEvent(state: StreamState, event: RhizomorphEvent): StreamState {
  // The reset lands *before* the boundary event folds, so the `session.started`
  // that opened the new recording is itself the first event of the new fold.
  const base = opensNewSession(state.session, event)
    ? initialStreamState(state.connectedAt)
    : state
  // `isNews` reads `connectedAt`, which a reset carries across untouched: the
  // news/history boundary belongs to this *connection*, not to the repo it
  // happens to be watching.
  const news = isNews(base, event)
  return {
    events: [...base.events, event].slice(-MAX_EVENTS),
    session: reduce(base.session, event),
    connectedAt: base.connectedAt,
    news: news ? [...base.news, event].slice(-MAX_NEWS) : base.news,
    newsCount: base.newsCount + (news ? 1 : 0),
  }
}

/**
 * Fold a whole batch in one pass. A replay burst is thousands of events, and
 * folding them one state object at a time is quadratic in the event array
 * alone — which is exactly the shape such a burst has.
 *
 * `all` is capped to {@link MAX_EVENTS} once, after the loop, not per event:
 * slicing every iteration would reintroduce the same O(n²) shape this
 * function exists to avoid. `session` folds every event in the batch
 * regardless — the cap never reaches the reducer, only the raw window kept
 * beside it.
 *
 * The session boundary (`opensNewSession`) is checked **inside** the loop, not
 * once against the incoming state: a single flush can carry the rotation and
 * the new recording's first events together, and a check hoisted out of the
 * loop would fold the new session's facts straight onto the ended one's.
 * This is what keeps the batched path bit-for-bit identical to folding the
 * same events one at a time through {@link foldStreamEvent} — the #166/#183
 * identity law, which now has to hold across a boundary too.
 */
export function foldStreamEvents(
  state: StreamState,
  events: readonly RhizomorphEvent[],
): StreamState {
  if (events.length === 0) return state

  let all = [...state.events]
  let news = [...state.news]
  let session = state.session
  let newsCount = state.newsCount

  for (const event of events) {
    if (opensNewSession(session, event)) {
      // Fresh arrays rather than `length = 0`: the accumulators start as
      // copies, but nothing here may assume that of a future caller.
      all = []
      news = []
      newsCount = 0
      session = initialSessionState()
    }
    all.push(event)
    session = reduce(session, event)
    // Against `state`, not the reset: `connectedAt` survives a boundary, so
    // this is the same question it always was.
    if (isNews(state, event)) {
      news.push(event)
      newsCount += 1
    }
  }

  return {
    events: all.slice(-MAX_EVENTS),
    session,
    connectedAt: state.connectedAt,
    news: news.slice(-MAX_NEWS),
    newsCount,
  }
}

/**
 * `StreamState` for a replay prefix, without paying `foldStreamEvents`' full
 * pass over it every tick (#162, the second re-fold #160 didn't reach —
 * `StreamContext.tsx` was refolding this prefix from scratch on every scrub
 * tick because a fresh `.slice()` gave the memo a new array identity to miss
 * every time).
 *
 * `session` is expected already folded by replay's own incremental cursor
 * (`useReplaySession`'s `foldFrom`, #160) — this function does not re-reduce
 * a single event, so the two fold engines never duplicate each other's work.
 * `events` is one slice of the shared, stably-identified sorted log (proven
 * cheap even at 46k events — the slice was never the cost, see #162's
 * measurements). `news`/`newsCount` fold to a threshold-crossing on a
 * `ts`-ascending array, which is a single binary search
 * ({@link lowerBoundaryIndex}) rather than a scan: every event at or after
 * that boundary is news, and since the array is globally sorted that boundary
 * is the same index regardless of how far the prefix reaches, so it never
 * needs to be recomputed per tick either.
 */
export function replayStreamState(
  sortedEvents: readonly RhizomorphEvent[],
  prefixLength: number,
  session: SessionState,
  connectedAt: number,
): StreamState {
  const newsFrom = lowerBoundaryIndex(sortedEvents, connectedAt - NEWS_GRACE_MS)
  const newsCount = Math.max(0, prefixLength - newsFrom)
  return {
    events: sortedEvents.slice(0, prefixLength),
    session,
    connectedAt,
    news: sortedEvents.slice(Math.max(newsFrom, prefixLength - MAX_NEWS), prefixLength),
    newsCount,
  }
}
