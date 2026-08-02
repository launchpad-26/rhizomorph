import { describe, expect, it } from 'vitest'
import { buildFleet, fixtureHistory, fleet20Spec, manifestFor } from '../fleet/index.js'
import { reduceAll } from '@observatory/core'
import { MAX_SMOOTHING, chaikin, contourRings, fieldAt, orderFalloffs, smin, type Falloff } from './contour.js'
import { layoutScene, type Point } from './geometry.js'
import { breathOf, motionMode, type SceneFrame } from './marks/index.js'
import { rootFalloffs } from './marks/root.js'
import { PulseField } from './pulses.js'
import { CUT, cutAt, type RetireState } from './retire.js'
import { salienceOf } from './salience.js'

/**
 * THE SURFACE THE ROOT-MASS IS (prd7 ruling 5).
 *
 * `root.ts` decides what is in the field; this file holds the technique that
 * turns a field into a shape, and the two are tested apart for the reason they
 * are written apart — retuning the mass's proportions must not be able to break
 * "the rings come out closed", and swapping the smoothing must not be able to
 * break "the mass thickens with landed work".
 *
 * Four properties here are load-bearing rather than incidental, and each one is
 * a thing that would have shipped broken without a test: the blend is
 * **order-independent**, the rings are **closed**, the sampling is a
 * **similarity transform** of the field, and the grid **never shows**.
 */

const ORIGIN: Point = { x: 0, y: 0 }

/** A ring's radii about a point — what most of the shape assertions are in. */
function radii(ring: readonly Point[], about: Point = ORIGIN): number[] {
  return ring.map((p) => Math.hypot(p.x - about.x, p.y - about.y))
}

/** The longest step between consecutive vertices, wrap included. A ring has no seam. */
function longestEdge(ring: readonly Point[]): number {
  let worst = 0
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i] as Point
    const b = ring[(i + 1) % ring.length] as Point
    worst = Math.max(worst, Math.hypot(b.x - a.x, b.y - a.y))
  }
  return worst
}

function circle(id: string, x: number, y: number, radius: number): Falloff {
  return { id, at: { x, y }, radius }
}

/** A deterministic re-ordering. Not `Math.random` — a flake here would be unreadable. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * 7 + 3) % (i + 1)
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

describe('smin — the smooth minimum the whole field is folded with', () => {
  it('is exactly min outside the fillet, so a distant falloff changes nothing', () => {
    // The reason for the polynomial form rather than the exponential one: a lane
    // arriving on the far side of the mass must not breathe on the near side.
    expect(smin(3, 12, 4)).toBe(3)
    expect(smin(12, 3, 4)).toBe(3)
    expect(smin(-8, 2, 4)).toBe(-8)
  })

  it('dips below both where they meet — that dip is the weld', () => {
    // At `a === b` the polynomial takes off exactly k/4, which is the deepest it
    // ever goes and the bound `contour.ts` pads its lattice by.
    expect(smin(0, 0, 4)).toBeCloseTo(-1, 12)
    expect(smin(2, 2, 4)).toBeCloseTo(1, 12)
    expect(smin(1, 3, 4)).toBeLessThan(1)
  })

  it('degenerates to min at zero smoothing rather than dividing by it', () => {
    expect(smin(5, 2, 0)).toBe(2)
    expect(smin(5, 2, -1)).toBe(2)
  })

  /**
   * THE REASON `orderFalloffs` EXISTS, stated as arithmetic.
   *
   * If this test ever goes green the other way round — if `smin` turns out to be
   * associative after all — the sort is dead weight. It is not: folding the same
   * three distances in two different orders lands in two different places, and a
   * field folded in whatever order the caller's array happened to be in would
   * move the mass's skin every time a lane was added or retired. That is a
   * wobble with no event behind it, which the motion law forbids outright.
   */
  it('is NOT associative, which is the whole reason the blend is sorted', () => {
    const [a, b, c] = [1, 2, 3]
    const left = smin(smin(a, b, 4), c, 4)
    const right = smin(a, smin(b, c, 4), 4)
    expect(left).not.toBeCloseTo(right, 6)
  })
})

