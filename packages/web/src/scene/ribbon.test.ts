import { describe, expect, it } from 'vitest'
import type { Point } from './geometry.js'
import {
  PINCH_EPSILON,
  RIBBON_SAMPLES_MAX,
  sampleCount,
  ribbonOutline,
  smoothSpine,
  widthOf,
  type RibbonShape,
} from './ribbon.js'

/**
 * WHAT A RIBBON PROMISES (prd7 ruling 3).
 *
 * The scene stopped stroking lines, and the whole bet is that filling a varying
 * width buys expressiveness *without* costing legibility — that a lane's encoded
 * facts stay readable off the polygon that is actually drawn. So these are not
 * tests about a curve looking nice. They are the two promises the ruling makes,
 * pinned as arithmetic:
 *
 * 1. **the spine interpolates its waypoints.** Centripetal Catmull-Rom passes
 *    through its control points, which is why it was chosen over `curveBasis`;
 *    if it did not, every position the layout encodes would be a position the
 *    picture approximates.
 * 2. **the drawn width is the encoded width.** Measured off the outline, not off
 *    the fields that asked for it — because the fields are what a test would
 *    read *instead*, and then the mapping through `perfect-freehand` would be
 *    the one part of this nobody was checking.
 *
 * Plus the property everything in this file exists to protect: a ribbon is a
 * pure function of its inputs. Same spine, same polygon, byte for byte, for ever.
 */

const SPINE: Point[] = Array.from({ length: 25 }, (_unused, i) => {
  const t = i / 24
  return { x: 100 + t * 300, y: 100 + Math.sin(t * Math.PI) * 60 }
})

function shapeOf(over: Partial<RibbonShape> = {}): RibbonShape {
  return { spine: SPINE, widthRoot: 6, widthTip: 1, ...over }
}

/** Point at `t` along a sampled path — the ribbon's own convention. */
function at(path: readonly Point[], t: number): Point {
  const on = Math.max(0, Math.min(1, t)) * (path.length - 1)
  const i = Math.floor(on)
  const a = path[i] as Point
  const b = path[Math.min(path.length - 1, i + 1)] as Point
  const f = on - i
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

/**
 * The parameter of the ribbon sample nearest `t`.
 *
 * The measurement below is only exact *at* a sample: between two of them the
 * nearest outline vertex is offset along the length as well as across it, and
 * the extra leg of that triangle is a property of the spine's resolution rather
 * than of the ribbon's width. Snapping first is what keeps the test measuring
 * the thing it claims to.
 */
function snap(shape: RibbonShape, t: number): number {
  const samples = shape.samples ?? sampleCount(shape.spine)
  return Math.round(t * samples) / samples
}

/**
 * The width the polygon was actually drawn at, near `t`.
 *
 * The nearest outline vertex to a point on the spine sits one half-width away
 * from it, so twice that distance is the width. Crude on purpose: it is the
 * measurement somebody reading the picture would make, which is the only kind
 * that proves the encoding survived the drawing.
 */
function drawnWidth(shape: RibbonShape, t: number): number {
  const vertices = ribbonOutline(shape).flat()
  const on = at(shape.spine, snap(shape, t))
  return 2 * Math.min(...vertices.map((v) => Math.hypot(v.x - on.x, v.y - on.y)))
}

describe('the spine interpolates its waypoints', () => {
  const waypoints: Point[] = [
    { x: 0, y: 0 },
    { x: 30, y: 40 },
    { x: 90, y: 10 },
    { x: 140, y: 70 },
    { x: 200, y: 20 },
  ]

  it('puts every waypoint back, exactly — encoded positions do not move', () => {
    // The reason `curveCatmullRom` is here and `curveBasis` is banned. A layout
    // waypoint carries meaning (where a thread leaves the mass, where its node
    // came to rest); an approximating spline would draw the picture *near* those
    // places, which is a scene quietly lying about its own encoding.
    const spine = smoothSpine(waypoints, 40)
    for (const wanted of waypoints) {
      const nearest = Math.min(...spine.map((p) => Math.hypot(p.x - wanted.x, p.y - wanted.y)))
      expect(nearest, `(${wanted.x}, ${wanted.y}) left the curve`).toBeLessThan(1e-9)
    }
  })

  it('starts and ends on the ends, whatever the sample count', () => {
    for (const steps of [8, 27, 44, 96]) {
      const spine = smoothSpine(waypoints, steps)
      expect(spine[0]).toEqual(waypoints[0])
      expect(spine[spine.length - 1]).toEqual(waypoints[waypoints.length - 1])
    }
  })

  it('has no corner left in it — which is the whole of "less janky"', () => {
    // Stated as the sharpest joint rather than the total turning, because total
    // turning is not a smoothness measure: a curve that bends continuously can
    // easily turn *further* overall than the polygon it rounds off, and still be
    // the thing without corners in it. What the eye reads as jank is the corner.
    const sharpest = (path: readonly Point[]): number => {
      let worst = 0
      for (let i = 1; i < path.length - 1; i += 1) {
        const a = path[i - 1] as Point
        const b = path[i] as Point
        const c = path[i + 1] as Point
        let delta = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)
        while (delta > Math.PI) delta -= 2 * Math.PI
        while (delta < -Math.PI) delta += 2 * Math.PI
        worst = Math.max(worst, Math.abs(delta))
      }
      return worst
    }

    // The control polygon has a right-angle in it; the curve through it has
    // nothing anywhere near one.
    expect(sharpest(waypoints)).toBeGreaterThan(1)
    const coarse = sharpest(smoothSpine(waypoints, 40))
    expect(coarse).toBeLessThan(sharpest(waypoints) / 3)

    // …and the joints that are left are *curvature*, not corners, which is the
    // difference that matters under the prd5 camera: sample it twice as finely
    // and they halve. A corner would still be there at any resolution, which is
    // precisely what a zoomed-in stroked polyline used to show.
    expect(sharpest(smoothSpine(waypoints, 80))).toBeLessThan(coarse * 0.7)
  })

  it('hands back a degenerate spine unchanged rather than inventing one', () => {
    expect(smoothSpine([], 10)).toEqual([])
    expect(smoothSpine([{ x: 3, y: 4 }], 10)).toEqual([{ x: 3, y: 4 }])
  })
})

