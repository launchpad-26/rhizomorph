import { select } from 'd3-selection'
import { zoom as d3Zoom, ZoomTransform, type D3ZoomEvent } from 'd3-zoom'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { MAIN_SELECTION, type Fleet } from '../../fleet/index.js'
import {
  CLICK_DISTANCE,
  SCALE_EXTENT,
  contentBounds,
  gestureFilter,
  isContentVisible,
  translateExtentFor,
  wheelDelta,
} from '../camera.js'
import { layoutScene, type SceneGeometry } from '../geometry.js'
import {
  breathOf,
  motionMode,
  sceneMarks,
  vibrancyOf,
  type Mark,
  type SceneFrame,
} from '../marks/index.js'
import { paint } from '../paint.js'
import { ICE_200, ink } from '../palette.js'
import type { PulseField } from '../pulses.js'
import type { RetireRegistry } from '../retire.js'
import { salienceOf } from '../salience.js'
import type { SettleRegistry } from '../settle.js'
import { FALLBACK_HEIGHT, FALLBACK_WIDTH, type CameraRig } from './useCamera.js'

/** Everything a frame is drawn from — `SceneView`'s own snapshot ref. */
export interface SceneLatestState {
  fleet: Fleet
  field: PulseField
  settle: SettleRegistry
  retire: RetireRegistry
  selectedId: string | null
  hoverId: string | null
  reducedMotion: boolean
  paused: boolean
  hideFinished: boolean
  now?: number
  asOf?: number
  replaying: boolean
}

export interface FrameLoopResult {
  lost: boolean
  panning: boolean
  /**
   * Redraws when the loop is not running (a pinned clock). A no-op when it is.
   * Stable across renders, so an effect that only wants a redraw on some other
   * change (`hideFinished`) may safely leave it out of its own deps.
   */
  redraw: () => void
}

/**
 * THE FRAME LOOP — the canvas host end to end: device-pixel scaling, d3-zoom's
 * gestures wired to the camera, the reduced-motion-aware picture, and the
 * reduced-motion query's blind spot, hit testing. Nothing visual is decided
 * here — the picture is `sceneMarks(frame)` and the drawing is `paint`.
 *
 * The loop runs continuously because two things are genuinely continuous: a
 * node's drift outward as its lane goes quiet, and the root-mass's breath. With
 * nothing happening, both are imperceptible and the network is still — which is
 * the point. Stillness is information.
 *
 * Everything the loop reads is taken from `latestRef` rather than from a
 * closure, so a fleet rebuild once a second never tears down and rebuilds the
 * animation.
 *
 * **The camera** (prd5 ruling 2) is d3-zoom's, and only the gestures are: the
 * behavior owns pointer and wheel handling and hands us a transform, `camera.ts`
 * owns every law about what that transform means, and `useCamera.ts` owns the
 * navigational half (flights, fit, home, step). This is the wiring between the
 * behavior and `rig`'s refs.
 *
 * **The pause control** (prd5 ruling 4) freezes the picture by holding the
 * scene's clock still — see `pausedAtRef` below — which is why every ambient
 * and event animation in `marks/` is a function of `now`: freezing `now`
 * freezes all of them at once. What the frozen clock deliberately does *not*
 * stop is structural motion: a thread half-way through growing in is a picture
 * of a topology that does not exist, so grow-in keeps its real clock and
 * settles.
 */
