import { curveCatmullRom, line } from 'd3-shape'
import { getStroke } from 'perfect-freehand'
import type { Point } from './geometry.js'

/**
 * RIBBONS (prd7 ruling 3) — stop stroking lines, start filling them.
 *
 * A thread used to be a centre-line and a `lineWidth`, which is why the scene
 * read as drafted: a stroke is the same everywhere along itself, and a hypha is
 * not. Here a thread is a **closed polygon whose width varies along its length**,
 * built once per frame from a spine and a width profile and handed to the
 * painter as geometry. `paint.ts` fills it and has no idea how it was made.
 *
 * That one substitution is what makes the rest of prd7 possible, because it
 * turns width into a *channel*. Once a ribbon can be pinched, swelled and
 * tapered along its length, half the discrete glyphs in the scene have somewhere
 * to go — a cut becomes a pinch that closes to nothing, a commit becomes a swell
 * travelling along the thread, direction becomes an asymmetric taper. Each of
 * those spends **zero new objects**: the meaning moves into the form of a mark
 * that was already being drawn.
 *
 * Three libraries do the work, and each is here for one specific property:
 *
 * - **`perfect-freehand`** (MIT) builds *one* outline for the whole stroke and
 *   inserts an explicit rounded cap wherever the direction reverses more than
 *   90°. That is the difference between this and the obvious per-segment quad
 *   approach, which leaves a notch on the outside of every turn. Fed our own
 *   width as per-point pressure with `simulatePressure: false` — their
 *   velocity-based simulation is exactly the nondeterminism this scene cannot
 *   have.
 * - **`d3-shape`'s centripetal Catmull-Rom** (α = 0.5) smooths the spine. It
 *   **interpolates** its control points, so a waypoint that carries meaning
 *   stays exactly on the curve. `curveBasis` approximates and is banned here for
 *   that reason: it would move the encoded positions.
 * - the width profile is ours, and it is the part the substitutions live in.
 *
 * What this file must never do is read a clock or a random. A ribbon is a pure
 * function of its spine and its widths; the same fleet draws the same polygon in
 * this frame, in the next one, and in a replay on another machine.
 */

/**
 * How finely a ribbon's spine is sampled before it is widened. Twenty-four
 * points is the number the prd7 probe measured (a 24-point spine yields an
 * 88-point closed outline at 0.172 ms for thirty ribbons), and it is well past
 * the point where a thread stops looking faceted at 6× zoom.
 */
export const RIBBON_SAMPLES = 24

/** Below this, a ribbon has closed: the run ends and a new one begins. */
export const PINCH_EPSILON = 0.02

/**
 * A local modulation of a ribbon's width — the primitive every substitution in
 * ruling 3's table is written in.
 *
 * `scale` of 0 is a **pinch** that closes the ribbon to nothing (FROZEN's cut);
 * `scale` above 1 is a **swell** (a commit travelling home). `span` is how far
 * the modulation reaches in path parameter, and the falloff between is a raised
 * cosine, so a swell has no corner on it and a pinch does not read as a notch.
 */
export interface WidthStop {
  /** Where along the ribbon, 0 = root, 1 = tip. */
  at: number
  /** How far it reaches either side, in path parameter. */
  span: number
  /** Width multiplier at the centre. 0 closes; >1 swells. */
  scale: number
  /**
   * How much of the span holds `scale` flat before easing out, 0–1.
   *
   * A pinch needs one. A cut is not a mathematical point — a hypha dies back
   * over a short length — and a stop that only reached zero at a single
   * parameter would close the ribbon only when a sample happened to land on it,
   * which would make "is this lane severed?" a function of the sample count.
   */
  flat?: number
}

export interface RibbonShape {
  /** The centre-line. Already smoothed — see {@link smoothSpine}. */
  spine: readonly Point[]
  /** The encoded widths, root and tip. LOCKED: this is the work-size channel. */
  widthRoot: number
  widthTip: number
  /** Pinches and swells along the length. */
  stops?: readonly WidthStop[]
  /**
   * A bounded multiplier along the ribbon — where the width-jitter channel is
   * spent (`variation.ts`). Evaluated here rather than baked into the widths so
   * that {@link RibbonShape.widthRoot} stays the *encoded* number a test can
   * read back off the mark.
   */
  modulate?: (t: number) => number
  /**
   * Draw the last of the ribbon down to a needle, over this much of its length.
   * Direction, told as a width gradient rather than as an arrowhead: a taper is
   * legible along the whole thread, where a 6px chevron is legible nowhere.
   */
  taperTip?: number
  /** Short runs with gaps: a line that is broken rather than merely thin. */
  dashed?: boolean
  /** Override the sample count — fewer for the soft wide blooms nobody reads an edge on. */
  samples?: number
}