describe('the outline is the encoding, drawn', () => {
  it('is as wide as the width it was asked for, at both ends and in the middle', () => {
    const shape = shapeOf()
    for (const t of [0.125, 0.375, 0.5, 0.75, 0.875]) {
      expect(drawnWidth(shape, t), `wrong width at ${t}`).toBeCloseTo(
        widthOf(shape, snap(shape, t)),
        1,
      )
    }
  })

  it('recovers the work-size ordering off the polygon alone', () => {
    // prd6 ruling 1's claim, read through prd7's drawing: a bigger lane is a
    // visibly wider ribbon, and it stays so after the outline builder has had it.
    const small = drawnWidth(shapeOf({ widthRoot: 2, widthTip: 0.6 }), 0.3)
    const large = drawnWidth(shapeOf({ widthRoot: 8, widthTip: 2 }), 0.3)
    expect(large).toBeGreaterThan(small * 3)
  })

  it('tapers: a hypha is thinner where it is reaching', () => {
    const shape = shapeOf()
    expect(drawnWidth(shape, 0.9)).toBeLessThan(drawnWidth(shape, 0.1))
  })

  it('closes: one polygon, and the last vertex meets the first', () => {
    const [polygon] = ribbonOutline(shapeOf())
    expect(polygon).toBeDefined()
    const first = (polygon as Point[])[0] as Point
    const last = (polygon as Point[])[(polygon as Point[]).length - 1] as Point
    expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeLessThan(1)
  })

  it('draws nothing for a ribbon with no width — absence is not a hairline', () => {
    expect(ribbonOutline(shapeOf({ widthRoot: 0, widthTip: 0 }))).toEqual([])
  })

  it('keeps its point count bounded, so a fleet cannot subdivide its way to jank', () => {
    const samples = sampleCount(SPINE)
    const points = ribbonOutline(shapeOf()).flat().length
    // Two sides plus the two round caps — the shape the prd7 probe measured.
    expect(points).toBeGreaterThan(samples * 2)
    expect(points).toBeLessThan(samples * 2 + 60)
    // …and however dense a spine it is handed, it stops sampling somewhere.
    const dense = Array.from({ length: 400 }, (_unused, i) => at(SPINE, i / 399))
    expect(sampleCount(dense)).toBe(RIBBON_SAMPLES_MAX)
  })
})

