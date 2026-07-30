import { useEffect, useState } from 'react'
import { EVENT_TYPES, parseEvent, type ObservatoryEvent } from '@observatory/core'

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
  reduce: (state: S, event: ObservatoryEvent) => S
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

    source.onopen = () => setStatus('open')
    source.onerror = () => setStatus('error')

    const handleMessage: MessageListener = (event) => {
      const payload = parseJson(event.data)
      if (payload === undefined) return
      const result = parseEvent(payload)
      if (!result.ok) return
      setState((prev) => reduce(prev, result.event))
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
      source.close()
      setStatus('closed')
    }
    // Re-subscribing on every `reduce`/`createSource` identity change would
    // reopen the connection for no reason; only a new URL should do that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
