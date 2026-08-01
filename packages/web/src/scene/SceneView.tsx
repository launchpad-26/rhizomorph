import { select } from 'd3-selection'
import { zoom as d3Zoom, ZoomTransform, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Fleet } from '../fleet/index.js'
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
import { layoutScene, type SceneGeometry } from './geometry.js'
import { breathOf, sceneMarks, type SceneFrame } from './marks/index.js'
import { paint } from './paint.js'
import type { PulseField } from './pulses.js'
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
 */

export interface SceneViewProps {
  fleet: Fleet
  field: PulseField
  settle: SettleRegistry
  selectedId: string | null
  onSelect: (laneId: string | null) => void
  /**
   * Test-only clock. Pinned, the loop draws exactly one frame and stops, so a
   * test asserts against a still image rather than racing an interval.
   */
  now?: number
}

/** How close to a node a pointer must be to have picked it, in CSS pixels. */
const HIT_RADIUS = 30

/**
 * Fallback size for a host measured at zero (mid-mount, before layout has
 * run). Proportioned to the hero slot this now sits in (prd4 ruling 2's
 * `min-h-[55vh]`-ish `SceneSlot`) rather than the compact fixed box (`h-64`)
 * it used to be the fallback for — a zero-rect mount should still read as the
 * centerpiece, not a leftover small panel.
 */
const FALLBACK_WIDTH = 640
const FALLBACK_HEIGHT = 420

export function SceneView({ fleet, field, settle, selectedId, onSelect, now }: SceneViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const geometryRef = useRef<SceneGeometry | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

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

  const latest = useRef({ fleet, field, settle, selectedId, hoverId, reducedMotion, now })
  latest.current = { fleet, field, settle, selectedId, hoverId, reducedMotion, now }

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
   * switch off), and under a pinned clock, where there is no loop to fly with
   * and a test is asking for a still image.
   */
  const goTo = useCallback(
    (camera: Camera) => {
      const jump = latest.current.reducedMotion || latest.current.now !== undefined
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
      const clock = current.now ?? Date.now()
      const ctx = canvas.getContext('2d')
      // jsdom has no 2D context. The scene is then simply not drawn — the DOM
      // it lives in still renders, and so does everything around it.
      if (ctx === null) return

      stepFlight(clock)
      current.field.step(clock)

      const geometry = layoutScene(current.fleet, {
        width,
        height,
        now: clock,
        growth: current.settle.progress(clock),
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
        reducedMotion: current.reducedMotion,
        breath: breathOf(clock, current.reducedMotion),
      }

      // `paint` owns the transform now, camera and device scale together — the
      // one set at resize is only what a frame that never runs would leave
      // behind.
      paint({ ctx, marks: sceneMarks(sceneFrame), width, height, camera: cameraRef.current, dpr })
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
   * The nearest node within {@link HIT_RADIUS}, in CSS pixels.
   *
   * The pointer is put back into world coordinates before anything is measured,
   * and the radius is divided by the scale rather than left alone: the tolerance
   * is a property of the hand holding the mouse, so it stays thirty screen
   * pixels at 6× as much as at 0.4×.
   */
  const laneAt = (clientX: number, clientY: number): string | null => {
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
    return best
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
        className={`absolute inset-0 h-full w-full ${cursorOf(panning, grabReady)}`}
        onMouseMove={(event) => setHoverId(laneAt(event.clientX, event.clientY))}
        onMouseLeave={() => setHoverId(null)}
        onClick={(event) => onSelect(laneAt(event.clientX, event.clientY))}
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
 * A grabbing hand while the scene is actually being dragged, an open one while
 * space says it is about to be, and the ordinary pointer the rest of the time —
 * because the rest of the time a click on this canvas selects a lane, and a
 * canvas that permanently advertises "grab me" is a canvas nobody clicks.
 */
function cursorOf(panning: boolean, grabReady: boolean): string {
  if (panning) return 'cursor-grabbing'
  if (grabReady) return 'cursor-grab'
  return 'cursor-default'
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

  return (
    <p className="sr-only" data-testid="scene-summary">
      {`${fleet.lanes.length} lanes threaded to ${fleet.root.mainBranch ?? 'main'}. `}
      {flagged.length === 0
        ? 'None flagged.'
        : flagged
            .map((lane) => `${lane.label}: ${lane.pathologies.map((p) => p.kind).join(', ')}`)
            .join('; ')}
    </p>
  )
}