describe('determinism — the same fleet draws the same polygon', () => {
  it('is byte-identical across calls', () => {
    // Not "close enough": a replay of a log recorded on another machine has to
    // produce this picture, and a builder that drifted by a float would make
    // every screenshot comparison in the instrument a judgement call.
    const once = ribbonOutline(shapeOf({ dashed: true, taperTip: 0.2 }))
    const twice = ribbonOutline(shapeOf({ dashed: true, taperTip: 0.2 }))
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  it('reads no clock — the same shape a second later', () => {
    const before = JSON.stringify(ribbonOutline(shapeOf()))
    const spun = Array.from({ length: 5_000 }, (_unused, i) => Math.sin(i)).length
    expect(spun).toBe(5_000)
    expect(JSON.stringify(ribbonOutline(shapeOf()))).toBe(before)
  })
})

describe('the substitutions, as width', () => {
  it('a pinch closes the ribbon to nothing, and parts it in two', () => {
    // FROZEN's cut (`marks/thread.ts`). The point is that this is a *severing*
    // rather than a mark laid over a line that carries on: the polygon count
    // goes up because the thread is genuinely in pieces.
    const whole = ribbonOutline(shapeOf())
    const cut = ribbonOutline(shapeOf({ stops: [{ at: 0.5, span: 0.07, scale: 0, flat: 0.5 }] }))

    expect(whole).toHaveLength(1)
    expect(cut).toHaveLength(2)
    expect(widthOf(shapeOf({ stops: [{ at: 0.5, span: 0.07, scale: 0, flat: 0.5 }] }), 0.5))
      .toBeLessThanOrEqual(PINCH_EPSILON)
  })

  it('closes where it was told to, not where a sample happened to land', () => {
    // The `flat` bottom is what makes this true. Without it the closure would
    // only bite when a sample fell on the exact parameter, so "is this lane
    // severed?" would depend on the resolution the ribbon was drawn at.
    for (const samples of [12, 16, 24, 40]) {
      const cut = ribbonOutline(
        shapeOf({ samples, stops: [{ at: 0.62, span: 0.07, scale: 0, flat: 0.5 }] }),
      )
      expect(cut, `${samples} samples did not part the ribbon`).toHaveLength(2)
    }
  })

  it('a swell thickens the ribbon where it is, and nowhere else', () => {
    // A commit, travelling (`marks/light.ts`). The channel is one the thread
    // already owns, so the packet is not a new object riding above the line.
    const plain = shapeOf({ widthRoot: 3, widthTip: 3 })
    const swollen = shapeOf({
      widthRoot: 3,
      widthTip: 3,
      stops: [{ at: 0.4, span: 0.12, scale: 2.2 }],
    })
    expect(drawnWidth(swollen, 0.4)).toBeGreaterThan(drawnWidth(plain, 0.4) * 1.8)
    expect(drawnWidth(swollen, 0.8)).toBeCloseTo(drawnWidth(plain, 0.8), 1)
  })

  it('a tip taper needles the end without moving the spine', () => {
    // EXPENSIVE's direction cue. Width, not position: the node is where the
    // lifecycle put it, and a taper that shortened the thread would be spending
    // the locked radial channel to say something about money.
    const blunt = shapeOf()
    const needled = shapeOf({ taperTip: 0.25 })
    expect(drawnWidth(needled, 0.95)).toBeLessThan(drawnWidth(blunt, 0.95))
    expect(drawnWidth(needled, 0.5)).toBeCloseTo(drawnWidth(blunt, 0.5), 6)
    expect(ribbonOutline(needled)).toHaveLength(1)
  })

  it('a dashed ribbon is drawn in runs — broken, not merely thin', () => {
    const runs = ribbonOutline(shapeOf({ dashed: true }))
    expect(runs.length).toBeGreaterThan(2)
    for (const polygon of runs) expect(polygon.length).toBeGreaterThan(2)
  })

  it('lets a cut and a dash compose — a frozen thread is both', () => {
    const both = ribbonOutline(
      shapeOf({ dashed: true, stops: [{ at: 0.5, span: 0.07, scale: 0, flat: 0.5 }] }),
    )
    expect(both.length).toBeGreaterThan(ribbonOutline(shapeOf({ dashed: true })).length - 1)
  })
})

describe('the width profile', () => {
  it('never goes negative, however the modulations stack', () => {
    const shape = shapeOf({
      stops: [
        { at: 0.5, span: 0.3, scale: 0 },
        { at: 0.55, span: 0.3, scale: 0 },
      ],
      taperTip: 0.4,
      modulate: () => 0.9,
    })
    for (let t = 0; t <= 1.0001; t += 0.02) expect(widthOf(shape, t)).toBeGreaterThanOrEqual(0)
  })

  it('leaves the encoded taper alone where nothing modulates it', () => {
    const shape = shapeOf({ stops: [{ at: 0.2, span: 0.05, scale: 0 }] })
    expect(widthOf(shape, 0.8)).toBeCloseTo(6 + (1 - 6) * 0.8, 9)
  })
})
