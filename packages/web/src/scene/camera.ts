import { interpolateZoom } from 'd3-interpolate'
import type { Point, SceneGeometry } from './geometry.js'

/**
 * THE CAMERA — every law about where the scene is looked at from, as pure
 * functions over a plain `{ k, x, y }`.
 *
 * Nothing here touches a canvas, a DOM node or d3-zoom. That is deliberate:
 * d3-zoom owns the *gestures* (which is why we adopted it — see
 * `docs/research/2026-08-01-obs-prd5-implementation-vehicles.md`), but the laws
 * a reader can be wrong about — "zooming at the pointer leaves the thing under
 * the pointer where it was", "fit frames the whole network", "content that has
 * left the screen is findable again" — are arithmetic, and arithmetic belongs
 * where a test can state it in one line.
 *
 * `Camera` is structurally d3's `ZoomTransform`, so a transform coming out of a
 * gesture is already one of these and needs no adapter.
 *
 * **Two coordinate spaces, and only two.**
 *
 * - **world** — what `geometry.ts` lays out. Its box is always `[0,0] →
 *   [viewport.width, viewport.height]`, because the layout is authored to fill
 *   the panel. The camera never re-flows it; zooming magnifies the picture, it
 *   does not re-draw it at a different size. That is the whole reason a lane
 *   stays at four o'clock (graft g7) no matter how far in you are.
 * - **screen** — CSS pixels from the canvas's top-left corner, which is what a
 *   pointer event reports and what the chrome (the gap voice, these buttons) is
 *   positioned in.
 *
 * `world = (screen - {x,y}) / k` and `screen = world * k + {x,y}`, which is
 * exactly `ctx.setTransform(k, 0, 0, k, x, y)`.
 */

export interface Camera {
  /** Scale. 1 is one world unit per CSS pixel. */
  k: number
  x: number
  y: number
}

