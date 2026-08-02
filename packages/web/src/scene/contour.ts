import type { Point } from './geometry.js'
import { clamp01 } from './palette.js'

/**
 * A SURFACE, NOT A SET OF SHAPES (prd7 ruling 5).
 *
 * The root-mass used to be drawn as fifty-four curls around a pair of concentric
 * glows — the most obviously *assembled* thing on screen, and the one the eye
 * rests on longest. This file is what replaces it: a scalar field made of a few
 * smooth falloffs, sampled on a grid, and walked into closed rings. One surface,
 * whose shape is a consequence of what is in it rather than a decoration applied
 * to it, and which **melts** when something new arrives.
 *
 * Three decisions are load-bearing, and each is here rather than in `root.ts`
 * because each is about the technique and not about the mass.
 *
 * **1. Marching squares, not per-pixel metaballs.** Measured at our scale:
 * 1.28 ms/frame for the grid walk against 42.8 ms for a per-pixel evaluation
 * (108.5 ms once the per-pixel version carries SDFs and a smooth minimum). The
 * second reason is worth as much as the first: a grid walk emits a **contour
 * polygon**, so the root-mass stays a typed mark with queryable geometry and the
 * scene's laws about it stay laws. A pixel buffer would have made every one of
 * them a screenshot comparison.
 *
 * **2. `smin` is not associative.** Inigo Quilez's polynomial smooth minimum
 * (technique, reimplemented — no licence attaches to it) blends two distances
 * with a fillet of radius `k`, and `smin(smin(a,b),c) !== smin(a,smin(b,c))`. So
 * a field folded in whatever order the caller's array happened to be in would
 * **flap** frame to frame as lanes are added, retired or re-sorted — a wobble
 * with no event behind it, which is the one thing the motion law forbids
 * outright. {@link orderFalloffs} sorts by a stable id (the lane handle, for an
 * arrival) before any folding happens, and `contour.test.ts` pins it: same
 * state, shuffled input, byte-identical rings.
 *
 * **3. Chaikin, so the grid never shows.** Corner-cutting (Sighack's write-up,
 * MIT) turns the staircase marching squares necessarily emits into a curve, at
 * two passes over a closed ring. It is spent here rather than in the painter for
 * the same reason the ribbon outlines are: what is filled has to be what the
 * tests can read.
 */

/**
 * One smooth falloff — a circle, as a signed distance, before the blend.
 *
 * `id` is not decoration. It is the sort key the whole field is folded in, so it
 * has to be stable across frames for the same source: the lane handle for an
 * arrival, a fixed name for a part of the body. Two falloffs sharing an id are
 * still ordered (by their geometry) rather than left to the input's order.
 */
export interface Falloff {
  id: string
  at: Point
  radius: number
}

export interface ContourSpec {
  falloffs: readonly Falloff[]
  /**
   * Where the sampling lattice is anchored. Everything else about the grid is
   * derived from the falloffs, so this is what makes the sampling *stable*: the
   * same field about the same origin is sampled at the same points every frame.
   */
  origin: Point
  /** The `smin` fillet radius, in world units. How much neighbours melt together. */
  melt: number
  /** The grid pitch, in world units. */
  cell: number
  /** Corner-cutting passes over each ring. Clamped to 0…{@link MAX_SMOOTHING}. */
  smoothing?: number
}

/**
 * Three, per the ruling. Each pass doubles a ring's vertex count, and the third
 * one is already spending points below the width of a stroke.
 */
export const MAX_SMOOTHING = 3

/**
 * A hard ceiling on the lattice, in cells per side of the origin. Never reached
 * by anything the scene builds — the root-mass's own field wants about fifteen —
 * and here only so that a caller who asks for a one-pixel grid over a
 * thousand-pixel field gets a coarser picture rather than a hung frame. See
 * {@link pitch}.
 */
const MAX_HALF = 128

