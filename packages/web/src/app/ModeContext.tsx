import { createContext, useContext, useEffect, type ReactNode } from 'react'
import type { FetchLike } from '../replay/api.js'
import { emptyReplaySession, useReplaySession, type ReplaySession } from '../replay/useReplaySession.js'

export type Mode = 'live' | 'replay'

/**
 * The whole app's register shift for ruling 16 — a cooled, desaturated tint
 * plus a visible frame, applied at the document body rather than inside
 * `Shell`'s own tree, so every panel underneath is affected without any of
 * them (or the shell) needing to know mode exists. Ice tokens only (never a
 * ladder hue, law 9): a mode is not a status.
 */
export const REPLAY_CHROME_CLASSES = [
  'saturate-75',
  'brightness-90',
  'outline',
  'outline-2',
  'outline-ice-700',
] as const

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
  const mode: Mode = replay.isReplaying ? 'replay' : 'live'
  const value: ModeContextValue = { mode, replay }

  useEffect(() => {
    const body = document.body
    body.dataset.mode = mode
    if (mode === 'replay') {
      body.classList.add(...REPLAY_CHROME_CLASSES)
    }
    return () => {
      delete body.dataset.mode
      body.classList.remove(...REPLAY_CHROME_CLASSES)
    }
  }, [mode])

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>
}

export function useMode(): Mode {
  return useContext(ModeContext).mode
}

/** The replay session state — session list, selection, fetched log, scrubber clock, fold. */
export function useReplay(): ReplaySession {
  return useContext(ModeContext).replay
}