describe('the blend is ordered, so the geometry cannot flap', () => {
  const falloffs = [
    circle('c', 14, 4, 18),
    circle('a', -10, -6, 20),
    circle('b', 2, 16, 16),
    circle('d', -16, 10, 12),
  ]

  it('sorts by id, and the order is total even when two ids collide', () => {
    // Stability would hand the input's own order straight back for the two `x`s,
    // which is exactly the flap this is preventing — so geometry breaks the tie.
    const twins = [circle('x', 9, 0, 5), circle('a', 0, 0, 5), circle('x', -9, 0, 5)]
    expect(orderFalloffs(twins).map((f) => `${f.id}@${f.at.x}`)).toEqual(['a@0', 'x@-9', 'x@9'])
    expect(orderFalloffs(shuffled(twins)).map((f) => `${f.id}@${f.at.x}`)).toEqual([
      'a@0',
      'x@-9',
      'x@9',
    ])
  })

  /** THE LAW. Same state, shuffled input, identical contour — to the last bit. */
  it('gives the identical contour whatever order the falloffs arrive in', () => {
    const spec = { origin: ORIGIN, melt: 8, cell: 2.5, smoothing: 2 }
    const straight = contourRings({ ...spec, falloffs })

    expect(straight).toHaveLength(1)
    for (const order of [shuffled(falloffs), [...falloffs].reverse(), shuffled(shuffled(falloffs))]) {
      expect(contourRings({ ...spec, falloffs: order })).toEqual(straight)
    }
  })

  it('holds on the real root-mass field, arrivals and all', () => {
    // A fixture of three circles could pass this by accident; the field the scene
    // actually builds has six body parts and one falloff per parting cord, whose
    // ids are lane handles and whose order is whatever the layout produced.
    const frame = frameFor(landed(6, cutAt(CUT.tensionMs + CUT.retractMs - 60)))
    const radius = frame.geometry.rootRadius
    const falloffs = rootFalloffs(frame, radius)
    expect(falloffs.length).toBeGreaterThan(6)

    const spec = {
      origin: frame.geometry.centre,
      melt: radius * 0.24,
      cell: radius * 0.13,
      smoothing: 2,
    }
    expect(contourRings({ ...spec, falloffs: shuffled(falloffs) })).toEqual(
      contourRings({ ...spec, falloffs }),
    )
  })

  it('is order-dependent *without* the sort, which is what makes the sort a law', () => {
    // `fieldAt` folds what it is given, in the order it is given. Two orders, two
    // answers — so the sort in `contourRings` is doing real work.
    const at: Point = { x: 6, y: 6 }
    const one = fieldAt(at, falloffs, 8)
    const other = fieldAt(at, [...falloffs].reverse(), 8)
    expect(one).not.toBeCloseTo(other, 6)
    // …and both agree once they have been through the sort.
    expect(fieldAt(at, orderFalloffs(falloffs), 8)).toBe(
      fieldAt(at, orderFalloffs([...falloffs].reverse()), 8),
    )
  })
})

