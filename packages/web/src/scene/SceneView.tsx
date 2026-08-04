import { select } from 'd3-selection'
import { zoom as d3Zoom, ZoomTransform, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MAIN_SELECTION, type Fleet } from '../fleet/index.js'
import {
  CLICK_DISTANCE,
  IDENTITY,
  SCALE_EXTENT,
  ZOOM_STEP,
  contentBounds,
  fitCamera,
  flight,
  gestureFilter,
  isContentVisible,
  toWorld,
  translateExtentFor,
  wheelDelta,
  type Bounds,
  type Camera,
  type Flight,
  type Viewport,
} from './camera.js'
import { useScenePref } from '../app/panelPrefs.js'
import { layoutScene, type SceneGeometry } from './geometry.js'
import {
  breathOf,
  motionMode,
  sceneMarks,
  vibrancyOf,
  type Mark,
  type SceneFrame,
} from './marks/index.js'
import { paint } from './paint.js'
import { ICE_200, ink } from './palette.js'
import type { PulseField } from './pulses.js'
import { isRetired, type RetireRegistry } from './retire.js'
import { salienceOf } from './salience.js'
import type { SettleRegistry } from './settle.js'

/**
 * The canvas host: the frame loop, device-pixel scaling, the camera, hit
 * testing, and the reduced-motion query. Nothing visual is decided here — the
 * picture is `sceneMarks(frame)` and the drawing is `paint`.
 *
 * The loop runs continuously because two things are genuinely continuous: a
 * node's drift outward as its lane goes quiet, and the root-mass's breath. With
 * nothing happening, both are imperceptible and the network is still — which is
 * the point. Stillness is information.
 *
 * Everything the loop reads is taken from a ref rather than from the closure, so
 * a fleet rebuild once a second never tears down and rebuilds the animation.
 *
 * **The camera** (prd5 ruling 2) is d3-zoom's, and only the gestures are: the
 * behavior owns pointer and wheel handling and hands us a transform, `camera.ts`
 * owns every law about what that transform means, and this file owns the wiring
 * between them. The transform is kept in a ref rather than in state because it
 * changes at pointer rate and the only thing that has to re-render when it does
 * is one button.
 *
 * **The pause control** (prd5 ruling 4) is the other thing wired here, and it is
 * not a nicety: WCAG 2.2.2 is Level A, it covers any moving content that starts
 * on its own and runs past five seconds, and a canvas that breathes for ever is
 * exactly that. The mechanism is one line of arithmetic — while paused the scene
 * **holds its clock still** — and that is deliberately the whole of it. Every
 * ambient and event animation in `marks/` is a function of `now`, so freezing
 * `now` freezes all of them at once, including any added later by somebody who
 * never read this comment. What the frozen clock deliberately does *not* stop is
 * structural motion: a thread half-way through growing in is a picture of a
 * topology that does not exist, so grow-in keeps its real clock and settles.
 *
 * The loop itself keeps running while paused, because panning, hovering and
 * resizing still have to produce frames. What stops is the *picture changing*,
 * which is what the success criterion is about and what the operator asked for.
 */

export interface SceneViewProps {
  fleet: Fleet
  field: PulseField
  settle: SettleRegistry
  /** Which lanes have left the network, and how far along their cut is. */
  retire: RetireRegistry
  selectedId: string | null
  onSelect: (laneId: string | null) => void
  /**
   * Test-only clock. Pinned, the loop draws exactly one frame and stops, so a
   * test asserts against a still image rather than racing an interval.
   */
  now?: number
  /**
   * THE STATE CLOCK (#157) — the instant the scene should judge the fleet's ages
   * against. Absent means "the same instant it is animating at", which is exactly
   * right live and exactly wrong in a replay; `scene/index.tsx` supplies the scrub
   * position for the replay case.
   */
  asOf?: number
  /**
   * Whether this frame is a performance of history rather than a live instrument.
   * The only thing it changes is `frame.vibrancy` — see `REPLAY_VIBRANCY`.
   */
  replaying?: boolean
}

/** How close to a node a pointer must be to have picked it, in CSS pixels. */
const HIT_RADIUS = 30

/**
 * How far outside the root-mass's own rim still counts as having clicked it, in
 * CSS pixels (prd6 ruling 5).
 *
 * Small, unlike {@link HIT_RADIUS}, and for the opposite reason: a node is a
 * ~10px lens that needs a generous catchment to be clickable at all, while the
 * mass is the largest object in the picture and needs only the slack a hand
 * aiming at an edge asks for. Both are screen quantities — divided by the scale
 * at the hit test, so the tolerance is thirty (or eight) *pixels* at 6× as much
 * as at 0.4×.
 */