/** The ribbon's full width at `t`, with every modulation applied. */
export function widthOf(shape: RibbonShape, t: number): number {
  const k = clamp01(t)
  let width = shape.widthRoot + (shape.widthTip - shape.widthRoot) * k

  const taper = shape.taperTip ?? 0
  if (taper > 0 && k > 1 - taper) width *= Math.pow((1 - k) / taper, 1.2)

  for (const stop of shape.stops ?? []) {
    if (stop.span <= 0) continue
    const away = Math.abs(k - stop.at) / stop.span
    if (away >= 1) continue
    const flat = clamp01(stop.flat ?? 0)
    const eased = flat >= 1 ? 0 : Math.max(0, (away - flat) / (1 - flat))
    // Raised cosine: full strength at the centre, nothing at the edges, and flat
    // where it meets the rest of the ribbon so a swell arrives rather than
    // switching on.
    width *= 1 + (stop.scale - 1) * Math.cos((eased * Math.PI) / 2) ** 2
  }

  if (shape.modulate !== undefined) width *= shape.modulate(k)
  return Math.max(0, width)
}

/**
 * The closed polygons a ribbon is filled as — one for a whole thread, several
 * for a dashed or pinched one.
 *
 * The split is where "less shapes" is actually paid for. A ribbon that closes to
 * nothing in the middle is two lobes meeting at a point, and that is a *severing*
 * without a single new object entering the display list; a dashed one is the same
 * mechanism with the runs chosen by index rather than by width.
 */
export function ribbonOutline(shape: RibbonShape): Point[][] {
  const samples = shape.samples ?? RIBBON_SAMPLES
  const spine = resample(shape.spine, samples)
  if (spine.length < 2) return []

  const last = spine.length - 1
  const widths = spine.map((_unused, i) => widthOf(shape, i / last))
  const widest = Math.max(...widths)
  if (widest <= PINCH_EPSILON) return []

  return runs(last, shape.dashed === true)
    .flatMap((run) => pinched(run, widths))
    .map(([from, to]) => outlineOf(spine, widths, from, to, widest))
    .filter((polygon) => polygon.length > 2)
}

/**
 * One run through `perfect-freehand`.
 *
 * The mapping is the whole trick, and it is exact rather than approximate: with
 * `thinning: 1` their radius is `size × pressure`, so feeding `size` = the
 * ribbon's widest full width and `pressure` = this sample's half-width over that
 * size returns a ribbon exactly as wide as the encoding asked for. (Probed: a
 * requested half-width of 1.69565 px comes back as 1.69563.) Everything that
 * could make it inexact is switched off — no simulated pressure, no streamline
 * lerp, no smoothing decimation.
 */
function outlineOf(
  spine: readonly Point[],
  widths: readonly number[],
  from: number,
  to: number,
  widest: number,
): Point[] {
  const points: [number, number, number][] = []
  for (let i = from; i <= to; i += 1) {
    const point = spine[i] as Point
    points.push([point.x, point.y, (widths[i] as number) / 2 / widest])
  }
  if (points.length < 2) return []

  return getStroke(points, {
    size: widest,
    thinning: 1,
    smoothing: 0,
    streamline: 0,
    simulatePressure: false,
    last: true,
  }).map(([x, y]) => ({ x, y }))
}

/**
 * Split a run wherever the ribbon has closed. The pinch sample belongs to both
 * lobes, so the two ends meet at a point rather than leaving a gap: the thread
 * was severed, not erased.
 */
function pinched(run: [number, number], widths: readonly number[]): [number, number][] {
  const [start, end] = run
  const out: [number, number][] = []
  let from = start
  for (let i = start; i <= end; i += 1) {
    if ((widths[i] as number) > PINCH_EPSILON) continue
    if (i - from >= 1) out.push([from, i])
    from = i
  }
  if (end - from >= 1) out.push([from, end])
  return out
}