export interface Viewport {
  width: number
  height: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const IDENTITY: Camera = { k: 1, x: 0, y: 0 }

/**
 * How far in and out the camera goes.
 *
 * The floor is 0.4 rather than something smaller because below it the scene
 * stops being a network and becomes a smudge — the threads are sub-pixel and
 * every label collides. The ceiling is 6: enough to read a single node's sigil
 * and its cartouche at arm's length, past which the ribbons are just gradients.
 */
export const SCALE_EXTENT: readonly [number, number] = [0.4, 6]

/** One `+`/`-` keypress, and one press of an on-canvas step button. */
export const ZOOM_STEP = 1.4

/**
 * The margin `fit` leaves around the network. Labels are drawn beyond their
 * anchor by however wide the name is, and canvas text cannot be measured
 * without a context, so the padding carries what {@link contentBounds} cannot
 * know rather than the bounds pretending to a precision they do not have.
 */
export const FIT_PADDING = 32

/**
 * Below this much overlap in *either* axis, the network is not on screen in any
 * useful sense and the Recenter affordance appears. A two-pixel sliver at the
 * edge of the panel is not a view of the fleet.
 */
export const VISIBLE_SLIVER = 24

// ── the two spaces ──────────────────────────────────────────────────────────

export function toWorld(camera: Camera, screen: Point): Point {
  return { x: (screen.x - camera.x) / camera.k, y: (screen.y - camera.y) / camera.k }
}

export function toScreen(camera: Camera, world: Point): Point {
  return { x: world.x * camera.k + camera.x, y: world.y * camera.k + camera.y }
}

export function clampScale(k: number): number {
  return Math.max(SCALE_EXTENT[0], Math.min(SCALE_EXTENT[1], k))
}

/**
 * Scale about a fixed point in **screen** space — the law behind zoom-at-the-
 * cursor. The point under `focus` before the zoom is the point under `focus`
 * after it, which is the difference between a camera that feels like a lens and
 * one that feels like it is fighting you.
 *
 * Same arithmetic d3-zoom applies internally (`translate(scale(t, k), p0, p1)`
 * in `d3-zoom/src/zoom.js`); stated here so the law is pinned by a test that
 * does not have to stage a wheel event to ask about it.
 */
export function scaleAbout(camera: Camera, factor: number, focus: Point): Camera {
  const k = clampScale(camera.k * factor)
  const world = toWorld(camera, focus)
  return { k, x: focus.x - world.x * k, y: focus.y - world.y * k }
}

/**
 * How much room the camera has outside the scene's own box, as a multiple of
 * the viewport in each direction.
 *
 * Exactly one viewport of slack is the wrong number, and interestingly so:
 * d3's `constrain` keeps the *viewport* inside the extent, so one viewport of
 * slack lets you pan the network to precisely the edge of the panel and no
 * further. The content is then never quite lost, which sounds like a feature
 * and is really a control that can be held against its stop while the thing it
 * moves sits just off screen. Half a viewport more, and getting lost is a
 * thing that can actually happen — which is what makes Recenter an answer
 * rather than an ornament.
 */
const PAN_SLACK = 1.5

/**
 * How far the camera may be panned, in world coordinates.
 *
 * Generous enough that a hard edge is never what stops an exploratory drag,
 * finite so the scene cannot be flung somewhere it takes a scrollbar to find.
 * Losing the network off the side of the panel is *allowed* — that is what
 * Recenter is for. Being unable to get back is not.
 */
export function translateExtentFor(viewport: Viewport): [[number, number], [number, number]] {
  return [
    [-viewport.width * PAN_SLACK, -viewport.height * PAN_SLACK],
    [viewport.width * (1 + PAN_SLACK), viewport.height * (1 + PAN_SLACK)],
  ]
}

// ── what there is to look at ────────────────────────────────────────────────

/**
 * The box the drawn network occupies in world coordinates: the root-mass, every
 * thread's whole sampled path, every node's label anchor, and every rogue reach.
 *
 * Deliberately not the viewport box. The two differ exactly where it matters —
 * a trespass reaches past the rim, a label hangs off the right-hand nodes — and
 * fitting to the viewport would leave the parts that overflow it cropped, which
 * is the one thing a fit is for.
 */
export function contentBounds(geometry: SceneGeometry): Bounds {
  const bounds: Bounds = {
    minX: geometry.centre.x - geometry.rootRadius,
    minY: geometry.centre.y - geometry.rootRadius,
    maxX: geometry.centre.x + geometry.rootRadius,
    maxY: geometry.centre.y + geometry.rootRadius,
  }

  for (const thread of geometry.threads) {
    for (const point of thread.path) grow(bounds, point)
    grow(bounds, thread.label.anchor)
    if (thread.rogue !== null) for (const point of thread.rogue.path) grow(bounds, point)
    for (const filament of thread.filaments) for (const point of filament.path) grow(bounds, point)
  }

  return bounds
}

function grow(bounds: Bounds, point: Point): void {
  bounds.minX = Math.min(bounds.minX, point.x)
  bounds.minY = Math.min(bounds.minY, point.y)
  bounds.maxX = Math.max(bounds.maxX, point.x)
  bounds.maxY = Math.max(bounds.maxY, point.y)
}

export function boundsCentre(bounds: Bounds): Point {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
}

/**
 * The camera that frames `bounds` inside `viewport`, centred, at the largest
 * scale that still shows all of it — clamped, like every other scale, to
 * {@link SCALE_EXTENT}.
 */
export function fitCamera(bounds: Bounds, viewport: Viewport, padding = FIT_PADDING): Camera {
  // A degenerate box (an empty fleet is a root-mass and nothing else) still has
  // a centre worth pointing at; only its scale is unanswerable, so it keeps 1.
  const width = Math.max(1e-6, bounds.maxX - bounds.minX)
  const height = Math.max(1e-6, bounds.maxY - bounds.minY)
  const room = {
    width: Math.max(1, viewport.width - padding * 2),
    height: Math.max(1, viewport.height - padding * 2),
  }

  const k = clampScale(Math.min(room.width / width, room.height / height))
  const centre = boundsCentre(bounds)
  return { k, x: viewport.width / 2 - centre.x * k, y: viewport.height / 2 - centre.y * k }
}

/**
 * Is any worthwhile part of the network on screen? False is what raises the
 * Recenter button — the camera has been panned somewhere the fleet cannot be
 * seen from, which is a legitimate place to be and a bad place to be stuck.
 */
export function isContentVisible(camera: Camera, viewport: Viewport, bounds: Bounds): boolean {
  const topLeft = toScreen(camera, { x: bounds.minX, y: bounds.minY })
  const bottomRight = toScreen(camera, { x: bounds.maxX, y: bounds.maxY })

  const overlapX = Math.min(bottomRight.x, viewport.width) - Math.max(topLeft.x, 0)
  const overlapY = Math.min(bottomRight.y, viewport.height) - Math.max(topLeft.y, 0)

  // A sliver in one axis is as unreadable as a sliver in both, so both have to
  // clear the bar.
  return overlapX >= VISIBLE_SLIVER && overlapY >= VISIBLE_SLIVER
}

// ── the flight home ─────────────────────────────────────────────────────────

export interface Flight {
  /** How long the flight takes, in ms. 0 when there is nowhere to go. */
  durationMs: number
  /** The camera at `t` in 0–1. */
  at: (t: number) => Camera
}

/**
 * The ceiling on a flight, and the one place we depart from van Wijk.
 *
 * `interpolateZoom` suggests a duration proportional to the arc's length, which
 * for a camera parked in the corner at 6× comes out around 2.5 seconds. That is
 * the right *shape* and the wrong *length*: fit is bound to a keypress, and a
 * key you hold down a two-second animation for stops feeling like a control.
 * The suggestion is kept as the pacing — a short hop is still quicker than a
 * long flight — and capped at the top of the drawer-sized budget.
 */
export const FIT_DURATION_MAX_MS = 420

/**
 * A zoom-to-fit that arcs rather than lerps — van Wijk & Nuij's smooth-zoom
 * path, which is what `d3-interpolate`'s `interpolateZoom` computes and what
 * d3-zoom itself uses for its transitions. Pulling out as it travels and
 * dropping back in keeps the network on screen the whole way, so the fit reads
 * as *going somewhere* rather than as a cut.
 *
 * We drive it from the scene's own rAF loop rather than importing d3-transition
 * (ruling 2): the loop is already running, and a second scheduler animating a
 * canvas the first one paints is a race waiting to be debugged.
 *
 * The view triple is `[centreX, centreY, size]` in world units, and `size` is
 * the viewport's *longer* side — d3-zoom's own convention in
 * `zoom.js/schedule`, so our arc and a d3 transition's arc are the same arc.
 */
export function flight(from: Camera, to: Camera, viewport: Viewport): Flight {
  const size = Math.max(viewport.width, viewport.height)
  const focus: Point = { x: viewport.width / 2, y: viewport.height / 2 }
  const view = (camera: Camera): [number, number, number] => {
    const world = toWorld(camera, focus)
    return [world.x, world.y, size / camera.k]
  }

  const path = interpolateZoom(view(from), view(to))

  return {
    durationMs: Math.min(path.duration, FIT_DURATION_MAX_MS),
    at: (t: number): Camera => {
      if (!(t < 1)) return to
      const [cx, cy, span] = path(Math.max(0, t))
      const k = size / span
      return { k, x: focus.x - cx * k, y: focus.y - cy * k }
    },
  }
}

// ── what a gesture is ───────────────────────────────────────────────────────

/**
 * A wheel notch this big is a mouse, not a pinch. Trackpad pinch arrives as a
 * stream of small ctrlKey wheel deltas; a mouse wheel arrives as one delta of
 * 100 (or three lines).
 */
const MOUSE_NOTCH_DELTA = 40

/**
 * Wheel → scale exponent. d3's default multiplies every ctrlKey wheel by ten,
 * because ctrlKey is how a trackpad pinch is delivered and a pinch's deltas are
 * tiny. On a mouse that same ×10 turns one notch into a 4× jump.
 *
 * React Flow fixes this by applying the boost only on macOS
 * (`@xyflow/system`'s `wheelDelta`, MIT). We take the fix and drop the user-
 * agent sniff: the thing that actually distinguishes a pinch from a notch is
 * the size of the delta, on every platform.
 */
export function wheelDelta(event: WheelEvent): number {
  const unit = event.deltaMode === 1 ? 0.05 : event.deltaMode !== 0 ? 1 : 0.002
  const pinch = event.ctrlKey && Math.abs(event.deltaY) < MOUSE_NOTCH_DELTA
  return -event.deltaY * unit * (pinch ? 10 : 1)
}

/** Left and middle drag pan. Right belongs to the context menu. */
const PAN_BUTTONS: readonly number[] = [0, 1]

/**
 * Which events the camera claims. Adapted from `@xyflow/system`'s
 * `createFilter` (MIT) — specifically its two departures from d3's default
 * filter: the allowed-button list (`panOnDrag.includes(event.button) || ...
 * event.button <= 1`) instead of d3's `!event.button`, and keeping d3's
 * `(!event.ctrlKey || isWheelEvent)` so that ctrl-click still means context
 * menu while ctrl-wheel still means pinch.
 *
 * The one thing we add: a **plain wheel is not ours**. The scene is a panel in
 * a scrolling page, and a canvas that eats the scroll wheel is a canvas you
 * cannot scroll past. Zoom is ctrl/cmd + wheel (which is also how a trackpad
 * pinch arrives), and an unclaimed wheel event is never `preventDefault`ed, so
 * the page scrolls exactly as it did before the camera existed.
 */
export function gestureFilter(event: Event): boolean {
  if (event.type === 'wheel') {
    const wheel = event as WheelEvent
    return wheel.ctrlKey || wheel.metaKey
  }

  const mouse = event as MouseEvent
  if (event.type === 'mousedown' && !PAN_BUTTONS.includes(mouse.button)) return false
  return !mouse.ctrlKey && (mouse.button === undefined || mouse.button <= 1)
}

/**
 * How far a pointer may travel between press and release and still count as a
 * click rather than a pan, in CSS pixels — d3-zoom's `clickDistance`, which is
 * where React Flow resolves the same conflict (`d3ZoomInstance.clickDistance(
 * paneClickDistance)` in `@xyflow/system`'s `XYPanZoom`).
 *
 * Without it, drag-to-pan eats selection outright: d3 suppresses the click
 * after *any* movement, and nobody presses a mouse button without moving it a
 * pixel or two. Four is the width of a hand tremor.
 */
export const CLICK_DISTANCE = 4