const ROOT_HIT_SLACK = 8

/**
 * Fallback size for a host measured at zero (mid-mount, before layout has
 * run). Proportioned to the hero slot this now sits in (prd4 ruling 2's
 * `min-h-[55vh]`-ish `SceneSlot`) rather than the compact fixed box (`h-64`)
 * it used to be the fallback for — a zero-rect mount should still read as the
 * centerpiece, not a leftover small panel.
 */
const FALLBACK_WIDTH = 640
const FALLBACK_HEIGHT = 420

export function SceneView({
  fleet,
  field,
  settle,
  retire,
  selectedId,
  onSelect,
  now,
  asOf,
  replaying = false,
}: SceneViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const geometryRef = useRef<SceneGeometry | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [paused, setPaused] = useState(false)
  const [hideFinished, setHideFinished] = useScenePref('hideFinished')
  const [failure, setFailure] = useState<string | null>(null)
  /**
   * The instant the operator pressed pause — **both** of the scene's clocks, while
   * it lasts. Pause holds the picture still, and a picture whose ages went on
   * advancing while its animations were frozen would be a still image quietly
   * drifting outward (#157's split).
   */
  const pausedAtRef = useRef<{ real: number; asOf: number } | null>(null)

  // The camera's own live state. `cameraRef` is what the loop paints through;
  // the two booleans are the only parts React has to know about, and both flip
  // rarely enough to be worth a render.
  const cameraRef = useRef<Camera>(IDENTITY)
  const viewportRef = useRef<Viewport>({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT })
  const boundsRef = useRef<Bounds | null>(null)
  const zoomRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const flightRef = useRef<{ path: Flight; startedAt: number } | null>(null)
  /** Redraws when the loop is not running (a pinned clock). A no-op when it is. */
  const redrawRef = useRef<() => void>(() => {})
  const [lost, setLost] = useState(false)
  const [panning, setPanning] = useState(false)
  const [grabReady, setGrabReady] = useState(false)

  const latest = useRef({
    fleet,
    field,
    settle,
    retire,
    selectedId,
    hoverId,
    reducedMotion,
    paused,
    hideFinished,
    now,
    asOf,
    replaying,
  })
  latest.current = {
    fleet,
    field,
    settle,
    retire,
    selectedId,
    hoverId,
    reducedMotion,
    paused,
    hideFinished,
    now,
    asOf,
    replaying,
  }

  useEffect(() => {
    // `matchMedia` is absent in some test environments; its absence means "no
    // stated preference", which is the same as not reducing motion.
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(query.matches)
    const onChange = () => setReducedMotion(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  /**
   * Put the camera somewhere, through d3 rather than around it.
   *
   * Every move — a key, a button, a frame of a flight — goes through
   * `zoom.transform`, so the behavior's own `__zoom` stays the single source of
   * truth. Writing the ref directly instead would work until the next gesture,
   * which would resume from wherever d3 still thought the camera was and snap.
   */
  const moveTo = useCallback((camera: Camera) => {
    const canvas = canvasRef.current
    const behavior = zoomRef.current
    if (canvas === null || behavior === null) return
    behavior.transform(select(canvas), new ZoomTransform(camera.k, camera.x, camera.y))
  }, [])

  /**
   * Fly to a camera, or jump to it.
   *
   * It jumps under `prefers-reduced-motion` (a camera flight is the largest
   * movement in the instrument, so it is the first thing that preference should
   * switch off), while motion is paused (an operator who has asked the scene to
   * stop moving has asked for all of it), and under a pinned clock, where there
   * is no loop to fly with and a test is asking for a still image.
   */
  const goTo = useCallback(
    (camera: Camera) => {
      const { reducedMotion: reduced, paused: held, now: pinned } = latest.current
      const jump = reduced || held || pinned !== undefined
      if (jump) {
        flightRef.current = null
        moveTo(camera)
        return
      }

      const path = flight(cameraRef.current, camera, viewportRef.current)
      if (path.durationMs <= 0) {
        flightRef.current = null
        moveTo(camera)
        return
      }
      // LEGITIMATELY REAL TIME (#157's audit). A camera flight is a tween across
      // the operator's own screen over `path.durationMs` — it is a fact about the
      // hand that pressed Fit, not about the fleet, and it is stepped by `real`
      // rather than by the scene's clock for the same reason. A replay scrubbing
      // must not scrub somebody's zoom-to-fit.
      flightRef.current = { path, startedAt: Date.now() }
    },
    [moveTo],
  )

  const fit = useCallback(() => {
    const bounds = boundsRef.current
    if (bounds === null) return
    goTo(fitCamera(bounds, viewportRef.current))
  }, [goTo])

  const home = useCallback(() => goTo(IDENTITY), [goTo])

  const step = useCallback((factor: number) => {
    const canvas = canvasRef.current
    const behavior = zoomRef.current
    if (canvas === null || behavior === null) return
    flightRef.current = null
    // No focal point: a keyed or clicked step zooms about the middle of the
    // panel, because there is no pointer to zoom at.
    behavior.scaleBy(select(canvas), factor)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (canvas === null || host === null) return

    let frame = 0
    let width = 0
    let height = 0
    let dpr = 1
    let stopped = false
    const pinned = latest.current.now !== undefined

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
      viewportRef.current = { width, height }
      behavior.translateExtent(translateExtentFor(viewportRef.current))
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
      const current = latest.current
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
      boundsRef.current = contentBounds(geometry)

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
      paint({ ctx, marks, width, height, camera: cameraRef.current, dpr })
    }

    /** One frame of a zoom-to-fit, driven by the loop that is already running. */
    const stepFlight = (clock: number) => {
      const active = flightRef.current
      if (active === null) return
      const t = (clock - active.startedAt) / active.path.durationMs
      if (t >= 1) flightRef.current = null
      moveTo(active.path.at(t))
    }

    redrawRef.current = pinned ? () => guard(drawFrame) : () => {}

    behavior
      .on('start', (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        // A hand on the canvas cancels a flight; our own frames (which have no
        // source event) must not cancel the flight that is producing them.
        if (event.sourceEvent === null || event.sourceEvent === undefined) return
        flightRef.current = null
        setPanning(event.sourceEvent.type !== 'wheel')
      })
      .on('zoom', (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        const { k, x, y } = event.transform
        cameraRef.current = { k, x, y }
        const bounds = boundsRef.current
        if (bounds !== null) {
          setLost(!isContentVisible(cameraRef.current, viewportRef.current, bounds))
        }
        redrawRef.current()
      })
      .on('end', () => setPanning(false))

    select(canvas).call(behavior)
    // The behavior starts from wherever the camera already is, so a fleet
    // rebuild or a source switch never quietly sends the view home.
    const { k, x, y } = cameraRef.current
    select(canvas).property('__zoom', new ZoomTransform(k, x, y))
    zoomRef.current = behavior

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

    // A pinned clock is a test asking for a still image; running a loop under it
    // would redraw the same frame forever and race every assertion.
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
  }, [now, moveTo])

  /**
   * A preference that changes the picture has to produce a frame. The running
   * loop would pick it up on its own within 16 ms; a *pinned* clock draws once
   * and stops, so under one this is the only thing that redraws — which is what
   * makes the toggle testable against a still image.
   */
  useEffect(() => {
    redrawRef.current()
  }, [hideFinished])

  /**
   * What is under the pointer: the nearest node within {@link HIT_RADIUS}, the
   * root-mass ({@link MAIN_SELECTION}) when the pointer is on the mass itself,
   * or null.
   *
   * The pointer is put back into world coordinates before anything is measured,
   * and every radius is divided by the scale rather than left alone: the
   * tolerance is a property of the hand holding the mouse, so it stays thirty
   * screen pixels at 6× as much as at 0.4×.
   *
   * **Lanes first, the mass second.** They can overlap — a lane whose node has
   * not drifted out yet sits close in against the mass, and at the far end of a
   * zoom-out everything is close to everything. A node is the smaller, more
   * specific target and the one an operator aiming at it meant; the mass is
   * what is left when they were not aiming at a lane at all.
   */
  const pickAt = (clientX: number, clientY: number): string | null => {
    const geometry = geometryRef.current
    const canvas = canvasRef.current
    if (geometry === null || canvas === null) return null

    const camera = cameraRef.current
    const rect = canvas.getBoundingClientRect()
    const at = toWorld(camera, { x: clientX - rect.left, y: clientY - rect.top })

    let best: string | null = null
    let bestDistance = HIT_RADIUS / camera.k
    for (const thread of geometry.threads) {
      const distance = Math.hypot(thread.node.x - at.x, thread.node.y - at.y)
      if (distance < bestDistance) {
        bestDistance = distance
        best = thread.laneId
      }
    }
    if (best !== null) return best

    // MAIN was the one thing on screen that could not be clicked (prd6 ruling
    // 5). The mass is drawn from `geometry.rootRadius` about `geometry.centre`,
    // both world quantities, so the same two numbers that draw it catch the
    // pointer — nothing here re-derives where the mass is.
    const toCentre = Math.hypot(geometry.centre.x - at.x, geometry.centre.y - at.y)
    return toCentre <= geometry.rootRadius + ROOT_HIT_SLACK / camera.k ? MAIN_SELECTION : null
  }

  /**
   * The camera's keys, scoped to a focused scene.
   *
   * They have to be scoped: `1` already means "switch to the live stream"
   * everywhere else on the page (`StreamContext`'s fixture keys), and a
   * viewport control that hijacks a global one from across the page is worse
   * than a viewport control nobody found. Focus is the scope — click the scene
   * or tab to it — and the keys the camera claims stop propagating so the
   * global handler never sees them.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return

    const claimed = () => {
      event.preventDefault()
      event.stopPropagation()
    }

    switch (event.key) {
      case '1':
        claimed()
        return fit()
      case '0':
        claimed()
        return home()
      case '+':
      case '=':
        claimed()
        return step(ZOOM_STEP)
      case '-':
      case '_':
        claimed()
        return step(1 / ZOOM_STEP)
      case ' ':
        // Held space is the pan modifier everywhere else it exists; here drag
        // already pans, so all it has to do is say so — and not scroll the page
        // out from under the scene while it is being said.
        claimed()
        return setGrabReady(true)
      default:
        return
    }
  }

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (event.key === ' ') setGrabReady(false)
      }}
      onBlur={() => setGrabReady(false)}
      className="relative h-full w-full overflow-hidden bg-ice-1000 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ice-700"
    >
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full ${cursorOf(panning, grabReady, hoverId !== null)}`}
        onMouseMove={(event) => setHoverId(pickAt(event.clientX, event.clientY))}
        onMouseLeave={() => setHoverId(null)}
        onClick={(event) => onSelect(pickAt(event.clientX, event.clientY))}
      />
      <MotionControl paused={paused} onToggle={() => setPaused((held) => !held)} />
      <FinishedControl
        hidden={hideFinished}
        finished={fleet.lanes.filter(isRetired).length}
        onToggle={() => setHideFinished((hide) => !hide)}
      />
      <CameraControls
        lost={lost}
        reducedMotion={reducedMotion}
        onFit={fit}
        onHome={home}
        onIn={() => step(ZOOM_STEP)}
        onOut={() => step(1 / ZOOM_STEP)}
      />
      {failure !== null && (
        <p
          role="status"
          className="absolute inset-x-0 bottom-0 px-3 py-2 text-center text-[10px] uppercase tracking-widest text-broken"
        >
          {`scene stopped drawing — ${failure} — the panels are unaffected`}
        </p>
      )}
      <SceneSummary fleet={fleet} />
    </div>
  )
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

/**
 * A grabbing hand while the scene is actually being dragged, an open one while
 * space says it is about to be, and the ordinary pointer the rest of the time —
 * because the rest of the time a click on this canvas selects a lane, and a
 * canvas that permanently advertises "grab me" is a canvas nobody clicks.
 *
 * The one exception is a pointer that is actually *over* something: a hovered
 * node or the root-mass gets the hand, which is how a canvas — the one surface
 * in the instrument that cannot advertise its own targets in markup — says that
 * this pixel does something and the one beside it does not.
 */
function cursorOf(panning: boolean, grabReady: boolean, overTarget: boolean): string {
  if (panning) return 'cursor-grabbing'
  if (grabReady) return 'cursor-grab'
  return overTarget ? 'cursor-pointer' : 'cursor-default'
}

interface MotionControlProps {
  paused: boolean
  onToggle: () => void
}

/**
 * THE PAUSE CONTROL (prd5 ruling 4) — WCAG 2.2.2, Level A.
 *
 * Any content that moves on its own, runs longer than five seconds and sits
 * beside other content needs a way to stop it. The scene breathes for as long as
 * it is open, so without this button the whole instrument is a Level A failure
 * however careful the rest of the motion work is. It is a real `<button>` in the
 * document, so it is in the tab order and answers Enter and Space for free —
 * no key of its own, because the scene's keys are scoped to a focused canvas and
 * an accessibility control that only works once you have found the canvas is not
 * one.
 *
 * Paused, it *says so* rather than only looking different: the state is the
 * point, and a stopped scene with no words on it is indistinguishable from a
 * quiet fleet — which is the one confusion this instrument can least afford.
 * `aria-pressed` carries the same fact to a screen reader.
 *
 * It sits top-left, the one corner nothing else claims: the camera cluster owns
 * bottom-right and the gap voice is painted into the bottom-left gutter, and a
 * control that covered law 12's caveats would be buying accessibility with
 * honesty. Ice, never amber — amber means needs-you in this instrument.
 */
function MotionControl({ paused, onToggle }: MotionControlProps) {
  return (
    <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-2">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={paused}
        data-testid="scene-motion-pause"
        title={paused ? 'Let the scene move again' : 'Freeze the scene’s own motion'}
        className={`pointer-events-auto rounded border px-2 py-1 text-[10px] uppercase leading-none tracking-wide backdrop-blur-sm transition-[transform,color,border-color] duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600 active:scale-[0.97] ${
          paused
            ? 'border-ice-600 bg-ice-900/90 text-ice-100'
            : 'border-ice-850 bg-ice-950/80 text-ice-400 hover:border-ice-600 hover:text-ice-200'
        }`}
      >
        {paused ? 'Resume motion' : 'Pause motion'}
      </button>
      {paused && (
        <span
          role="status"
          data-testid="scene-motion-state"
          className="text-[10px] uppercase tracking-widest text-ice-300"
        >
          Motion paused
        </span>
      )}
    </div>
  )
}

interface FinishedControlProps {
  hidden: boolean
  /** How many lanes have left the network — what the toggle is a toggle over. */
  finished: number
  onToggle: () => void
}

/**
 * THE HIDE-FINISHED TOGGLE (prd10 ruling 16) — **load-bearing** since the network
 * started persisting.
 *
 * Finished lanes are visible by default and this button is the only thing that
 * changes that. It always was, but it used to share the work: prd5's cord-cut
 * shrank a landed lane to a stub and prd10 ruling 2 then erased even that, so the
 * field emptied itself and the toggle was a convenience. Ruling 13 took both away
 * and ruling 16 names the consequence in as many words — *"the existing HIDE
 * FINISHED control becomes load-bearing and must stay obvious"* — because it is
 * now the only thing standing between a long session and a full canvas. The
 * hierarchy (thin, still, behind) is what keeps the full canvas readable; this is
 * what the operator reaches for when they want it empty anyway.
 *
 * Three details it would be easy to get wrong:
 *
 * - **It carries its own count.** "Hidden ≠ gone" is only true if the operator can
 *   still see *that* something is hidden, so the number of finished lanes is on
 *   the button whichever way it is set. A filter that hides its own effect is a
 *   filter that silently makes the picture a lie, which is law 12's whole subject.
 * - **It looks pressed when it is on**, borrowing the pause control's exact
 *   emphasis rather than inventing a second vocabulary for "this control is
 *   currently changing what you see".
 * - **It fades rather than mounting.** On a fleet with nothing finished there is
 *   nothing to hide and the control has nothing to say, but a button that
 *   appears the instant a lane lands would pop into view at exactly the moment
 *   the operator's eye is on the cut. Same treatment, and the same reason, as
 *   `Recenter` below.
 *
 * Top-right: the one corner nothing else claims. Pause owns top-left, the camera
 * owns bottom-right, and the gap voice is painted into the bottom-left gutter.
 */
function FinishedControl({ hidden, finished, onToggle }: FinishedControlProps) {
  const has = finished > 0

  return (
    <div className="pointer-events-none absolute right-2 top-2">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={hidden}
        aria-hidden={!has}
        tabIndex={has ? 0 : -1}
        data-testid="scene-hide-finished"
        title={
          hidden
            ? 'Show the lanes that have finished — they are still in the fleet table either way'
            : 'Hide the strands finished lanes leave behind'
        }
        className={`pointer-events-auto rounded border px-2 py-1 text-[10px] uppercase leading-none tracking-wide backdrop-blur-sm transition-[opacity,transform,color,border-color] duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600 active:scale-[0.97] ${
          has ? 'opacity-100' : 'pointer-events-none opacity-0'
        } ${
          hidden
            ? 'border-ice-600 bg-ice-900/90 text-ice-100'
            : 'border-ice-850 bg-ice-950/80 text-ice-400 hover:border-ice-600 hover:text-ice-200'
        }`}
      >
        {`${hidden ? 'Show' : 'Hide'} finished · ${finished}`}
      </button>
    </div>
  )
}

interface CameraControlsProps {
  lost: boolean
  reducedMotion: boolean
  onFit: () => void
  onHome: () => void
  onIn: () => void
  onOut: () => void
}

/**
 * The camera's chrome: one cluster, bottom-right, opposite the gap voice.
 *
 * Recenter is always mounted and transitions its own opacity rather than being
 * added and removed — the state it reports flips as fast as a drag, and a
 * mount/unmount cycle at that rate cannot be interrupted mid-fade, while a
 * transition retargets from wherever it got to.
 *
 * It is also deliberately *not* amber. Amber means needs-you in this instrument
 * and means nothing else anywhere in it (theme.css); a viewport control that
 * borrows the alarm palette to get itself noticed is spending a colour the
 * fleet needs.
 */
function CameraControls({ lost, reducedMotion, onFit, onHome, onIn, onOut }: CameraControlsProps) {
  return (
    <div className="pointer-events-none absolute bottom-2 right-2 flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={onFit}
        data-testid="scene-recenter"
        aria-hidden={!lost}
        tabIndex={lost ? 0 : -1}
        className={`pointer-events-auto rounded border border-ice-700 bg-ice-900/90 px-2 py-1 text-[10px] uppercase tracking-wide text-ice-100 backdrop-blur-sm transition-[opacity,transform] duration-200 ease-out hover:border-ice-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600 active:scale-[0.97] ${
          lost
            ? 'scale-100 opacity-100'
            : `pointer-events-none opacity-0 ${reducedMotion ? '' : 'scale-95'}`
        }`}
      >
        Recenter
      </button>
      <div className="pointer-events-auto flex items-center gap-1">
        <CameraButton onClick={onOut} label="Zoom out" hint="−">
          −
        </CameraButton>
        <CameraButton onClick={onIn} label="Zoom in" hint="+">
          +
        </CameraButton>
        <CameraButton onClick={onFit} label="Zoom to fit" hint="1">
          Fit
        </CameraButton>
        <CameraButton onClick={onHome} label="Reset the camera" hint="0">
          Reset
        </CameraButton>
      </div>
    </div>
  )
}

interface CameraButtonProps {
  onClick: () => void
  /** What it does, for a reader who cannot see the glyph. */
  label: string
  /** The key that does the same thing, named in the tooltip. */
  hint: string
  children: React.ReactNode
}

/**
 * Quiet by default and legible on hover: these sit over the picture, and the
 * picture is the point. The press scale is the only motion — 160ms of ease-out
 * on `transform` alone, so the button answers the finger before the camera has
 * finished moving.
 */
function CameraButton({ onClick, label, hint, children }: CameraButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={`${label} (${hint})`}
      className="min-w-7 rounded border border-ice-850 bg-ice-950/80 px-1.5 py-1 text-[10px] uppercase leading-none tracking-wide text-ice-400 backdrop-blur-sm transition-[transform,color,border-color] duration-150 ease-out hover:border-ice-600 hover:text-ice-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ice-600 active:scale-[0.97]"
    >
      {children}
    </button>
  )
}

/**
 * The scene in words, for anything that cannot read a canvas — a screen reader,
 * and every test that needs to know the picture was built rather than what it
 * looks like. Not a legend: the encoding is meant to be learnable without one
 * (ruling 21), and this is never shown to a sighted reader.
 *
 * Camera-independent by design: where the lens happens to be pointed is not a
 * fact about the fleet, and a summary that changed when somebody panned would
 * be reporting the operator rather than the work.
 */
function SceneSummary({ fleet }: { fleet: Fleet }) {
  const flagged = fleet.lanes.filter((lane) => lane.pathologies.length > 0)
  // The words carry the topology, and under ruling 13 the topology is that every
  // lane — working or finished — is still threaded to the mass. A reader who
  // cannot see the canvas used to be told that finished lanes had been "cut
  // loose"; they have not been, and the summary says what the picture says.
  const finished = fleet.lanes.filter(isRetired).length
  const living = fleet.lanes.length - finished

  return (
    <p className="sr-only" data-testid="scene-summary">
      {`${living} lanes threaded to ${fleet.root.mainBranch ?? 'main'}. `}
      {finished === 0 ? '' : `${finished} finished, still threaded. `}
      {flagged.length === 0
        ? 'None flagged.'
        : flagged
            .map((lane) => `${lane.label}: ${lane.pathologies.map((p) => p.kind).join(', ')}`)
            .join('; ')}
    </p>
  )
}
