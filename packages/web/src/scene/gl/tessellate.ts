import type { Point } from '../geometry.js'
import { isLinear, type Paint } from '../marks/index.js'
import type { Ink } from '../palette.js'
import { type Batch, type Colour, FLAT } from './batch.js'

/**
 * GEOMETRY → TRIANGLES. Pure, and deliberately so: this is the half of the
 * painter that used to be unreachable under test, and none of it touches a GPU.
 */

export function rgba(ink: Ink): Colour {
  return [ink.rgb[0] / 255, ink.rgb[1] / 255, ink.rgb[2] / 255, ink.alpha]
}

/**
 * A point's colour under a paint — the reduced-motion flow ramp, evaluated per
 * vertex instead of by a `CanvasGradient` rebuilt per ribbon per frame.
 */
export function paintAt(paint: Paint, at: Point): Colour {
  if (!isLinear(paint)) return rgba(paint)
  const dx = paint.to.x - paint.from.x
  const dy = paint.to.y - paint.from.y
  const span = dx * dx + dy * dy
  const t =
    span === 0
      ? 0
      : clamp01(((at.x - paint.from.x) * dx + (at.y - paint.from.y) * dy) / span)

  const stops = paint.stops
  if (stops.length === 0) return [0, 0, 0, 0]
  let lo = stops[0] as (typeof stops)[number]
  let hi = stops[stops.length - 1] as (typeof stops)[number]
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i] as (typeof stops)[number]
    const b = stops[i + 1] as (typeof stops)[number]
    if (t >= a.at && t <= b.at) {
      lo = a
      hi = b
      break
    }
  }
  const width = hi.at - lo.at
  const f = width === 0 ? 0 : (t - lo.at) / width
  const mix = (a: number, b: number): number => a + (b - a) * f
  return [
    mix(lo.ink.rgb[0], hi.ink.rgb[0]) / 255,
    mix(lo.ink.rgb[1], hi.ink.rgb[1]) / 255,
    mix(lo.ink.rgb[2], hi.ink.rgb[2]) / 255,
    mix(lo.ink.alpha, hi.ink.alpha),
  ]
}

/**
 * A RIBBON'S OUTLINE, ZIPPED — the tessellation that keeps `ribbon.ts`'s caps.
 *
 * The spike built triangle strips off the mark's **spine** and its root/tip
 * widths. That is the fast path and it throws away three things the encoding
 * depends on: the pinches that sever a frozen lane, the dashes that make the
 * severing legible, and the rounded caps `perfect-freehand` inserts wherever the
 * direction reverses past 90°. A ribbon rebuilt from `widthRoot`/`widthTip` is a
 * continuous stripe whatever the width profile said, so FROZEN would have been
 * drawn as a healthy thread.
 *
 * So this fills `mark.outline` — the polygons `paint.ts` filled, unchanged —
 * rather than re-deriving them. A general triangulator would cost O(n²) over
 * 32k outline vertices a frame; this costs O(n), because a stroke outline is not
 * a general polygon. It is **two chains from the same end**: `getStroke` returns
 * the left side forward, the end cap, the right side backward, and the start cap,
 * so vertex 0 and vertex n−1 sit either side of the start cap and the two walks
 * from there both run to the far end.
 *
 * The zip advances whichever chain is behind **in arc length**, which is what
 * makes it robust to the two sides carrying different vertex counts (they always
 * do — `getStroke` drops points independently per side). Caps are consumed by
 * whichever chain reaches them, fanning against the opposite side.
 */
