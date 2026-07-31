import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStream } from '../app/StreamContext.js'
import { buildFleet, type Fleet } from './buildFleet.js'
import { useLaneManifest, type FetchLike } from './manifest.js'

/**
 * One read of the log, for the whole page.
 *
 * The attention strip, the fleet table, the burn strip, the scene and the
 * drawer all call {@link useFleet} and none of them derives anything of its
 * own. Four surfaces each folding the log for themselves is how a dashboard
 * ends up saying "3 need you" beside four amber rows.
 *
 * The fleet is rebuilt on a beat rather than per event: the selectors are cheap
 * but not free, and a one-second clock is already faster than a glance. It also
 * means the passage of time alone moves the instrument — a lane crosses the
 * frozen threshold because eight minutes went by, not because something
 * arrived to tell us so.
 */

export interface FleetContextValue {
  fleet: Fleet
  /** True while `/api/lanes` has not answered yet — distinct from "no manifest". */
  manifestLoading: boolean
}

const FleetContext = createContext<FleetContextValue | null>(null)

/** How often the derived fleet is rebuilt when no clock is pinned. */
export const FLEET_TICK_MS = 1_000

export interface FleetProviderProps {
  children: ReactNode
  /** Test-only clock. Pinned, nothing re-derives on a timer. */
  now?: number
  /** Test-only fetch for `/api/lanes`. */
  fetchLanes?: FetchLike
}

export function FleetProvider({ children, now, fetchLanes }: FleetProviderProps) {
  const { state, source, fixtureManifest } = useStream()
  const [clock, setClock] = useState(() => now ?? Date.now())

  useEffect(() => {
    if (now !== undefined) {
      setClock(now)
      return
    }
    const timer = setInterval(() => setClock(Date.now()), FLEET_TICK_MS)
    return () => clearInterval(timer)
  }, [now])

  // A fixture brings the manifest it was dispatched with; only the live stream
  // has to go and ask the server for one.
  const fetched = useLaneManifest(source === 'live', fetchLanes)
  const manifest = fixtureManifest ?? fetched.manifest

  const fleet = useMemo(
    () => buildFleet(state.session, { now: clock, manifest }),
    [state.session, clock, manifest],
  )

  const value = useMemo<FleetContextValue>(
    () => ({ fleet, manifestLoading: fetched.status === 'loading' }),
    [fleet, fetched.status],
  )

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>
}

export function useFleetContext(): FleetContextValue {
  const value = useContext(FleetContext)
  if (value === null) {
    throw new Error('useFleet must be used within a FleetProvider')
  }
  return value
}

/** The derived fleet. Every prd3 surface reads this and nothing else. */
export function useFleet(): Fleet {
  return useFleetContext().fleet
}