describe('marching squares — the rings are closed by construction', () => {
  it('walks one circle into one closed ring, on the circle', () => {
    const cell = 1.5
    const rings = contourRings({
      falloffs: [circle('one', 0, 0, 30)],
      origin: ORIGIN,
      melt: 4,
      cell,
      smoothing: 0,
    })

    expect(rings).toHaveLength(1)
    const ring = rings[0] as Point[]
    // Every vertex on the circle, to within the grid's own resolution.
    for (const r of radii(ring)) expect(Math.abs(r - 30)).toBeLessThan(cell)
    // Closed: the wrap from last to first is no longer a step than any other.
    expect(longestEdge(ring)).toBeLessThan(cell * 1.5)
  })

  it('melts two overlapping falloffs into one surface, and keeps two apart as two', () => {
    const spec = { origin: ORIGIN, melt: 6, cell: 1.5, smoothing: 0 }
    const near = contourRings({
      ...spec,
      falloffs: [circle('a', -12, 0, 16), circle('b', 12, 0, 16)],
    })
    const far = contourRings({
      ...spec,
      falloffs: [circle('a', -60, 0, 16), circle('b', 60, 0, 16)],
    })

    expect(near).toHaveLength(1)
    expect(far).toHaveLength(2)
    for (const ring of [...near, ...far]) expect(longestEdge(ring)).toBeLessThan(1.5 * 1.5)
  })

  it('comes out watertight where the field saddles', () => {
    // Four falloffs in a square, each only just reaching its neighbours: the
    // ambiguous cell is the whole story here, and a mis-paired saddle would leave
    // a chain with nowhere to go — an open ring, and a hole in the fill.
    const rings = contourRings({
      falloffs: [
        circle('a', -14, -14, 15),
        circle('b', 14, -14, 15),
        circle('c', 14, 14, 15),
        circle('d', -14, 14, 15),
      ],
      origin: ORIGIN,
      melt: 2,
      cell: 1.2,
      smoothing: 0,
    })

    expect(rings.length).toBeGreaterThan(0)
    for (const ring of rings) {
      expect(ring.length).toBeGreaterThan(3)
      expect(longestEdge(ring)).toBeLessThan(1.2 * 1.5)
    }
  })

  it('gives a hole its own ring, which is why the painter fills even-odd', () => {
    // A collar of falloffs around an empty middle. The surface has two boundaries
    // and both are contours; filling them independently would paint the hole in.
    const collar = Array.from({ length: 10 }, (_, i) => {
      const angle = (i / 10) * Math.PI * 2
      return circle(`ring-${i}`, 40 * Math.cos(angle), 40 * Math.sin(angle), 12)
    })
    const rings = contourRings({ falloffs: collar, origin: ORIGIN, melt: 3, cell: 1.5, smoothing: 0 })

    expect(rings).toHaveLength(2)
    const [outer, inner] = rings
      .map((ring) => ({ ring, reach: Math.max(...radii(ring)) }))
      .sort((a, b) => b.reach - a.reach)
      .map((entry) => entry.ring) as [Point[], Point[]]
    expect(Math.max(...radii(inner))).toBeLessThan(Math.min(...radii(outer)))
  })

  it('draws nothing out of nothing', () => {
    const spec = { origin: ORIGIN, melt: 4, cell: 2, smoothing: 2 }
    expect(contourRings({ ...spec, falloffs: [] })).toEqual([])
    expect(contourRings({ ...spec, falloffs: [circle('gone', 0, 0, 0)] })).toEqual([])
    expect(contourRings({ ...spec, falloffs: [circle('one', 0, 0, 20)], cell: 0 })).toEqual([])
  })

  it('closes its rings even when the field is nowhere near the origin', () => {
    // The lattice is anchored on the origin and grown to reach the field, so an
    // off-centre field is the case where a too-small grid would clip a ring.
    const rings = contourRings({
      falloffs: [circle('far', 120, -80, 18)],
      origin: ORIGIN,
      melt: 4,
      cell: 2,
      smoothing: 0,
    })
    expect(rings).toHaveLength(1)
    expect(longestEdge(rings[0] as Point[])).toBeLessThan(3)
    for (const r of radii(rings[0] as Point[], { x: 120, y: -80 })) {
      expect(Math.abs(r - 18)).toBeLessThan(2)
    }
  })
})

/**
 * THE SAMPLING IS A SIMILARITY TRANSFORM — the property prd6 ruling 2's cap
 * rests on.
 *
 * The grid pitch is a fraction of the mass's own radius rather than a fixed
 * number of pixels, so scaling the field scales the contour and does not
 * re-quantise it. Without this, "the mass grew to exactly the cap" would be true
 * of the field and only approximately true of the picture, and the cap could only
 * ever be asserted to within half a cell.
 *
 * **The range is now a doubling, not #117's 1.3×** (#118). The cap used to be
 * +30% of the mass's resting size and is now half the scene's own distance to the
 * retirement band, which on a real panel is very near 2× — so the range this has
 * to hold over is the range the mass actually grows through.
 */
