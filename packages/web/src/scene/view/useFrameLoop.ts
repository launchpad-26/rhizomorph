import { select } from 'd3-selection'
import { zoom as d3Zoom, ZoomTransform, type D3ZoomEvent } from 'd3-zoom'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { MAIN_SELECTION, type Fleet } from '../../fleet/index.js'
import {
  CLICK_DISTANCE,
  SCALE_EXTENT,
  type Camera,
  contentBounds,
  gestureFilter,
  isContentVisible,
  translateExtentFor,
  wheelDelta,
} from '../camera.js'
import { layoutScene, type SceneGeometry } from '../geometry.js'
import { createScenePainter } from '../gl/index.js'
import type { ViewOrigin } from './hitTest.js'
import {
  breathOf,
  motionMode,
  sceneMarks,
  vibrancyOf,
  type Mark,
  type SceneFrame,
} from '../marks/index.js'
import { allowance } from '../motion.js'
import { ink, paletteFor, type ThemeName } from '../palette.js'
import type { SceneQuality } from '../marks/frame.js'
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
  quality: SceneQuality
  selectedId: string | null
  hoverId: string | null
  reducedMotion: boolean
  paused: boolean
  hideFinished: boolean
  /** The document's theme (`useDocumentTheme`) — which palette the frame paints from. */
  theme: ThemeName
  now?: number
  asOf?: number
  replaying: boolean
}