export function zip(batch: Batch, polygon: readonly Point[], paint: Paint): void {
  const n = polygon.length
  if (n < 3) return

  // A flat paint is one colour for the whole polygon, and all but one ribbon in
  // the scene carries one. Resolving it once rather than per vertex is worth
  // saying out loud because it is a third of the build: this runs tens of
  // thousands of times a frame, and `paintAt` returns a fresh array each call.
  const flat = isLinear(paint) ? null : rgba(paint)
  const gap = (p: Point, q: Point): number => Math.hypot(q.x - p.x, q.y - p.y)

  // The opening rib is the edge from the last vertex to the first — across the
  // start cap, which is where the two chains part company.
  let a = 0
  let b = n - 1
  let ahead = 0
  let behind = gap(polygon[n - 1] as Point, polygon[0] as Point)

  while (true) {
    const nextA = a + 1 === n ? 0 : a + 1
    if (nextA === b) return
    const nextB = b === 0 ? n - 1 : b - 1
    const here = polygon[a] as Point
    const far = polygon[b] as Point
    const forward = ahead <= behind
    const onward = polygon[forward ? nextA : nextB] as Point

    // `??` short-circuits, so a flat paint costs no call at all here — and this
    // runs once per outline vertex in the frame, tens of thousands of times.
    batch.vertex(here.x, here.y, flat ?? paintAt(paint, here), FLAT)
    if (forward) {
      batch.vertex(onward.x, onward.y, flat ?? paintAt(paint, onward), FLAT)
      batch.vertex(far.x, far.y, flat ?? paintAt(paint, far), FLAT)
      ahead += gap(here, onward)
      a = nextA
    } else {
      batch.vertex(far.x, far.y, flat ?? paintAt(paint, far), FLAT)
      batch.vertex(onward.x, onward.y, flat ?? paintAt(paint, onward), FLAT)
      behind += gap(onward, far)
      b = nextB
    }
  }
}

/**
 * A ring, fanned from its first vertex. **Stencil only** — the fan is allowed to
 * spill outside the ring, because `INVERT` cares about parity and not about where
 * a triangle lies. That is the whole reason this is correct where the spike's
 * centroid fan was not: nothing here assumes the ring is star-shaped.
 */
export function fanForStencil(batch: Batch, ring: readonly Point[]): void {
  if (ring.length < 3) return
  const anchor = ring[0] as Point
  for (let i = 1; i < ring.length - 1; i += 1) {
    batch.tri(anchor, ring[i] as Point, ring[i + 1] as Point, FLAT)
  }
}

/** The axis-aligned box a set of rings occupies, or null if there is nothing in them. */
export function boundsOf(rings: readonly (readonly Point[])[]): Bounds | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let seen = 0
  for (const ring of rings) {
    if (ring.length < 3) continue
    seen += 1
    for (const point of ring) {
      if (point.x < minX) minX = point.x
      if (point.x > maxX) maxX = point.x
      if (point.y < minY) minY = point.y
      if (point.y > maxY) maxY = point.y
    }
  }
  if (seen === 0) return null
  return { minX, minY, maxX, maxY }
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Two triangles over a box, in one flat colour. The stencil's cover. */
export function box(batch: Batch, bounds: Bounds, colour: Colour, pad = 1): void {
  const l = bounds.minX - pad
  const r = bounds.maxX + pad
  const t = bounds.minY - pad
  const b = bounds.maxY + pad
  batch.vertex(l, t, colour)
  batch.vertex(r, t, colour)
  batch.vertex(l, b, colour)
  batch.vertex(r, t, colour)
  batch.vertex(r, b, colour)
  batch.vertex(l, b, colour)
}

/**
 * A quad carrying a radial falloff — one glow, or one mote. No gradient object
 * exists at all: the curve is evaluated per fragment.
 *
 * **Two curves, because `paint.ts` had two and they are not the same.** A `glow`
 * was a two-stop `CanvasGradient` from the ink to the same ink at zero alpha,
 * which interpolates premultiplied and is therefore **linear** in alpha; a mote
 * was a pre-rasterised sprite whose nine stops walk `(1 − t)²`, because a linear
 * ramp has a visible edge where it reaches zero and at 240 overlapping stamps
 * under `lighter` that edge is the difference between a drift of light and a
 * field of discs. Collapsing the two to one curve is the one place this painter
 * measurably changed the picture before the parity capture caught it: the squared
 * curve made every halo in the scene dimmer and tighter than it had been.
 */
export const LINEAR_FALLOFF = 1
export const SQUARED_FALLOFF = 2

export function falloff(
  batch: Batch,
  at: Point,
  radius: number,
  colour: Colour,
  curve: typeof LINEAR_FALLOFF | typeof SQUARED_FALLOFF,
): void {
  const f: Colour = [at.x, at.y, radius, curve]
  const l = at.x - radius
  const r = at.x + radius
  const t = at.y - radius
  const b = at.y + radius
  batch.vertex(l, t, colour, f)
  batch.vertex(r, t, colour, f)
  batch.vertex(l, b, colour, f)
  batch.vertex(r, t, colour, f)
  batch.vertex(r, b, colour, f)
  batch.vertex(l, b, colour, f)
}