describe('scaling the field scales the contour, exactly', () => {
  const build = (scale: number): Point[][] =>
    contourRings({
      falloffs: [
        circle('a', 0, 0, 24 * scale),
        circle('b', 15 * scale, 6 * scale, 14 * scale),
        circle('c', -12 * scale, 11 * scale, 10 * scale),
      ],
      origin: ORIGIN,
      melt: 6 * scale,
      cell: 3 * scale,
      smoothing: 2,
    })

  const reach = (rings: Point[][]): number => Math.max(...rings.flatMap((ring) => radii(ring)))

  /**
   * THE PART THE CAP RESTS ON, and the part that holds at *every* ratio.
   *
   * "The mass grew to exactly the ceiling" is a claim about how far the contour
   * reaches, so this is the assertion prd6 ruling 2's cap actually leans on — and
   * it is exact to the last bit at every growth factor, because the lattice's
   * sample positions are a fixed set of multiples of the cell about the origin
   * and scaling the field scales that set with it.
   */
  it('scales the reach to the last bit, at every factor the mass grows by', () => {
    const unit = reach(build(1))
    for (const scale of [1.3, 1.71, 1.9, 1.98, 2, 2.4]) {
      expect(reach(build(scale)) / unit / scale, `${scale}× re-quantised the mass`).toBeCloseTo(
        1,
        12,
      )
    }
  })

  /**
   * …and vertex for vertex, at a factor where the lattice's own extent rounds the
   * same way. `half` is a `Math.ceil` of a ratio that is scale-invariant in real
   * arithmetic and not quite in floating point, so a handful of ratios buy or
   * lose one outer ring of cells and a few marginal crossings with it. That moves
   * no vertex the eye could find and moves the reach not at all (above), but it
   * does mean the vertex-for-vertex form of the claim has one honest caveat, and
   * writing the caveat down is better than picking the factor that hides it.
   */
  it('scales every vertex with it, in order, across a doubling', () => {
    const unit = build(1)
    const grown = build(2)
    expect(grown).toHaveLength(unit.length)

    const flat = (rings: Point[][]): Point[] => rings.flat()
    expect(flat(grown)).toHaveLength(flat(unit).length)
    flat(unit).forEach((point, i) => {
      const scaled = flat(grown)[i] as Point
      expect(scaled.x / 2).toBeCloseTo(point.x, 9)
      expect(scaled.y / 2).toBeCloseTo(point.y, 9)
    })
  })

  /**
   * …AND THE REAL FIELD STAYS ONE BODY THE WHOLE WAY UP.
   *
   * The similarity above is a claim about the technique; this is the claim about
   * the mass. Every distance in the body table is in units of the radius, so the
   * lobes overlap by the same amount at every size and the surface cannot come
   * apart as it grows — but "cannot" is the sort of word that stops being true
   * when somebody adds an octave, and a centre that had quietly become two
   * islands is exactly the failure #118's growth would make most visible.
   */
  it('walks the growing root-mass into one closed ring at every size', () => {
    let previous = 0
    for (const count of [0, 1, 6, 20]) {
      const frame = frameFor(count === 0 ? undefined : landed(count, cutAt(CUT.totalMs)))
      const radius = frame.geometry.rootRadius
      const rings = contourRings({
        falloffs: rootFalloffs(frame, radius),
        origin: frame.geometry.centre,
        melt: radius * 0.13,
        cell: radius * 0.078,
        smoothing: 2,
      })

      expect(rings, `${count} landings split the mass`).toHaveLength(1)
      const ring = rings[0] as Point[]
      // Still a body rather than a disc or a scatter, at every size.
      const out = radii(ring, frame.geometry.centre)
      expect(Math.min(...out) / Math.max(...out)).toBeLessThan(0.9)
      expect(Math.min(...out) / Math.max(...out)).toBeGreaterThan(0.6)
      // …and the grid still never shows: the lattice grew with the mass, so the
      // vertices stay under a pixel apart however big the body got.
      expect(longestEdge(ring), `${count} landings showed the grid`).toBeLessThan(1.5)

      expect(Math.max(...out)).toBeGreaterThan(previous)
      previous = Math.max(...out)
    }
  })
})

