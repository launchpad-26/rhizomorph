import {
  initialSessionState,
  reduce,
  type RhizomorphEvent,
  type SessionState,
} from '@rhizomorph/core'

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

export interface StreamState {
  /** The raw log in arrival order — what replay and the older panels read. */
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
 * Whether an event is *news*. Stateless on purpose, so any consumer can ask
 * about any event without the fold having had to remember it.
 */
export function isNews(state: Pick<StreamState, 'connectedAt'>, event: RhizomorphEvent): boolean {
  return event.ts >= state.connectedAt - NEWS_GRACE_MS
}

export function initialStreamState(connectedAt: number): StreamState {
  return { events: [], session: initialSessionState(), connectedAt, news: [], newsCount: 0 }
}

export function foldStreamEvent(state: StreamState, event: RhizomorphEvent): StreamState {
  const news = isNews(state, event)
  return {
    events: [...state.events, event],
    session: reduce(state.session, event),
    connectedAt: state.connectedAt,
    news: news ? [...state.news, event].slice(-MAX_NEWS) : state.news,
    newsCount: state.newsCount + (news ? 1 : 0),
  }
}

/**
 * Fold a whole batch in one pass. A replay burst is thousands of events, and
 * folding them one state object at a time is quadratic in the event array
 * alone — which is exactly the shape such a burst has.
 */
export function foldStreamEvents(
  state: StreamState,
  events: readonly RhizomorphEvent[],
): StreamState {
  if (events.length === 0) return state

  const all = [...state.events]
  const news = [...state.news]
  let session = state.session
  let newsCount = state.newsCount

  for (const event of events) {
    all.push(event)
    session = reduce(session, event)
    if (isNews(state, event)) {
      news.push(event)
      newsCount += 1
    }
  }

  return {
    events: all,
    session,
    connectedAt: state.connectedAt,
    news: news.slice(-MAX_NEWS),
    newsCount,
  }
}
