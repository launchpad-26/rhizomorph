import { useEffect, useMemo, useRef } from 'react'
import { useStream } from '../app/StreamContext.js'
import { useFleet, useSelection } from '../fleet/index.js'
import { laneIndex } from './resolve.js'
import { PulseField, takeNews } from './pulses.js'
import { RetireRegistry } from './retire.js'
import { SceneView } from './SceneView.js'
import { SettleRegistry } from './settle.js'

/**
 * THE SCENE — a mycelium pulse-network in the ice-neon register, mounted by the
 * shell's lazy slot behind its error boundary (`app/SceneSlot.tsx`).
 *
 * This file is the wiring and nothing else. It reads the two things every prd3
 * surface reads — the derived fleet and the shared selection — and feeds the
 * pulse field from the fold's **news tail**, which is where ruling 32's first
 * rule becomes mechanical: `state.news` only ever contains what the fold tagged
 * as news, so a replayed session builds the whole picture and lights none of it.
 *
 * The field and the settle registry are per-source. Switching to a fixture (keys
 * 1/2/3) is switching to a different event log, and carrying one log's pulses
 * into another would be inventing traffic the new log never reported.
 */
export interface SceneProps {
  /**
   * Test-only clock. Pinned, the canvas draws one frame and no loop starts —
   * the same seam `StreamProvider` and `FleetProvider` take, so a test drives
   * the real code against a still image rather than mocking around it.
   */
  now?: number
}

export default function Scene({ now }: SceneProps = {}) {
  const { state, source } = useStream()
  const fleet = useFleet()
  const { selectedId, select } = useSelection()

  // Re-created per source: a different log gets a different field. The retire
  // registry goes with them for the same reason and one more — it remembers which
  // lanes it has already cut, and carrying that across a source switch would mean
  // a lane in the new log inheriting a cut from a lane in the old one.
  const { field, settle, retire } = useMemo(
    () => ({
      field: new PulseField(),
      settle: new SettleRegistry(),
      retire: new RetireRegistry(),
    }),
    [source],
  )

  const cursor = useRef(0)
  const index = useMemo(() => laneIndex(fleet), [fleet])
  const indexRef = useRef(index)
  indexRef.current = index

  useEffect(() => {
    cursor.current = 0
  }, [source])

  useEffect(() => {
    // A stream that has gone backwards is a new stream (a source switch, or a
    // replay scrub). Take it from where it now is rather than replaying the
    // difference as if it had just happened.
    if (state.newsCount < cursor.current) cursor.current = state.newsCount

    const taken = takeNews(state, cursor.current)
    cursor.current = taken.cursor
    if (taken.events.length === 0) return

    const now = Date.now()
    field.ingest(taken.events, indexRef.current, now)
    settle.note(taken.events, indexRef.current, now)
    // The third thing fed from the news tail, and the reason all three are fed
    // from it rather than from the fleet: a cut is an *animation*, so it may only
    // fire for something that just happened. A replayed session — or a scrub past
    // a landing — builds every scar and cuts nothing (`retire.ts`, law 2).
    retire.note(taken.events, indexRef.current, now)
  }, [state, field, settle, retire])

  return (
    <SceneView
      fleet={fleet}
      field={field}
      settle={settle}
      retire={retire}
      selectedId={selectedId}
      onSelect={(laneId) => select(laneId === selectedId ? null : laneId)}
      {...(now === undefined ? {} : { now })}
    />
  )
}

export { SceneView } from './SceneView.js'