/**
 * Inigo Quilez's polynomial smooth minimum: `min(a, b)` with a fillet of radius
 * `k` where the two surfaces meet.
 *
 * The polynomial form rather than the exponential one because it is exact at
 * `|a - b| >= k` — outside the fillet it *is* `min`, so a falloff far from every
 * other one contributes nothing to their shape, which is what keeps the mass's
 * body from breathing every time an arrival lands on the far side of it.
 *
 * Not associative. See the note at the top of this file.
 */
export function smin(a: number, b: number, k: number): number {
  if (!(k > 0)) return Math.min(a, b)
  const h = clamp01(0.5 + (0.5 * (b - a)) / k)
  return b + (a - b) * h - k * h * (1 - h)
}

/**
 * The falloffs in the one order the field may be folded in.
 *
 * By `id` first — the stable handle — and then by geometry, so that two sources
 * that were given the same id are still totally ordered rather than falling back
 * on `Array.prototype.sort`'s stability, which would hand the input's own order
 * straight back and reintroduce exactly the flap this exists to prevent.
 */
export function orderFalloffs(falloffs: readonly Falloff[]): Falloff[] {
  return [...falloffs].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    if (a.at.x !== b.at.x) return a.at.x - b.at.x
    if (a.at.y !== b.at.y) return a.at.y - b.at.y
    return a.radius - b.radius
  })
}

/**
 * The field at a point: negative inside the surface, zero on it, positive
 * outside.
 *
 * **`ordered` must already have been through {@link orderFalloffs}.** It is not
 * sorted here because this runs once per lattice sample and a sort per sample
 * would cost more than the whole contour; `contourRings` sorts once, up front.
 */
export function fieldAt(p: Point, ordered: readonly Falloff[], melt: number): number {
  return fieldXY(p.x, p.y, ordered, melt)
}

/**
 * The inner loop, and the one place in the scene where `Math.hypot` is
 * deliberately not used: it is specified to avoid intermediate overflow, which
 * costs several times a plain square root and buys nothing at all at the scale
 * of a panel measured in hundreds of pixels. This runs once per lattice sample
 * per falloff — a few tens of thousands of times a frame — and it is most of the
 * contour's whole cost.
 */
function fieldXY(x: number, y: number, ordered: readonly Falloff[], melt: number): number {
  let distance = Number.NaN
  for (let i = 0; i < ordered.length; i += 1) {
    const falloff = ordered[i] as Falloff
    const dx = x - falloff.at.x
    const dy = y - falloff.at.y
    const own = Math.sqrt(dx * dx + dy * dy) - falloff.radius
    distance = i === 0 ? own : smin(distance, own, melt)
  }
  return distance
}

/**
 * Chaikin's corner cut over a **closed** ring: each edge gives up its ends at a
 * quarter and three quarters, and the corner between them disappears.
 *
 * Closed rather than open, which is the whole difference from the textbook
 * version: the last vertex wraps to the first, so a ring stays a ring and does
 * not develop two pinned corners where its seam is.
 */
export function chaikin(ring: readonly Point[], passes: number): Point[] {
  let out = [...ring]
  const rounds = Math.min(MAX_SMOOTHING, Math.max(0, Math.round(passes)))

  for (let pass = 0; pass < rounds; pass += 1) {
    if (out.length < 3) break
    const cut: Point[] = []
    for (let i = 0; i < out.length; i += 1) {
      const a = out[i] as Point
      const b = out[(i + 1) % out.length] as Point
      cut.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
      cut.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
    }
    out = cut
  }

  return out
}

/**
 * THE SURFACE, as closed rings in world coordinates.
 *
 * Rings, plural, because a field can have more than one component — an arrival
 * that has not yet melted into the body is its own island for a few frames, and
 * that separation is a fact about the picture rather than a glitch in it. Nested
 * rings are possible too (a mass with a hole in it), which is why the painter
 * fills them under the even-odd rule.
 *
 * Every ring is **closed and watertight** by construction rather than by
 * stitching tolerance: see {@link walk}.
 */
