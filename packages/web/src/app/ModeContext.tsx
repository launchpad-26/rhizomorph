import { createContext, useContext, type ReactNode } from 'react'
import type { FetchLike } from '../replay/api.js'
import { emptyReplaySession, useReplaySession, type ReplaySession } from '../replay/useReplaySession.js'

export type Mode = 'live' | 'replay'

export interface ModeContextValue {
  mode: Mode
  replay: ReplaySession
}

/** Outside a `ModeProvider` (most panel/unit tests), behave as plain live mode. */
const defaultModeContextValue: ModeContextValue = { mode: 'live', replay: emptyReplaySession() }

const ModeContext = createContext<ModeContextValue>(defaultModeContextValue)

export interface ModeProviderProps {
  children: ReactNode
  /** Test-only escape hatch for injecting a mock fetch implementation. */
  fetchImpl?: FetchLike
}

/**
 * Owns the one replay session slot (architecture.md, "live and replay are the
 * same reducer"): a session with events loaded drives `mode`, and both
 * `StreamContext` and the replay controls read this same fold — there is
 * only ever one state per mode, never two.
 */
export function ModeProvider({ children, fetchImpl }: ModeProviderProps) {
  const replay = useReplaySession({ fetchImpl })
  const value: ModeContextValue = { mode: replay.isReplaying ? 'replay' : 'live', replay }
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>
}

export function useMode(): Mode {
  return useContext(ModeContext).mode
}

/** The replay session state — session list, selection, fetched log, scrubber clock, fold. */
export function useReplay(): ReplaySession {
  return useContext(ModeContext).replay
}
