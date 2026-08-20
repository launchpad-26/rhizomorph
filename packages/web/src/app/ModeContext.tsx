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
  'outline-(--line-strong)',
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

/**
 * THE ONE CLOCK RULE (#155): every surface that derives liveness, recency or
 * age reads THIS, never `Date.now()` directly. Live mode's "now" is the wall
 * clock; replay's "now" is the scrub position `useReplay()` already tracks. A
 * selector that reads the wall clock while replaying judges a moment from
 * hours ago against right now — every lane reads stale, and a replay that
 * should look like growth reads like a graveyard instead (the bug this issue
 * fixed).
 *
 * Replay's read is `replay.derivedTs`, not `replay.playback.currentTs`: the
 * scrub position the fold is actually standing at, which is the same instant
 * one frame at a time (#269). This is a change of *rate*, not of source —
 * still the scrub position and nothing else, so the rule above is untouched.
 * What it buys is `FleetContext`, which hands this straight to `buildFleet`:
 * a pointer drag emits ~120 seeks a second onto a screen that can show 60, and
 * reading the fold's own position instead of the finger's makes that one
 * rebuild per frame instead of one per pointer event. `LedgerPanel` reads it
 * too, to age its "last seen" labels, where a frame's lag is not a thing a
 * relative-time label can express. (`replay/index.tsx` reads it as well, for
 * the TIDE's live-mode bounds — a value its replay branch never uses.)
 *
 * The two clocks are equal whenever the scrub is at rest, and a lone click or
 * arrow key folds immediately, so nothing done one action at a time observes
 * them apart. A surface that *paints* the position rather than deriving from
 * it — the scrubber thumb, the elapsed labels beside it, the TIDE playhead —
 * reads `playback.currentTs` directly and stays exact to the pointer. So does
 * anything that must agree with `fleet.now` as a distance (the scene's `asOf`,
 * `scene/index.tsx`), except that one reads `derivedTs` for the same reason
 * `FleetContext` does: agreement matters more than freshness.
 *
 * This does not tick on its own. A caller that must keep moving while live
 * (a 1s poll, an animation frame) still owns that loop and re-reads this each
 * tick; a caller that only reads once per render gets a value already correct
 * for the render it is in. Nothing here is on a timer: the only thing that
 * ever moves this while replaying is the operator moving the scrub position,
 * and the one frame it can take to catch up with them afterwards. A scrub that
 * has come to rest reads the same number for ever.
 */
export function useModeClock(): number {
  const { mode, replay } = useContext(ModeContext)
  return mode === 'replay' ? replay.derivedTs : Date.now()
}