export function useFrameLoop(
  hostRef: RefObject<HTMLDivElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  geometryRef: RefObject<SceneGeometry | null>,
  latestRef: RefObject<SceneLatestState>,
  rig: CameraRig,
  setFailure: (message: string | null) => void,
  now: number | undefined,
): FrameLoopResult {
  const [lost, setLost] = useState(false)
  const [panning, setPanning] = useState(false)

  /**
   * The instant the operator pressed pause — **both** of the scene's clocks, while
   * it lasts. Pause holds the picture still, and a picture whose ages went on
   * advancing while its animations were frozen would be a still image quietly
   * drifting outward (#157's split).
   */
  const pausedAtRef = useRef<{ real: number; asOf: number } | null>(null)
  const redrawRef = useRef<() => void>(() => {})
  const redraw = useCallback(() => redrawRef.current(), [])

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (canvas === null || host === null) return

    let frame = 0
    let width = 0
    let height = 0
    let dpr = 1
    let stopped = false
    const pinned = latestRef.current.now !== undefined

    /**
     * Everything that touches a canvas goes through here.
     *
     * The frame loop and the resize observer both live outside React, so an
     * exception in either is outside the error boundary's reach — it would kill
     * the loop and leave a black rectangle with nothing to say. Law 12 applies
     * to the scene's own failures as much as to the data's: it stops drawing,
     * once, and it says what stopped it.
     */
    const guard = (work: () => void): boolean => {
      if (stopped) return false
      try {
        work()
        return true
      } catch (error) {
        stopped = true
        setFailure(error instanceof Error ? error.message : 'unknown drawing failure')
        return false
      }
    }

    /**
     * d3's own `defaultExtent` reads `clientWidth`/`clientHeight`, which costs a
     * synchronous layout on every pan frame and reports zero in jsdom. We hand
     * it the size we already measured instead — the same fix React Flow makes,
     * and for the same two reasons (`@xyflow/system`'s `XYPanZoom` caches the
     * pane extent off a ResizeObserver rather than letting d3 read the DOM).
     */
    const behavior = d3Zoom<HTMLCanvasElement, unknown>()
      .extent((): [[number, number], [number, number]] => [
        [0, 0],
        [width, height],
      ])
      .scaleExtent([SCALE_EXTENT[0], SCALE_EXTENT[1]])
      .clickDistance(CLICK_DISTANCE)
      .wheelDelta((event: WheelEvent) => wheelDelta(event))
      .filter((event: Event) => gestureFilter(event))

    const resize = () => {
      const rect = host.getBoundingClientRect()
      dpr = Math.min(2, window.devicePixelRatio || 1)
      // A floor rather than the measured size, so a zero-height host during
      // mount still lays out a coherent scene instead of dividing by nothing.
      width = Math.max(FALLBACK_WIDTH, Math.floor(rect.width))
      height = Math.max(FALLBACK_HEIGHT, Math.floor(rect.height))
      rig.viewportRef.current = { width, height }
      behavior.translateExtent(translateExtentFor(rig.viewportRef.current))
      // The backing store only. The element's *size* is CSS (absolutely
      // positioned), so it can never feed back into the panel that contains it —
      // a canvas with a pixel width inside a flexible column will happily push
      // that column wider than the viewport, one resize at a time.
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      const ctx = canvas.getContext('2d')
      if (ctx !== null) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => guard(resize)) : null
    observer?.observe(host)
    guard(resize)

    const drawFrame = () => {
      const current = latestRef.current
      /**
       * THE ANIMATION CLOCK — real wall time, and legitimately so in a replay
       * (#157's audit). Every envelope in the scene is a duration a *person*
       * watches: a pulse's 400–600 ms, a cut's 1.4 s, a mote's 900 ms, the breath's
       * 5.4 s, a camera flight's ease. None of them is a fact about the fleet, so
       * none of them may be scrubbed — putting them on the transport's clock would
       * make the motion budget's own figures a function of the playback speed.
       */
      const real = current.now ?? Date.now()
      /**
       * THE STATE CLOCK — the instant the fleet's *ages* are judged against.
       *
       * Live it is the same number, which is why the fallback is `real` rather
       * than something cleverer. In a replay it is the scrub position, threaded in
       * from `ModeContext` by `scene/index.tsx`, so a recorded session's lanes
       * drift and grey by how old they were *then* rather than by how long ago the
       * recording was made.
       */
      const asOfReal = current.asOf ?? real
      const ctx = canvas.getContext('2d')
      // jsdom has no 2D context. The scene is then simply not drawn — the DOM
      // it lives in still renders, and so does everything around it.
      if (ctx === null) return

      // The pause, in three lines. BOTH of the scene's clocks stop at the instant
      // the control was pressed — every ambient and event animation stops with the
      // first, and every age the picture is drawn from stops with the second,
      // because every one of them is a function of one of these two numbers.
      if (!current.paused) pausedAtRef.current = null
      else if (pausedAtRef.current === null) pausedAtRef.current = { real, asOf: asOfReal }
      const clock = pausedAtRef.current?.real ?? real
      const asOfClock = pausedAtRef.current?.asOf ?? asOfReal

      stepFlight(real)
      current.field.step(clock)

      const mode = motionMode(current)
      const geometry = layoutScene(current.fleet, {
        width,
        height,
        // The state clock: everything `layoutScene` reads this for is an age.
        now: asOfClock,
        // A grow-in keeps the real clock: a thread caught half-way through
        // growing in is a picture of a fleet that does not exist, so one that was
        // already running settles and *then* stops.
        growth: current.settle.progress(real),
        // The cord-cut takes the scene's clock instead, and the difference is not
        // an inconsistency (prd5 ruling 3). A half-grown thread is a *false* fact
        // — that lane's work is shorter than it is. A half-cut one is a true one:
        // this lane is finishing, which it is. And the cut is the loudest thing
        // the scene ever does, so it is the first thing an operator reaching for
        // the pause control wants held still.
        retire: current.retire.progress(current.fleet, clock, mode),
        hideFinished: current.hideFinished,
      })
      geometryRef.current = geometry
      rig.boundsRef.current = contentBounds(geometry)

      const sceneFrame: SceneFrame = {
        fleet: current.fleet,
        geometry,
        field: current.field,
        salience: salienceOf({
          fleet: current.fleet,
          hoverId: current.hoverId,
          selectedId: current.selectedId,
        }),
        now: clock,
        asOf: asOfClock,
        vibrancy: vibrancyOf(current.replaying),
        reducedMotion: current.reducedMotion,
        paused: current.paused,
        breath: breathOf(clock, mode),
      }

      const marks = sceneMarks(sceneFrame)
      if (current.selectedId === MAIN_SELECTION) marks.push(...rootSpotlight(sceneFrame))

      // `paint` owns the transform now, camera and device scale together — the
      // one set at resize is only what a frame that never runs would leave
      // behind.
      paint({ ctx, marks, width, height, camera: rig.cameraRef.current, dpr })
    }

    /** One frame of a zoom-to-fit, driven by the loop that is already running. */
    const stepFlight = (clock: number) => {
      const active = rig.flightRef.current
      if (active === null) return
      const t = (clock - active.startedAt) / active.path.durationMs
      if (t >= 1) rig.flightRef.current = null
      rig.moveTo(active.path.at(t))
    }

    redrawRef.current = pinned ? () => guard(drawFrame) : () => {}

    behavior
      .on('start', (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        // A hand on the canvas cancels a flight; our own frames (which have no
        // source event) must not cancel the flight that is producing them.
        if (event.sourceEvent === null || event.sourceEvent === undefined) return
        rig.flightRef.current = null
        setPanning(event.sourceEvent.type !== 'wheel')
      })
      .on('zoom', (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        const { k, x, y } = event.transform
        rig.cameraRef.current = { k, x, y }
        const bounds = rig.boundsRef.current
        if (bounds !== null) {
          setLost(!isContentVisible(rig.cameraRef.current, rig.viewportRef.current, bounds))
        }
        redrawRef.current()
      })
      .on('end', () => setPanning(false))

    select(canvas).call(behavior)
    // The behavior starts from wherever the camera already is, so a fleet
    // rebuild or a source switch never quietly sends the view home.
    const { k, x, y } = rig.cameraRef.current
    select(canvas).property('__zoom', new ZoomTransform(k, x, y))
    rig.zoomRef.current = behavior

    /**
     * Capture-phase, on the host rather than the canvas, because d3's own
     * mousedown handler calls `stopImmediatePropagation` — a React handler on
     * either element would never see the press.
     *
     * Two jobs: give the scene keyboard focus (which is what scopes the camera
     * keys to it), and stop the middle button from starting the browser's
     * autoscroll while it is panning.
     */
    const onPress = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault()
      host.focus({ preventScroll: true })
    }
    host.addEventListener('mousedown', onPress, true)

    // A pinned clock is a test asking for a still image; running a loop under
    // one would redraw the same frame forever and race every assertion.
    if (pinned) {
      guard(drawFrame)
      return () => {
        host.removeEventListener('mousedown', onPress, true)
        select(canvas).on('.zoom', null)
        observer?.disconnect()
      }
    }

    const tick = () => {
      if (!guard(drawFrame)) return
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      host.removeEventListener('mousedown', onPress, true)
      select(canvas).on('.zoom', null)
      observer?.disconnect()
    }
  // Mirrors the original's `[now, moveTo]`: every other value read inside is a
  // ref (stable identity forever) or `setFailure` (a state setter, which React
  // guarantees is stable), so `rig.moveTo` is the only thing here that could
  // ever actually change and `rig` itself must NOT appear — `useCamera` returns
  // a fresh object every render, and depending on it would tear the loop down
  // and rebuild it (a new d3-zoom behavior, a new ResizeObserver) on every
  // render rather than only when the pinned clock changes.
  }, [now, rig.moveTo])

  return { lost, panning, redraw }
}

