import { useEffect, useState } from 'react'
import { EVENT_TYPES, parseEvent, type RhizomorphEvent } from '@rhizomorph/core'

export type ConnectionStatus = 'connecting' | 'open' | 'error' | 'closed'

type MessageListener = (event: MessageEvent<string>) => void

/** The slice of the browser `EventSource` API this hook actually uses. */
export interface EventSourceLike {
  close(): void
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<string>) => void) | null
  /** Optional so existing mocks that predate named-event support still satisfy this interface. */
  addEventListener?(type: string, listener: MessageListener): void
  removeEventListener?(type: string, listener: MessageListener): void
}

export type EventSourceFactory = (url: string) => EventSourceLike

export interface UseEventStreamOptions<S> {
  initialState: S
  /**
   * Batch fold: called with whatever the buffer coalesced since the last
   * flush — 1 event as often as it is thousands (#183). `StreamContext.tsx`
   * wires this to `foldStreamEvents`, never `foldStreamEvent` — the per-event
   * fold has no caller left that can hand it a single-element array and mean
   * it.
   */
  reduce: (state: S, events: readonly RhizomorphEvent[]) => S
  /** Overridable so tests can feed a mock stream instead of a real SSE connection. */
  createSource?: EventSourceFactory
}

export interface UseEventStreamResult<S> {
  state: S
  status: ConnectionStatus
}

const defaultCreateSource: EventSourceFactory = (url) => new EventSource(url)

/**
 * Opens an SSE connection and folds every validated event it carries through
 * `reduce`. Live and replay share this shape: replay just drives `reduce`
 * from a history slice instead of a socket.
 *
 * A lone arriving event is folded the moment it lands — one `setState`, same
 * as always, so a single live tick still shows up the instant its handler
 * returns. Any event that lands while that fold is still in flight (nothing
 * has drained the microtask queue yet to say it's done) joins a buffer
 * instead of paying for a `setState` of its own, and the whole buffer folds
 * together in one pass on the next microtask (#183). A fresh page load has no
 * `Last-Event-ID` (#166), so `/api/stream` replays the whole session before
 * it live-tails — on a large session that arrives as a burst of thousands of
 * `message` events faster than a microtask turn can drain, and folding each
 * one through a `setState` of its own is what starved the frame loop (62 long
 * tasks, 224,805 ms of blocking, zero rAF frames sampled on a 55k-event
 * session — the 2026-08-05 conductor measurement that opened this issue).
 * Coalescing that burst — same mechanism whether it's a first load or a #166
 * reconnect resume — turns O(n) `setState` calls, each paying its own O(n)
 * copy inside `foldStreamEvent`, into a small, session-shape-bounded number of
 * `setState`s paying one O(n) pass through `foldStreamEvents` between them.
 *
 * Measured on the dev box, `foldStreamEvent` (per event) vs `foldStreamEvents`
 * (one batched pass), median of 3 interleaved rounds (`streamState.test.ts`'s
 * `#183` bench — same discipline as `panels/ledger/perf.test.ts`'s #157 note:
 * reported, not asserted, since a wall clock under concurrent workers measures
 * the box, not the code):
 *
 * | N (events) | per-event (before) | batched (after) | ratio    |
 * | ---------- | ------------------- | ---------------- | -------- |
 * | 5,000      | 29.4 ms             | 1.8 ms           | ~16x     |
 * | 15,000     | 630.1 ms            | 5.8 ms           | ~109x    |
 * | 55,000     | 20,880.2 ms         | 24.5 ms          | ~851x    |
 *
 * 11x the events (5k→55k) costs ~711x the time on the old per-event path (the
 * O(n²) shape) against ~13x on the batched path (close to the O(n) shape it
 * should have been) — the gap widens with session size exactly as the
 * conductor's felt-slow report predicted, and the 55k row alone (~20.9s of
 * main-thread work before, ~25ms after) is the replay storm this issue fixes.
 * Re-run with `npm test -- packages/web/src/app/streamState.test.ts` for this
 * box's own numbers.
 */
export function useEventStream<S>(
  url: string,
  { initialState, reduce, createSource = defaultCreateSource }: UseEventStreamOptions<S>,
): UseEventStreamResult<S> {
  const [state, setState] = useState(initialState)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')

  useEffect(() => {
    setState(initialState)
    setStatus('connecting')

    const source = createSource(url)

    // Buffered here, not in React state: every arriving event only needs to
    // survive until the next flush, so there is nothing for a render to read
    // in between.
    let buffer: RhizomorphEvent[] = []
    let flushScheduled = false

    const flush = () => {
      flushScheduled = false
      if (buffer.length === 0) return
      const events = buffer
      buffer = []
      setState((prev) => reduce(prev, events))
    }

    source.onopen = () => setStatus('open')
    source.onerror = () => setStatus('error')

    const handleMessage: MessageListener = (event) => {
      const payload = parseJson(event.data)
      if (payload === undefined) return
      const result = parseEvent(payload)
      if (!result.ok) return

      if (buffer.length === 0 && !flushScheduled) {
        // Leading edge: nothing already in flight, so this one folds right
        // now — a lone event's effect is visible the instant its own handler
        // returns, exactly as folding one at a time always was.
        setState((prev) => reduce(prev, [result.event]))
        flushScheduled = true
        queueMicrotask(flush)
        return
      }
      // A second event landing before that flush has actually run joins the
      // buffer instead of paying for a `setState` of its own — the
      // coalescing a burst needs: thousands of messages from a fresh page
      // load's full-session replay (no Last-Event-ID yet, #166) arrive
      // faster than a microtask turn can drain, so only the first of them
      // takes the eager path above.
      buffer.push(result.event)
    }

    // The server sends every event as a named SSE frame (`event: <type>`),
    // which the spec routes to listeners registered for that name, not to
    // `onmessage` (that only fires for frames with no `event:` line at all).
    // Subscribing both ways means either framing folds correctly.
    source.onmessage = handleMessage
    for (const type of EVENT_TYPES) {
      source.addEventListener?.(type, handleMessage)
    }

    return () => {
      for (const type of EVENT_TYPES) {
        source.removeEventListener?.(type, handleMessage)
      }
      // A microtask already queued from before unmount still runs, but an
      // empty buffer makes `flush` a no-op — nothing sets state on a
      // component that's already gone.
      buffer = []
      source.close()
      setStatus('closed')
    }
    // Re-subscribing on every `reduce`/`createSource` identity change would
    // reopen the connection for no reason; only a new URL should do that.
  }, [url])

  return { state, status }
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}