export interface FrameLoopResult {
  lost: boolean
  /**
   * Redraws when the loop is not running (a pinned clock). A no-op when it is.
   * Stable across renders, so an effect that only wants a redraw on some other
   * change (`hideFinished`) may safely leave it out of its own deps.
   */
  redraw: () => void
  /** The canvas's client-space top-left, kept fresh for `pickAt`. */
  originRef: RefObject<ViewOrigin>
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
/**
 * THE LAST DISPLAY LIST HANDED TO THE PAINTER, and the one instrumentation seam
 * in the scene.
 *
 * It exists because of what ADR-0021 spent. The 2D painter made the picture
 * observable for free: a fake `CanvasRenderingContext2D` recorded every `arc`,
 * `fill` and `fillText`, and the mounted-scene suite asked its questions of that
 * journal — "two hairline rings on the mass's rim", "the same light in the same
 * places a second later". A GPU has no such journal, and a vertex buffer is not
 * one: nobody can read "a spotlight ring" back out of forty thousand floats.
 *
 * So the observable moves one layer up, to the thing those tests were really
 * asking about — the marks, at the instant they were painted. Strictly more
 * faithful than the canvas journal was (it is the picture's own vocabulary rather
 * than a transcript of one renderer's calls), and it costs one assignment a
 * frame. One loop runs per page, so one slot is enough.
 */
let painted: PaintedFrame | null = null

export interface PaintedFrame {
  marks: readonly Mark[]
  camera: Camera
  dpr: number
  width: number
  height: number
}

export function lastPaintedFrame(): PaintedFrame | null {
  return painted
}

/**
 * WHETHER TWO SNAPSHOTS WOULD BUILD THE SAME FRAME — `repaintFrame`'s gate.
 *
 * Deliberately NOT a list of fields: enumerating them was this issue's own
 * first defect. A gate naming `dpr`, `width`, `height` and `theme` — and not
 * the selection, the hover, the quality, the pause, the reduced motion, the
 * replay flag or the fleet — replayed a frame that predated a selection, and
 * under a pinned clock nothing else redraws, so it stayed stale indefinitely.
 * This reads the object's OWN keys, so a field added to `SceneLatestState`
 * tomorrow is compared here without anyone remembering to come and add it.
 *
 * Reference identity was the second form, and it was too strong in the other
 * direction. `SceneView` mints a fresh object literal every render, so *any*
 * render invalidated a frame nothing had actually changed — including
 * `setPanning(true)`, which commits at the start of every drag, so the first
 * mousemove of every real drag missed the repaint path entirely. Shallow
 * equality keeps the property that mattered (no field can be forgotten) and
 * drops the one that cost. #159 has since taken that commit out of the
 * bracket entirely, so a drag no longer arms this at all; the shallow gate
 * stays, because every other React commit still can.
 *
 * The four reference fields (`fleet`, `field`, `settle`, `retire`) compare by
 * identity, which is the conservative direction: a rebuilt fleet invalidates
 * whether or not it says anything new. What that does not catch is one of those
 * four MUTATED IN PLACE with no render — safe today only because every mutation
 * of the three registries happens in an effect (`scene/index.tsx`) that runs
 * after the render which minted the state object holding them. A non-render
 * mutation path added later would have to invalidate here itself.
 */
function sameSceneState(a: SceneLatestState, b: SceneLatestState): boolean {
  if (a === b) return true
  const keys = Object.keys(a) as (keyof SceneLatestState)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
}

/** What the operator is told while the GPU is handing the context back. */
export const CONTEXT_LOST_MESSAGE = 'the graphics context was lost — recovering'

/**
 * What the error boundary is told when this environment can draw but WebGL2
 * was refused (prd-36 S1's *error* state — see `ScenePainter.unavailable`).
 * Thrown rather than set as a failure line: a scene with no GL half has no
 * picture to annotate, and the honest surface is the fleet's own boundary —
 * the list, plus this sentence, once. `FleetSurface.test.tsx`'s stub throws
 * this same message, so the stub and production cannot drift apart again.
 */
export const CANVAS_UNAVAILABLE_MESSAGE =
  'the canvas did not come up — this environment gave a 2D context but refused WebGL2'

export function useFrameLoop(
  hostRef: RefObject<HTMLDivElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  overlayRef: RefObject<HTMLCanvasElement | null>,
  geometryRef: RefObject<SceneGeometry | null>,
  latestRef: RefObject<SceneLatestState>,
  rig: CameraRig,
  setFailure: (message: string | null) => void,
  now: number | undefined,
): FrameLoopResult {
  const [lost, setLost] = useState(false)

  /**
   * The instant the operator pressed pause — **both** of the scene's clocks, while
   * it lasts. Pause holds the picture still, and a picture whose ages went on
   * advancing while its animations were frozen would be a still image quietly
   * drifting outward (#157's split).
   */
  const pausedAtRef = useRef<{ real: number; asOf: number } | null>(null)
  const redrawRef = useRef<() => void>(() => {})
  const redraw = useCallback(() => redrawRef.current(), [])

  /**
   * The canvas's top-left in client coordinates, for `pickAt`.
   *
   * Published rather than measured at the hit test: `pickAt` used to call
   * `getBoundingClientRect()` on every mousemove, and the ResizeObserver below
   * has already read the identical box (the canvas is `inset-0` inside the
   * host, no border, no padding — one box, two elements).
   *
   * A ResizeObserver never fires for a **scroll**, and this is a
   * viewport-relative quantity: the instant any ancestor scrolls, a cached
   * origin is wrong and every hover after it picks the wrong lane, or nothing.
   * That is the trap in the obvious version of this fix, so the scroll listener
   * below is not optional and a law covers it.
   */
  const originRef = useRef<ViewOrigin>({ left: 0, top: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    const overlay = overlayRef.current
    const host = hostRef.current
    if (canvas === null || overlay === null || host === null) return

    let frame = 0
    let width = 0
    let height = 0
    let dpr = 1
    let stopped = false
    /** The `SceneLatestState` the retained frame was built from. See
     * {@link repaintFrame}'s gate — null until the first build, which is why a
     * camera move before one falls through to a full draw. */
    let builtFrom: SceneLatestState | null = null
    /** The scene's two clocks at the last BUILD — the half of the skip gate
     * that is not in `SceneLatestState`. See {@link canSkipBuild}. */
    let builtClock = 0
    let builtAsOf = 0
    /** Whether anything was still growing in at the last BUILD. The grow-in
     * runs on the REAL clock, which a pause does not freeze, so the tick where
     * this flips false is the one tick whose retained frame is stale — see
     * {@link canSkipBuild}. */
    let builtSettling = false
    /** Whether a build is on the stack right now — `repaintFrame`'s reentrancy
     * latch, and the reason a camera flight cannot recurse into one. See the
     * note at the top of `repaintFrame`. */
    let drawing = false
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

    /**
     * The painter, for the life of this effect. It owns the GL context, the
     * shader programs and the overlay's 2D context; a context loss is handled
     * inside it, and the two callbacks are the only part of it the operator ever
     * sees — law 12 applies to the scene's own failures, and a black rectangle
     * with nothing to say is the failure this instrument can least afford.
     */
    const painter = createScenePainter(canvas, overlay, {
      onLost: () => setFailure(CONTEXT_LOST_MESSAGE),
      onRestored: () => setFailure(null),
    })

    // A real environment that refused WebGL2 (an Electron shell without GPU
    // access was the first live case). This throw happens synchronously in the
    // mount effect — inside React's commit, so the fleet surface's error
    // boundary catches it and renders S1's *error* state: the list, plus one
    // honest line, instead of the blank frame prd-36 names as the failure.
    // jsdom never reaches here with `unavailable` true (both contexts null).
    if (painter.unavailable) {
      painter.dispose()
      throw new Error(CANVAS_UNAVAILABLE_MESSAGE)
    }

    const resize = () => {
      const rect = host.getBoundingClientRect()
      originRef.current = { left: rect.left, top: rect.top }
      dpr = Math.min(2, window.devicePixelRatio || 1)
      // Only a ZERO measurement falls back (mid-mount, before layout has run —
      // `useCamera`'s documented intent). This used to be a `Math.max` floor
      // applied on every tick, which quietly rasterised a 420-tall picture
      // into any host shorter than that and let CSS squash it — at prd-32
      // S5's own primary window size the scene host measures ≈330px, so the
      // default experience was ~21% vertical distortion, with the camera's
      // extents and hit-testing computed for a viewport that did not exist.
      width = Math.floor(rect.width) || FALLBACK_WIDTH
      height = Math.floor(rect.height) || FALLBACK_HEIGHT
      rig.viewportRef.current = { width, height }
      behavior.translateExtent(translateExtentFor(rig.viewportRef.current))
      // The backing store only. The element's *size* is CSS (absolutely
      // positioned), so it can never feed back into the panel that contains it —
      // a canvas with a pixel width inside a flexible column will happily push
      // that column wider than the viewport, one resize at a time.
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      // The type layer tracks it exactly: two surfaces at one size, or the labels
      // sit somewhere the picture is not.
      overlay.width = canvas.width
      overlay.height = canvas.height
      painter.resize()
    }

    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => guard(resize)) : null
    observer?.observe(host)
    guard(resize)

    /**
     * Origin only — never `resize()`. A full resize reassigns `canvas.width`,
     * which blanks the drawing buffer; doing that on every scroll event would
     * strobe the picture.
     */
    const measureOrigin = () => {
      const rect = host.getBoundingClientRect()
      originRef.current = { left: rect.left, top: rect.top }
    }
    // Capture, because a scroll event from a scrolling ancestor does not
    // bubble. Passive, because this never calls `preventDefault`.
    window.addEventListener('scroll', measureOrigin, { capture: true, passive: true })
    window.addEventListener('resize', measureOrigin)

    /**
     * ONE BUILT FRAME — and the latch that keeps it the only paint of its tick.
     *
     * The latch is not bookkeeping. `buildAndPaint` steps a live flight before
     * it paints, `stepFlight` moves the camera the only way anything in this
     * scene may (`zoom.transform`, so d3's `__zoom` stays the source of truth),
     * and that arrives straight back in the `zoom` handler — on this call's own
     * stack. `repaintFrame` refuses while it is held, because there is nothing
     * left to answer: the build already running reads `rig.cameraRef.current`
     * AFTER `stepFlight` has moved it, so it paints the very camera the repaint
     * would have.
     *
     * Without it, a flight tick submitted the frame twice — and, once any React
     * commit had landed since the last build, recursed instead: `builtFrom` is
     * assigned at the END of a build, so the gate saw a stale one and called
     * back in here, before the assignment it needed was ever reached. That
     * bottoms out in a `RangeError`, which `guard` turns into a permanent "the
     * scene stopped drawing" — and the arming condition was ordinary, because
     * `setPanning(false)` commits a render at the end of every drag. Drag, then
     * press Fit, and the scene died. That exact sequence no longer arms it
     * (#159); the latch stays, because any other commit since the last build
     * does.
     */
    const drawFrame = () => {
      drawing = true
      try {
        buildAndPaint()
      } finally {
        drawing = false
      }
    }

    const buildAndPaint = () => {
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

      // The pause, in three lines. BOTH of the scene's clocks stop at the instant
      // the control was pressed — every ambient and event animation stops with the
      // first, and every age the picture is drawn from stops with the second,
      // because every one of them is a function of one of these two numbers.
      if (!current.paused) pausedAtRef.current = null
      else if (pausedAtRef.current === null) pausedAtRef.current = { real, asOf: asOfReal }
      const clock = pausedAtRef.current?.real ?? real
      const asOfClock = pausedAtRef.current?.asOf ?? asOfReal

      if (canSkipBuild(current, real, clock, asOfClock)) {
        skipBuild()
        return
      }

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
        // The class's channel gates (motion.ts): reduced motion appears
        // full-length at encoded width and warms in; paused keeps FULL — a
        // half-grown thread is a topology that does not exist, so it settles
        // and then stops.
        growthTravel: allowance('growth', mode).travel,
        growthScale: allowance('growth', mode).scale,
        // Thicken rides the SCENE clock: unlike the grow-in it has no topology
        // to finish, so a pause freezes it with the picture, and a replay's
        // per-source registry initialises every lane at target (only change
        // animates).
        thicken: current.settle.sizes(current.fleet, clock),
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

      const palette = paletteFor(current.theme)
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
        quality: current.quality,
        reducedMotion: current.reducedMotion,
        paused: current.paused,
        breath: breathOf(clock, mode),
        palette,
      }

      const marks = sceneMarks(sceneFrame)
      if (current.selectedId === MAIN_SELECTION) marks.push(...rootSpotlight(sceneFrame))

      // The painter owns the transform, camera and device scale together: the GL
      // half as a uniform, the type layer as a `setTransform`. Recorded first, so
      // the display list is observable even where neither surface exists (jsdom
      // answers `null` for both) — see {@link lastPaintedFrame}.
      const camera = rig.cameraRef.current
      painted = { marks, camera, dpr, width, height }
      // The exact state object this frame was built from — `repaintFrame`'s
      // gate. Effect-local rather than on `painted`, because `painted` is the
      // scene's public instrumentation seam and this is bookkeeping.
      builtFrom = current
      builtClock = clock
      builtAsOf = asOfClock
      builtSettling = current.settle.settling(real)
      // The clear colour follows the palette's own ground, so the picture and
      // the page share one floor in both themes (dark: byte-identical to the
      // old hardcoded BACKDROP). The blend mode follows the palette's carrier:
      // luminance-carried severity lives on a void, where light-material marks
      // genuinely add; presence-carried severity lives on paper, where the same
      // ONE,ONE arithmetic saturates to nothing — so halos composite source-over
      // as ink washes instead (prd-33's ambient-on-light answer).
      painter.paint({
        marks,
        width,
        height,
        camera,
        dpr,
        ground: ink(palette.ground, 1),
        lightBlend: palette.band.carrier === 'presence' ? 'cover' : 'add',
      })
    }

    /**
     * A CAMERA CHANGE, ANSWERED WITHOUT A REBUILD (prd-47 ruling 1).
     *
     * Ruling 1 is ADDITIVE and this is the added half: the model stage stays on
     * the rAF exactly as it was, so ambient motion keeps running through a drag
     * — the picture says everything it said before, it merely answers the hand
     * sooner. Before this, the `zoom` handler under a live clock set the camera
     * ref and painted nothing, so a pan waited for the next rAF's full rebuild.
     *
     * Gated on INPUTS, never on a computed output (the same discipline ruling 2
     * will need): the retained frame may be replayed under a new camera only
     * while every OTHER thing that went into building it is unchanged.
     *
     * That set is larger than it first looks, and enumerating it was this
     * issue's own defect. A frame is built from the whole `SceneLatestState` —
     * the fleet, the selection, the hover, the quality, the pause, the reduced
     * motion, the replay flag and the theme — plus the panel's device geometry.
     * So the gate asks `sameSceneState` rather than naming fields, and the note
     * on it is where that history lives.
     *
     * `dpr`, `width` and `height` stay named because they are NOT in that
     * object: a resize arrives through the ResizeObserver, which changes them
     * without re-rendering React, and `resize()` does not redraw — so under a
     * pinned clock a resize followed by a camera nudge would replay the
     * old-size frame indefinitely without these three.
     *
     * The conservatism is one-directional: a repaint that should have been a
     * rebuild paints a lie, while a refusal costs only what `main` cost — see
     * `fallBackToBuild`, which is where "never worse than `main`" is actually
     * enforced rather than asserted.
     */
    const repaintFrame = () => {
      // The reentrancy latch — see `drawFrame`. A flight's own camera move
      // arrives here on the running build's stack, and that build will paint
      // the moved camera itself.
      if (drawing) return
      const current = latestRef.current
      if (
        painted === null ||
        builtFrom === null ||
        !sameSceneState(builtFrom, current) ||
        painted.dpr !== dpr ||
        painted.width !== width ||
        painted.height !== height
      ) {
        fallBackToBuild()
        return
      }
      const camera = rig.cameraRef.current
      // A gesture that ends where it started, a wheel the extent clamped: the
      // camera did not move, so there is nothing to answer.
      if (
        camera.k === painted.camera.k &&
        camera.x === painted.camera.x &&
        camera.y === painted.camera.y
      ) {
        return
      }
      if (!painter.repaint({ width, height, camera, dpr })) {
        fallBackToBuild()
        return
      }
      // The parity seam moves with the repaint, or it goes stale-and-green: the
      // camera suite reads a frame's camera off this, and a repaint that left it
      // behind would report the camera of the last BUILD forever.
      painted = { ...painted, camera }
    }

    /**
     * WHAT A REFUSED REPAINT COSTS — and why it is not a build under a loop.
     *
     * Under a running loop, nothing. The `zoom` handler has already written the
     * new camera to `rig.cameraRef`, and the rAF that is about to run reads it
     * there — which is precisely what `main` did for every camera move before
     * this issue existed. So a refusal is exactly as fast as not having this
     * path at all, which is the only form in which "never worse than `main`"
     * is true rather than merely claimed.
     *
     * Building here instead was measurably worse than `main`, on the one event
     * this issue exists to answer faster: `setPanning` commits a render at both
     * ends of every drag, so the first mousemove of a real drag found the gate
     * refusing and ran a full `layoutScene` + `sceneMarks` + `buildFrame`
     * synchronously inside the input handler. #159 removed that commit, so the
     * first mousemove of a drag now finds the gate passing; the measurement
     * that chose refusal over building here is unchanged.
     *
     * A PINNED clock has no next frame — `redrawRef` is the only thing that
     * draws under one — so there the build has to happen here or the picture
     * never resolves. That is the replay case the gate was written for, and it
     * is not an input-latency path: nothing is dropping a frame to answer it.
     */
    const fallBackToBuild = () => {
      if (pinned) drawFrame()
    }

    /**
     * WHETHER THE BUILD ITSELF CAN BE SKIPPED (prd-47 ruling 2) — the model
     * stage's own gate, a sibling of `repaintFrame`'s rather than a
     * replacement for it. Gated on INPUTS, never on a computed output: the
     * PRD's rejected-alternatives section names the output form directly
     * ("computing the display list to discover it is identical buys
     * nothing").
     *
     * `buildAndPaint` reads exactly: `real` (through `stepFlight` and
     * `settle.progress`), `clock` and `asOfClock` (through every other
     * pause-frozen read), the whole `SceneLatestState`, the three device
     * terms, and the camera — read only as `painted.camera` and the paint's
     * uniform. The camera is deliberately absent below: ruling 1's premise is
     * that the display list does not read it, so a camera move must not force
     * a rebuild — it forces a SUBMIT, which `skipBuild` performs.
     *
     * `real` enters through exactly two doors, and each gets its own term
     * rather than a `real` term of its own — a `real` term would mean a
     * paused scene never skips, because pausing freezes `clock`, not `real`:
     *
     * - a live flight moves the camera every tick off `real`, so one in
     *   flight must never be skipped past;
     * - the grow-in keeps ITS real clock through a pause on purpose (a thread
     *   caught half-grown is a picture of a topology that does not exist), so
     *   a paused scene with a thread still growing genuinely differs frame to
     *   frame — `settle.settling(real)` is exactly that "still growing" bit.
     *
     * `PulseField.step()` and `SettleRegistry.sizes()` are both mutated on
     * every build this gate skips, and both are read-verified idempotent at a
     * frozen clock (elapsed/`dt` is 0 the second time), so skipping the call
     * leaves each in the state a build would have left it in — `pulses.ts` is
     * off this fence and was read, not changed, to reach that. `L8` is the
     * law that holds it rather than a comment asserting it.
     *
     * `geometryRef.current` and `rig.boundsRef.current` are deliberately left
     * alone by a skip: they were written by the last BUILD, and a skip's
     * whole claim is that nothing which would change them has moved. Hit
     * testing and `isContentVisible` keep working through a paused scene
     * exactly because of that.
     */
    const canSkipBuild = (
      current: SceneLatestState,
      real: number,
      clock: number,
      asOfClock: number,
    ): boolean => {
      if (painted === null || builtFrom === null) return false
      if (clock !== builtClock || asOfClock !== builtAsOf) return false
      if (!sameSceneState(builtFrom, current)) return false
      if (painted.dpr !== dpr || painted.width !== width || painted.height !== height) return false
      // A flight moves the camera every tick off the REAL clock, which a pause
      // does not freeze. Skipping one strands the flight mid-path.
      if (rig.flightRef.current !== null) return false
      // The grow-in also keeps the real clock through a pause, on purpose: a
      // thread caught half-grown is a picture of a topology that does not
      // exist. Past settle it is constant, which is the case ruling 2 is for.
      //
      // BOTH terms, and the second is the one a jump-across-`SETTLE_MS` test
      // cannot see. `settling(real)` alone stops skipping WHILE a thread grows
      // and resumes the instant it stops — but the frame retained at that
      // instant was built one tick EARLIER, at a growth just short of 1, and
      // every tick after it then qualifies to skip. The thread would stay
      // frozen a fraction short of grown for as long as the pause lasted,
      // which is the exact failure keeping the grow-in on the real clock
      // exists to prevent. Refusing while EITHER is true spends one catch-up
      // build on the transition and skips from there.
      if (current.settle.settling(real) || builtSettling) return false
      return true
    }

    const skipBuild = () => {
      const retained = painted
      // `canSkipBuild`'s first line already established `painted !== null`.
      if (retained === null) return
      const camera = rig.cameraRef.current
      // Skip the build, never the submit (ruling 2). `repaint` resubmits the
      // retained Batch under the current camera — the same two submits `paint`
      // makes after its build, one build fewer.
      //
      // `painter.repaint` returns false only when `painter.last === null`,
      // which cannot be true here: `painted !== null` already implies a
      // `paint()` has run and set both. Unreachable in practice; an early
      // return rather than a recursive `buildAndPaint`, which would need a
      // second reentrancy latch.
      if (!painter.repaint({ width, height, camera, dpr })) return
      // The parity seam moves with every submit, or it reports the camera of
      // the last BUILD forever — `repaintFrame` carries the long form.
      painted = { ...retained, camera }
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

    /**
     * The drag cursor, written to the element rather than through React.
     *
     * This is the whole of what `panning` state ever did — its only consumer
     * was `cursorOf` in `SceneView`'s className — and it cost a commit at both
     * ends of every drag. An inline style beats the Tailwind cursor class while
     * it is set and yields back to it when cleared, so `cursor-grab` (space
     * held) and `cursor-pointer` (over a lane) still come from the class, which
     * is where the state that genuinely re-renders already lives.
     *
     * The gesture bracket itself is unchanged: prd-47 lists it under "what
     * already exists (do not rebuild)", and ruling 1's repaint path is written
     * against it.
     */
    const setPanCursor = (panning: boolean) => {
      canvas.style.cursor = panning ? 'grabbing' : ''
    }

    behavior
      .on('start', (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        // A hand on the canvas cancels a flight; our own frames (which have no
        // source event) must not cancel the flight that is producing them.
        if (event.sourceEvent === null || event.sourceEvent === undefined) return
        rig.flightRef.current = null
        setPanCursor(event.sourceEvent.type !== 'wheel')
      })
      .on('zoom', (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        const { k, x, y } = event.transform
        rig.cameraRef.current = { k, x, y }
        const bounds = rig.boundsRef.current
        if (bounds !== null) {
          setLost(!isContentVisible(rig.cameraRef.current, rig.viewportRef.current, bounds))
        }
        guard(repaintFrame)
      })
      .on('end', () => setPanCursor(false))

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
        window.removeEventListener('scroll', measureOrigin, { capture: true })
        window.removeEventListener('resize', measureOrigin)
        select(canvas).on('.zoom', null)
        observer?.disconnect()
        painter.dispose()
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
      window.removeEventListener('scroll', measureOrigin, { capture: true })
      window.removeEventListener('resize', measureOrigin)
      select(canvas).on('.zoom', null)
      observer?.disconnect()
      painter.dispose()
    }
  // Mirrors the original's `[now, moveTo]`: every other value read inside is a
  // ref (stable identity forever) or `setFailure` (a state setter, which React
  // guarantees is stable), so `rig.moveTo` is the only thing here that could
  // ever actually change and `rig` itself must NOT appear — `useCamera` returns
  // a fresh object every render, and depending on it would tear the loop down
  // and rebuild it (a new d3-zoom behavior, a new ResizeObserver) on every
  // render rather than only when the pinned clock changes.
  }, [now, rig.moveTo])

  return { lost, redraw, originRef }
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
    ink: ink(frame.palette.register.data, offset === 0 ? 0.75 : 0.22),
  }))
}