export function contourRings(spec: ContourSpec): Point[][] {
  const ordered = orderFalloffs(spec.falloffs)
  if (ordered.length === 0) return []

  const melt = Math.max(0, spec.melt)
  const cell = pitch(ordered, spec.origin, melt, spec.cell)
  if (!(cell > 0)) return []

  const half = Math.ceil(extent(ordered, spec.origin, melt, cell) / cell)
  const size = 2 * half + 1
  const x0 = spec.origin.x - half * cell
  const y0 = spec.origin.y - half * cell

  const values = new Float64Array(size * size)
  for (let j = 0; j < size; j += 1) {
    for (let i = 0; i < size; i += 1) {
      values[j * size + i] = fieldXY(x0 + i * cell, y0 + j * cell, ordered, melt)
    }
  }

  const rings = walk({ values, size, x0, y0, cell, ordered, melt })
  const passes = spec.smoothing ?? MAX_SMOOTHING
  return rings.map((ring) => chaikin(ring, passes))
}

/**
 * How far from the origin the surface can possibly reach, plus a cell of margin.
 *
 * Generous on purpose, and the margin is the point: the lattice's outermost
 * samples have to be *outside* the surface, because a crossing on the border of
 * the grid would belong to only one cell and would leave a chain with nowhere to
 * go — an open ring, and a hole in the fill. `melt` bounds the smooth minimum's
 * own overshoot (the polynomial fillet never dips more than `k/4` below `min`),
 * so adding it whole is a margin with room to spare.
 */
function extent(
  ordered: readonly Falloff[],
  origin: Point,
  melt: number,
  cell: number,
): number {
  let reach = 0
  for (const falloff of ordered) {
    const own =
      Math.hypot(falloff.at.x - origin.x, falloff.at.y - origin.y) + Math.max(0, falloff.radius)
    if (own > reach) reach = own
  }
  return reach + melt + cell
}

/**
 * The grid pitch actually used: the one asked for, unless honouring it would
 * take more than {@link MAX_HALF} cells to cover the field. Coarsening rather
 * than clipping, so the backstop costs detail and never correctness.
 */
function pitch(
  ordered: readonly Falloff[],
  origin: Point,
  melt: number,
  asked: number,
): number {
  if (!(asked > 0)) return 0
  const needed = extent(ordered, origin, melt, 0) / (MAX_HALF - 1)
  return Math.max(asked, needed)
}

interface Lattice {
  values: Float64Array
  size: number
  x0: number
  y0: number
  cell: number
  ordered: readonly Falloff[]
  melt: number
}

/**
 * MARCHING SQUARES, AND WHY THE RINGS CANNOT COME OUT OPEN.
 *
 * The usual implementation emits loose segments from a sixteen-entry table and
 * then stitches them by comparing endpoint coordinates — which needs a tolerance,
 * and a tolerance is a thing that can be wrong. This one never compares a
 * coordinate. Every crossing lives on a *grid edge* and is named by that edge, so
 * two cells that share an edge are talking about the same vertex by construction.
 *
 * The segments are directed, and the direction comes out of walking each cell's
 * own boundary in the fixed cyclic order TL → TR → BR → BL. Along that walk a
 * crossing is either an **exit** (inside to outside) or an **entry**, and a
 * segment runs exit → entry. A shared edge is walked in opposite directions by
 * its two cells, so whichever cell calls it an exit, the other calls it an entry:
 * every vertex is the start of exactly one segment and the end of exactly one.
 * Following `to` from any start therefore returns to that start, always. Closed
 * rings are a property of the construction rather than something to check for.
 *
 * The saddle (two opposite corners inside, two outside) is the one case with a
 * genuine choice, and it is settled by evidence: the field is sampled at the
 * cell's centre, and the two inside corners are joined if the centre is inside
 * them. Two extra samples per contour, at most.
 */