/**
 * A stroked polyline as quads, with a round join at every interior vertex.
 *
 * The joins matter more here than they look: `lineJoin = 'round'` is set once at
 * the top of `paint` and every stroke in the scene inherits it, so a fence, a
 * severed cut and a spotlight ring all turn without a notch. Two quads meeting at
 * an angle leave exactly that notch, so each interior vertex gets a small fan.
 */
export function polyline(
  batch: Batch,
  points: readonly Point[],
  width: number,
  colour: Colour,
  closed: boolean,
): void {
  if (points.length < 2) return
  // A floor, so a hairline that canvas would have anti-aliased into a grey line
  // does not fall between two samples and disappear.
  const half = Math.max(0.35, width / 2)
  const segments = closed ? points.length : points.length - 1

  for (let i = 0; i < segments; i += 1) {
    const a = points[i] as Point
    const b = points[(i + 1) % points.length] as Point
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (length === 0) continue
    const nx = (-dy / length) * half
    const ny = (dx / length) * half
    batch.tri(
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: a.x - nx, y: a.y - ny },
      colour,
    )
    batch.tri(
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
      colour,
    )
  }

  // The joins, and only where one shows. A quad pair meeting at angle θ leaves a
  // wedge of about `half² · θ / 2`, so at the resolutions this scene strokes at
  // everything under {@link JOIN_ANGLE} is sub-pixel — which is most vertices of
  // most polylines here, because a contour ring and an arc are already smooth. A
  // disc at every vertex would have cost six hundred triangles per spotlight ring
  // to fill gaps nobody can find.
  if (half <= 0.75) return
  for (let i = closed ? 0 : 1; i < (closed ? points.length : points.length - 1); i += 1) {
    const before = points[(i - 1 + points.length) % points.length] as Point
    const here = points[i] as Point
    const after = points[(i + 1) % points.length] as Point
    if (turn(before, here, after) > JOIN_ANGLE) disc(batch, here, half, colour, 8)
  }
  if (!closed) {
    // `lineCap = 'round'` — the same two caps `paint` sets globally, and always
    // worth drawing: an end is a place the eye is looking.
    disc(batch, points[0] as Point, half, colour, 8)
    disc(batch, points[points.length - 1] as Point, half, colour, 8)
  }
}

/** Where a round join starts being visible, in radians. See {@link polyline}. */
const JOIN_ANGLE = 0.35

function turn(a: Point, b: Point, c: Point): number {
  const ax = b.x - a.x
  const ay = b.y - a.y
  const bx = c.x - b.x
  const by = c.y - b.y
  const la = Math.hypot(ax, ay)
  const lb = Math.hypot(bx, by)
  if (la === 0 || lb === 0) return 0
  return Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by))
}

/** A filled circle as a fan. Convex, so a fan is exact. */
export function disc(
  batch: Batch,
  at: Point,
  radius: number,
  colour: Colour,
  steps: number,
): void {
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2
    const b = ((i + 1) / steps) * Math.PI * 2
    batch.tri(
      at,
      { x: at.x + Math.cos(a) * radius, y: at.y + Math.sin(a) * radius },
      { x: at.x + Math.cos(b) * radius, y: at.y + Math.sin(b) * radius },
      colour,
    )
  }
}

/**
 * The points an arc is stroked through.
 *
 * Twelve steps per radian is the spike's number and it is a resolution rather
 * than a count, so a spotlight ring at 6× zoom is subdivided as finely as one at
 * 1× — the same reason `ribbon.ts` refuses to resample a spine to a constant.
 */
export function arcPoints(
  at: Point,
  radius: number,
  from: number,
  to: number,
): Point[] {
  const steps = Math.max(6, Math.ceil(Math.abs(to - from) * 12))
  const points: Point[] = []
  for (let i = 0; i <= steps; i += 1) {
    const angle = from + ((to - from) * i) / steps
    points.push({ x: at.x + Math.cos(angle) * radius, y: at.y + Math.sin(angle) * radius })
  }
  return points
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}
