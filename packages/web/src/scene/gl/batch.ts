import type { Point } from '../geometry.js'
import type { Ink } from '../palette.js'

/**
 * THE VERTEX STREAM — one growable buffer for the whole frame, and the list of
 * ranges the painter draws it in.
 *
 * The spike sorted every mark into two batches by blend class and drew the frame
 * in two calls. That is fast and it is **wrong**: `lighter` does not commute with
 * `source-over`, so a halo that canvas 2D paints *under* the mass comes out on
 * top of it once the additive marks are all drawn last. Batching by class is a
 * reordering, and reordering an ordered display list changes the picture.
 *
 * So the order is kept and the *upload* is batched instead. Every triangle in the
 * frame lands in one buffer in list order; a {@link Run} records where the blend
 * class or the transform changes. One `bufferData` per frame, one `drawArrays`
 * per run — and the number of runs is the number of times the frame actually
 * switches state, which for this display list is tens rather than hundreds.
 *
 * Nothing in this file knows what a mark is. It is arrays and ranges, so it runs
 * anywhere — which is the whole of why the tessellation stays testable without a
 * GPU (see `frame.ts`).
 */

/** `rgba`, 0–1, straight (not premultiplied) — the shader premultiplies. */
export type Colour = readonly [number, number, number, number]

/** A vertex that is not part of a falloff. See {@link Batch.vertex}. */
export const FLAT: Colour = [0, 0, 0, 0]

/**
 * How a range of triangles is drawn.
 *
 * - `additive` — `lighter` in canvas terms. Light adds, ink covers (`paint.ts`'s
 *   own rule, kept verbatim).
 * - `world` — through the camera, or at device scale. The two passes `paint`
 *   always had, expressed as a uniform rather than as a `setTransform`.
 */
export interface DrawRun {
  kind: 'tris'
  start: number
  count: number
  additive: boolean
  world: boolean
}

/**
 * EVEN-ODD, AS THE PLATFORM PRIMITIVE IT STOPPED BEING.
 *
 * `paint.ts` got `ctx.fill('evenodd')` from the canvas and a contour's holes came
 * out for free. WebGL has no fill rule, and the spike fanned each ring from its
 * centroid — correct only for rings that are star-shaped about their centre, a
 * constraint `contour.ts` does not enforce and could not cheaply be made to.
 *
 * This is the general answer instead: draw the rings into the **stencil** buffer
 * with `INVERT`, which flips a bit for every ring covering a pixel, then cover the
 * bounding box wherever the bit is set. A pixel inside an odd number of rings is
 * painted and one inside an even number is not — which is the even-odd rule,
 * exactly, for any rings whatever their shape, winding or nesting.
 *
 * Two ranges: the rings (colour writes off) and the cover quad (colour writes on,
 * and the stencil reset as it goes).
 */
export interface StencilRun {
  kind: 'stencil'
  fillStart: number
  fillCount: number
  coverStart: number
  coverCount: number
  additive: boolean
  world: boolean
}

/** A panel-sized two-stop radial, drawn by its own program from uniforms alone. */
export interface WashRun {
  kind: 'wash'
  centre: Point
  /** Inner and outer radius in CSS px — the half-diagonal fractions, resolved. */
  from: number
  to: number
  inner: Ink
  outer: Ink
  width: number
  height: number
}

/** The film grain: one noise tile, repeated, offset by the mark's own step. */
export interface GrainRun {
  kind: 'grain'
  tile: number
  shift: Point
  ink: Ink
  width: number
  height: number
}

export type Run = DrawRun | StencilRun | WashRun | GrainRun

/**
 * One appendable triangle stream: positions, colours, and the falloff parameters
 * the fragment shader needs.
 *
 * `fall` is `(cx, cy, radius, mode)`. Mode 0 is a flat vertex and mode 1 is a
 * radial `(1 - r)²` falloff about `(cx, cy)` — the same curve `paint.ts` bakes
 * into its mote sprite, evaluated per fragment instead of rasterised per colour.
 */
export class Batch {
  pos: Float32Array
  col: Float32Array
  fall: Float32Array
  /** Vertices written. Always a multiple of 3 between marks. */
  n = 0

  constructor(capacity = 1 << 14) {
    this.pos = new Float32Array(capacity * 2)
    this.col = new Float32Array(capacity * 4)
    this.fall = new Float32Array(capacity * 4)
  }

  vertex(x: number, y: number, colour: Colour, fall: Colour = FLAT): void {
    if (this.n * 2 >= this.pos.length) this.grow()
    const i2 = this.n * 2
    const i4 = this.n * 4
    this.pos[i2] = x
    this.pos[i2 + 1] = y
    this.col[i4] = colour[0]
    this.col[i4 + 1] = colour[1]
    this.col[i4 + 2] = colour[2]
    this.col[i4 + 3] = colour[3]
    this.fall[i4] = fall[0]
    this.fall[i4 + 1] = fall[1]
    this.fall[i4 + 2] = fall[2]
    this.fall[i4 + 3] = fall[3]
    this.n += 1
  }

  /** One flat-shaded triangle. */
  tri(a: Point, b: Point, c: Point, colour: Colour): void {
    this.vertex(a.x, a.y, colour)
    this.vertex(b.x, b.y, colour)
    this.vertex(c.x, c.y, colour)
  }

  /**
   * Appends `count` vertices whose bytes were already computed elsewhere — a
   * plain copy, no arithmetic. This is how `frame.ts`'s per-mark tessellation
   * cache gets a cached mark's vertices back into the real stream without
   * re-running `draw()`: {@link vertex} is how a *new* triangle is authored,
   * this is how an *old* one is replayed.
   */
  appendRaw(pos: Float32Array, col: Float32Array, fall: Float32Array, count: number): void {
    while ((this.n + count) * 2 > this.pos.length) this.grow()
    this.pos.set(pos.subarray(0, count * 2), this.n * 2)
    this.col.set(col.subarray(0, count * 4), this.n * 4)
    this.fall.set(fall.subarray(0, count * 4), this.n * 4)
    this.n += count
  }

  reset(): void {
    this.n = 0
  }

  private grow(): void {
    const bigger = (array: Float32Array): Float32Array => {
      const next = new Float32Array(array.length * 2)
      next.set(array)
      return next
    }
    this.pos = bigger(this.pos)
    this.col = bigger(this.col)
    this.fall = bigger(this.fall)
  }
}

/**
 * The run list, built as the marks are walked.
 *
 * Consecutive triangles that want the same blend and the same transform are one
 * run, which is what turns several hundred marks into a couple of dozen draw
 * calls without moving a single triangle out of paint order.
 */
export class Runs {
  private readonly list: Run[] = []
  private open: DrawRun | null = null

  /** Triangles are about to be appended at `at`, under this state. */
  openTriangles(at: number, additive: boolean, world: boolean): void {
    if (this.open !== null && this.open.additive === additive && this.open.world === world) return
    this.seal(at)
    this.open = { kind: 'tris', start: at, count: 0, additive, world }
    this.list.push(this.open)
  }

  /** The stream is now `at` vertices long; close the open run against it. */
  seal(at: number): void {
    if (this.open === null) return
    this.open.count = at - this.open.start
    if (this.open.count === 0) this.list.pop()
    this.open = null
  }

  /** A run that is not plain triangles. Ends whatever was being appended. */
  push(run: Run, at: number): void {
    this.seal(at)
    this.list.push(run)
  }

  done(at: number): readonly Run[] {
    this.seal(at)
    return this.list
  }
}
