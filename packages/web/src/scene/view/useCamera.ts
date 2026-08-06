import { select } from 'd3-selection'
import { ZoomTransform, type ZoomBehavior } from 'd3-zoom'
import { useCallback, useRef, type RefObject } from 'react'
import {
  IDENTITY,
  fitCamera,
  flight,
  type Bounds,
  type Camera,
  type Flight,
  type Viewport,
} from '../camera.js'

/**
 * Fallback size for a host measured at zero (mid-mount, before layout has
 * run). Proportioned to the hero slot this now sits in (prd4 ruling 2's
 * `min-h-[55vh]`-ish `SceneSlot`) rather than the compact fixed box (`h-64`)
 * it used to be the fallback for — a zero-rect mount should still read as the
 * centerpiece, not a leftover small panel.
 */
export const FALLBACK_WIDTH = 640
export const FALLBACK_HEIGHT = 420

/** The slice of the scene's live snapshot a camera flight has to consult. */
export interface CameraClock {
  reducedMotion: boolean
  paused: boolean
  now?: number
}

export interface CameraRig {
  cameraRef: RefObject<Camera>
  viewportRef: RefObject<Viewport>
  boundsRef: RefObject<Bounds | null>
  zoomRef: RefObject<ZoomBehavior<HTMLCanvasElement, unknown> | null>
  flightRef: RefObject<{ path: Flight; startedAt: number } | null>
  moveTo: (camera: Camera) => void
  goTo: (camera: Camera) => void
  fit: () => void
  home: () => void
  step: (factor: number) => void
}

/**
 * THE CAMERA'S LIFECYCLE — the navigational half of prd5 ruling 2.
 *
 * `camera.ts` owns every law about what a transform means; `useFrameLoop.ts`
 * owns wiring d3-zoom's gestures to one. This is the third part: the camera's
 * own live state (a ref, because it changes at pointer rate) and the ways
 * anything outside a gesture — a key, a button, a flight — is allowed to move
 * it, which is always through `zoom.transform` so the behavior's own `__zoom`
 * stays the single source of truth (see `moveTo`).
 */
export function useCamera(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  latestRef: RefObject<CameraClock>,
): CameraRig {
  const cameraRef = useRef<Camera>(IDENTITY)
  const viewportRef = useRef<Viewport>({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT })
  const boundsRef = useRef<Bounds | null>(null)
  const zoomRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const flightRef = useRef<{ path: Flight; startedAt: number } | null>(null)

  /**
   * Put the camera somewhere, through d3 rather than around it.
   *
   * Every move — a key, a button, a frame of a flight — goes through
   * `zoom.transform`, so the behavior's own `__zoom` stays the single source of
   * truth. Writing the ref directly instead would work until the next gesture,
   * which would resume from wherever d3 still thought the camera was and snap.
   */
  const moveTo = useCallback(
    (camera: Camera) => {
      const canvas = canvasRef.current
      const behavior = zoomRef.current
      if (canvas === null || behavior === null) return
      behavior.transform(select(canvas), new ZoomTransform(camera.k, camera.x, camera.y))
    },
    [canvasRef],
  )

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
      const { reducedMotion: reduced, paused: held, now: pinned } = latestRef.current
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
    [latestRef, moveTo],
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
  }, [canvasRef])

  return { cameraRef, viewportRef, boundsRef, zoomRef, flightRef, moveTo, goTo, fit, home, step }
}
