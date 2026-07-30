import { createContext, useContext, type ReactNode } from 'react'
import type { ConnectionStatus, EventSourceFactory } from '../hooks/useEventStream.js'
import { useEventStream } from '../hooks/useEventStream.js'
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

export function StreamProvider({ url, children, createSource }: StreamProviderProps) {
  const { state, status } = useEventStream(url, {
    initialState: initialRawStreamState,
    reduce: foldRawEvents,
    createSource,
  })

  return <StreamContext.Provider value={{ state, status }}>{children}</StreamContext.Provider>
}

export function useStream(): StreamContextValue {
  const value = useContext(StreamContext)
  if (value === null) {
    throw new Error('useStream must be used within a StreamProvider')
  }
  return value
}
