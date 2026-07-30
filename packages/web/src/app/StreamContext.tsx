import { createContext, useContext, type ReactNode } from 'react'
import type { ConnectionStatus, EventSourceFactory } from '../hooks/useEventStream.js'
import { useEventStream } from '../hooks/useEventStream.js'
import { useMode, useReplay } from './ModeContext.js'
import { foldRawEvents, initialRawStreamState, type RawStreamState } from './streamState.js'

export interface StreamContextValue {
  state: RawStreamState
  status: ConnectionStatus
}

const StreamContext = createContext<StreamContextValue | null>(null)

export interface StreamProviderProps {
  url: string
  children: ReactNode
  /** Test-only escape hatch for injecting a mock SSE source. */
  createSource?: EventSourceFactory
}

/**
 * Panels read one hook regardless of mode: live SSE state while `mode ===
 * 'live'`, the replay fold at the current scrub time while `mode ===
 * 'replay'` (architecture.md, "live and replay are the same reducer").
 * "Return to live" is just the mode flipping back — the live connection
 * below keeps folding the whole time, so it is exactly where it left off.
 */
export function StreamProvider({ url, children, createSource }: StreamProviderProps) {
  const live = useEventStream(url, {
    initialState: initialRawStreamState,
    reduce: foldRawEvents,
    createSource,
  })

  const mode = useMode()
  const replay = useReplay()

  const value: StreamContextValue =
    mode === 'replay'
      ? { state: { events: replay.eventsAtScrubTime }, status: 'open' }
      : live

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>
}

export function useStream(): StreamContextValue {
  const value = useContext(StreamContext)
  if (value === null) {
    throw new Error('useStream must be used within a StreamProvider')
  }
  return value
}