describe('Chaikin — so the grid never shows as stair-steps', () => {
  const square: Point[] = [
    { x: -10, y: -10 },
    { x: 10, y: -10 },
    { x: 10, y: 10 },
    { x: -10, y: 10 },
  ]

  it('doubles the vertices and halves the step, per pass', () => {
    expect(chaikin(square, 0)).toEqual(square)
    expect(chaikin(square, 1)).toHaveLength(8)
    expect(chaikin(square, 2)).toHaveLength(16)
    expect(chaikin(square, 3)).toHaveLength(32)
    expect(longestEdge(chaikin(square, 2))).toBeLessThan(longestEdge(chaikin(square, 1)))
  })

  it('stops at three passes however many are asked for (the ruling\'s ceiling)', () => {
    expect(MAX_SMOOTHING).toBe(3)
    expect(chaikin(square, 9)).toEqual(chaikin(square, MAX_SMOOTHING))
    expect(chaikin(square, -4)).toEqual(square)
  })

  it('cuts every corner, including the one at the seam', () => {
    // The whole difference from the open-curve version. An open Chaikin leaves
    // the first and last vertices pinned, so a ring smoothed with it keeps one
    // sharp corner exactly where its seam happens to be — a visible artefact in a
    // shape whose seam is wherever the grid walk started.
    const turn = (ring: readonly Point[], i: number): number => {
      const a = ring[(i - 1 + ring.length) % ring.length] as Point
      const b = ring[i] as Point
      const c = ring[(i + 1) % ring.length] as Point
      const before = Math.atan2(b.y - a.y, b.x - a.x)
      const after = Math.atan2(c.y - b.y, c.x - b.x)
      return Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before)))
    }
    const cut = chaikin(square, 2)
    const sharpest = Math.max(...cut.map((_, i) => turn(cut, i)))
    expect(sharpest).toBeLessThan(Math.PI / 2)
  })

  it('keeps the shape it smoothed — the mass does not shrink away', () => {
    const cut = chaikin(square, 3)
    // Inside the original, as corner-cutting always is, but only just.
    expect(Math.max(...cut.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))))).toBeLessThanOrEqual(10)
    expect(Math.min(...radii(cut))).toBeGreaterThan(8)
  })

  it('leaves a degenerate ring alone rather than folding it up', () => {
    expect(chaikin([], 2)).toEqual([])
    expect(chaikin([{ x: 1, y: 2 }], 2)).toEqual([{ x: 1, y: 2 }])
  })

  it('puts the finished contour\'s vertices under a pixel apart at the scene\'s scale', () => {
    // The claim the ruling actually makes: the grid must not read as steps. Two
    // passes over a ~6px lattice is what buys it.
    const radius = 57
    const rings = contourRings({
      falloffs: rootFalloffs(frameFor(), radius),
      origin: frameFor().geometry.centre,
      melt: radius * 0.24,
      cell: radius * 0.13,
      smoothing: 2,
    })
    expect(rings).toHaveLength(1)
    expect(longestEdge(rings[0] as Point[])).toBeLessThan(2.2)
  })
})

// ── the frame these read the real field off ─────────────────────────────────

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const SIZE = { width: 900, height: 260 }
const FLEET = buildFleet(reduceAll(fixtureHistory(fleet20Spec(), NOW)), {
  now: NOW,
  manifest: manifestFor(fleet20Spec()),
})

function landed(count: number, state: RetireState): Map<string, RetireState> {
  return new Map(FLEET.lanes.slice(0, count).map((lane) => [lane.id, state]))
}

function frameFor(retire?: ReadonlyMap<string, RetireState>): SceneFrame {
  return {
    fleet: FLEET,
    geometry: layoutScene(FLEET, { ...SIZE, now: NOW, ...(retire === undefined ? {} : { retire }) }),
    field: new PulseField(),
    salience: salienceOf({ fleet: FLEET, hoverId: null, selectedId: null }),
    now: NOW,
    reducedMotion: false,
    paused: false,
    breath: breathOf(NOW, motionMode({ reducedMotion: false, paused: false })),
  }
}
