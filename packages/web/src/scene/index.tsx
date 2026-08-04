import { useEffect, useMemo, useRef } from 'react'
import { useMode, useReplay } from '../app/ModeContext.js'
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
 * surface reads — the derived fleet and the shared selection (which since prd6
 * ruling 5 also holds `MAIN_SELECTION`, the root-mass: the scene hands it back
 * from a click on the mass and the same toggle-or-clear applies to it as to any
 * lane) — and feeds the
 * pulse field from the fold's **news tail**, which is where ruling 32's first
 * rule becomes mechanical: `state.news` only ever contains what the fold tagged
 * as news, so a replayed session builds the whole picture and lights none of it.
 *
 * The field and the settle registry are per-source. Switching to a fixture (keys
 * 1/2/3) is switching to a different event log, and carrying one log's pulses
 * into another would be inventing traffic the new log never reported.
 *
 * **THE TWO CLOCKS** (#157's audit) are also wired here, because wiring is what
 * this file is for. The scene needs both and they are not interchangeable:
 *
 * - **animation time** is real wall time and is taken inside `SceneView`'s own
 *   loop, in a replay exactly as live. Every envelope in the picture is a duration
 *   a person watches, and a person does not scrub.
 * - **state time** — the instant the fleet's ages are judged against — is the
 *   replay scrub position when there is one, and wall time when there is not. It
 *   is read from `ModeContext`, which is the same context #155 threads its own
 *   clock through and the same fold the replay controls and `StreamContext` read;
 *   at the time of writing #155 has not landed, so this takes the scrub position
 *   from `useReplay().playback.currentTs` directly rather than inventing a second
 *   source of replay truth to be reconciled later.
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
  const mode = useMode()
  const replay = useReplay()
  const replaying = mode === 'replay'

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

    // LEGITIMATELY REAL TIME (#157's audit), and the only clock these three may
    // take. Every one of them is stamping the *start of an animation* — "this just
    // arrived, light it for 600 ms", "this lane just appeared, grow it in over
    // 800 ms", "this lane just landed, part its cord over 1.4 s" — and none of
    // them is judging a state by its age. They must also agree with the clock the
    // loop steps them on (`SceneView`'s `real`/`clock`), or a pulse born on one
    // and aged on the other would live for ever or die on arrival.
    //
    // The replay case is honest by construction rather than by this line: `state`
    // only ever carries what the fold tagged as *news*, and a replayed session
    // produces none (`pulses.ts`'s `takeNews`, ruling 32), so `taken.events` is
    // empty and nothing here fires at all.
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
      replaying={replaying}
      // The scrub position is "now" for a replay and there is no such thing live,
      // so the prop is absent live and `SceneView` falls back to its own real
      // clock — one source of replay truth, and no second one to disagree with it.
      {...(replaying ? { asOf: replay.playback.currentTs } : {})}
      {...(now === undefined ? {} : { now })}
    />
  )
}

export { SceneView } from './SceneView.js'