function walk(grid: Lattice): Point[][] {
  const { values, size, x0, y0, cell, ordered, melt } = grid

  /** Edge names. Horizontal edge (i,j) runs east; vertical edge (i,j) runs south. */
  const hKey = (i: number, j: number): number => ((j * size + i) << 1) | 0
  const vKey = (i: number, j: number): number => ((j * size + i) << 1) | 1

  const at = (i: number, j: number): number => values[j * size + i] as number
  const inside = (i: number, j: number): boolean => at(i, j) < 0

  const vertices = new Map<number, Point>()
  const next = new Map<number, number>()

  /** The crossing on a grid edge, always interpolated in the edge's own direction. */
  const hPoint = (i: number, j: number): Point => {
    const a = at(i, j)
    const t = a / (a - at(i + 1, j))
    return { x: x0 + (i + t) * cell, y: y0 + j * cell }
  }
  const vPoint = (i: number, j: number): Point => {
    const a = at(i, j)
    const t = a / (a - at(i, j + 1))
    return { x: x0 + i * cell, y: y0 + (j + t) * cell }
  }

  const exits: number[] = []
  const entries: number[] = []
  const corner = [false, false, false, false]

  for (let j = 0; j < size - 1; j += 1) {
    for (let i = 0; i < size - 1; i += 1) {
      corner[0] = inside(i, j)
      corner[1] = inside(i + 1, j)
      corner[2] = inside(i + 1, j + 1)
      corner[3] = inside(i, j + 1)
      if (corner[0] === corner[1] && corner[1] === corner[2] && corner[2] === corner[3]) continue

      // Side `k` of the cell's boundary walk, and the grid edge it lies on.
      const key = (k: number): number =>
        k === 0 ? hKey(i, j) : k === 1 ? vKey(i + 1, j) : k === 2 ? hKey(i, j + 1) : vKey(i, j)
      const point = (k: number): Point =>
        k === 0 ? hPoint(i, j) : k === 1 ? vPoint(i + 1, j) : k === 2 ? hPoint(i, j + 1) : vPoint(i, j)

      exits.length = 0
      entries.length = 0
      for (let k = 0; k < 4; k += 1) {
        const from = corner[k] as boolean
        const to = corner[(k + 1) & 3] as boolean
        if (from === to) continue
        if (from) exits.push(k)
        else entries.push(k)
      }

      const link = (exit: number, entry: number): void => {
        const from = key(exit)
        const to = key(entry)
        if (!vertices.has(from)) vertices.set(from, point(exit))
        if (!vertices.has(to)) vertices.set(to, point(entry))
        next.set(from, to)
      }

      if (exits.length === 1) {
        link(exits[0] as number, entries[0] as number)
        continue
      }

      // The saddle. Joining pairs each exit with the *next* entry around the
      // boundary, which is the pairing that leaves the two inside corners in one
      // region; the alternative cuts them apart. The centre sample decides.
      const joined =
        fieldXY(x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell, ordered, melt) < 0
      for (const exit of exits) {
        const first = entries[0] as number
        const second = entries[1] as number
        const nearer = (first - exit + 4) % 4 < (second - exit + 4) % 4 ? first : second
        link(exit, joined ? nearer : nearer === first ? second : first)
      }
    }
  }

  const rings: Point[][] = []
  const spent = new Set<number>()
  for (const start of next.keys()) {
    if (spent.has(start)) continue
    const ring: Point[] = []
    let cursor = start
    while (!spent.has(cursor)) {
      spent.add(cursor)
      const here = vertices.get(cursor)
      if (here === undefined) break
      ring.push(here)
      const onward = next.get(cursor)
      if (onward === undefined) break
      cursor = onward
    }
    if (ring.length >= 3) rings.push(ring)
  }

  return rings
}