/**
 * THE SELECTED ROOT-MASS'S RING (prd6 ruling 5) — the same two hairlines a
 * selected lane's node wears (`marks/node.ts`'s `spotlightMarks`), around the
 * mass instead of around a node.
 *
 * Two things make it the *same* affordance rather than a second vocabulary for
 * the same idea: the geometry (an inner ring at full strength and an outer
 * ghost 5px beyond it, so the thing picked reads as one object) and the way the
 * rest of the picture answers it — `salienceOf` takes the selection as the
 * spotlight, no lane matches `main`, so every lane recedes to `RECEDE` around a
 * mass that keeps all of its brightness. The recession is free; this is the
 * mark that says *where the light went*, which a mass at unchanged brightness
 * cannot say on its own.
 *
 * It breathes with the mass (`frame.breath`) because it is drawn on the mass's
 * rim and a ring that stayed put while the thing inside it moved would read as
 * a second object. Ice, at the same alphas the node's ring uses: this is a
 * pointer, not a state, and the alarm band is not its to spend.
 *
 * It lives here rather than in `marks/` only because #106 owns that directory
 * this wave; it is a mark like any other and belongs beside `rootMarks` when
 * the two waves meet.
 */
function rootSpotlight(frame: SceneFrame): Mark[] {
  const { centre, rootRadius } = frame.geometry
  const radius = rootRadius * frame.breath + 8

  return [0, 5].map((offset) => ({
    kind: 'arc' as const,
    role: 'spotlight' as const,
    laneId: null,
    alarm: false,
    at: centre,
    radius: radius + offset,
    from: 0,
    to: Math.PI * 2,
    width: offset === 0 ? 1.4 : 1,
    ink: ink(ICE_200, offset === 0 ? 0.75 : 0.22),
  }))
}