/**
 * The runs a dashed ribbon is drawn in — five samples on, two off. Kept from the
 * painter it moved out of: a *dashed* line reads as broken while a merely thin
 * one reads as far away, and FROZEN's whole encoding is that it is broken.
 */
function runs(last: number, dashed: boolean): [number, number][] {
  if (!dashed) return [[0, last]]

  const out: [number, number][] = []
  let start = 0
  for (let i = 0; i <= last; i += 1) {
    if (i % 7 !== 5) continue
    if (i - start > 1) out.push([start, i])
    start = i + 2
  }
  if (last - start > 1) out.push([start, last])
  return out
}

/**
 * A spine through every one of its waypoints, smoothed with centripetal
 * Catmull-Rom (α = 0.5).
 *
 * Centripetal rather than uniform or chordal because d3's own documentation is
 * unambiguous about why: it is the one that avoids self-intersections and
 * overshoot, which on a thread that has been nudged sideways by the wander is
 * the difference between a curve and a loop.
 *
 * d3 curves draw into a context rather than returning points, so the context we
 * hand it records the béziers instead of painting them and we flatten those.
 * The sample count is rounded to a whole number per segment, which is what makes
 * the interpolation claim *checkable*: every waypoint comes back in the output
 * exactly, so a data-meaningful position survives the smoothing bit for bit.
 */
export function smoothSpine(waypoints: readonly Point[], steps: number): Point[] {
  if (waypoints.length < 2) return [...waypoints]

  const segments = record(waypoints)
  if (segments.length === 0) return [...waypoints]

  const per = Math.max(1, Math.round(steps / segments.length))
  const out: Point[] = []
  for (const [index, segment] of segments.entries()) {
    for (let i = index === 0 ? 0 : 1; i <= per; i += 1) out.push(cubicAt(segment, i / per))
  }
  return out
}

interface Segment {
  from: Point
  c1: Point
  c2: Point
  to: Point
}

/** d3's curve, drawn into a recorder rather than onto a canvas. */
function record(waypoints: readonly Point[]): Segment[] {
  const segments: Segment[] = []
  let at: Point = waypoints[0] as Point

  const context = {
    moveTo(x: number, y: number): void {
      at = { x, y }
    },
    lineTo(x: number, y: number): void {
      const to = { x, y }
      segments.push({ from: at, c1: at, c2: to, to })
      at = to
    },
    bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
      const to = { x, y }
      segments.push({ from: at, c1: { x: x1, y: y1 }, c2: { x: x2, y: y2 }, to })
      at = to
    },
    closePath(): void {},
  }

  const draw = line<Point>()
    .x((point) => point.x)
    .y((point) => point.y)
    .curve(curveCatmullRom.alpha(0.5))
    // The recorder implements the four methods `line` can call. The cast is the
    // documented way to harvest points out of a d3 curve without a canvas.
    .context(context as unknown as CanvasRenderingContext2D)

  draw([...waypoints])
  return segments
}

function cubicAt(segment: Segment, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * segment.from.x + b * segment.c1.x + c * segment.c2.x + d * segment.to.x,
    y: a * segment.from.y + b * segment.c1.y + c * segment.c2.y + d * segment.to.y,
  }
}

/** `steps + 1` points evenly spaced in path parameter — the ribbon's own resolution. */
function resample(path: readonly Point[], steps: number): Point[] {
  if (path.length <= 1) return [...path]
  if (path.length === steps + 1) return [...path]

  const out: Point[] = []
  for (let i = 0; i <= steps; i += 1) out.push(at(path, i / steps))
  return out
}

/**
 * Point at `t` along a sampled path. The same arithmetic as `geometry.ts`'s
 * `pointAt`, restated here rather than imported: `geometry.ts` imports
 * {@link smoothSpine} from this file, and a value cycle between the two would
 * make the module order load-bearing.
 */
function at(path: readonly Point[], t: number): Point {
  const on = clamp01(t) * (path.length - 1)
  const i = Math.floor(on)
  const j = Math.min(path.length - 1, i + 1)
  const f = on - i
  const a = path[i] as Point
  const b = path[j] as Point
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}
