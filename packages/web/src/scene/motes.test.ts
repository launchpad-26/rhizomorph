import { describe, expect, it } from 'vitest'
import type { Point } from './geometry.js'
import { DISSOLUTION } from './motion.js'
import { dissolutionMotes, moteCount, type Dissolve } from './motes.js'
import { DONE, luminance } from './palette.js'

/**
 * THE COMPOSTING DECAY (prd10 rulings 2, 10 and 12), as arithmetic.
 *
 * The display-list half is in `marks.test.ts` — that a cut emits a drift at all,
 * and that a replay does not. This is the half underneath it: given a cord and a
 * progress, *where* is its matter and *what colour* is it. Four properties, and
 * each of them is one the picture would be wrong without:
 *
 * 1. the cord unravels **from the cut outward** while every mote travels home;
 * 2. a mote rides the spine rather than the space beside it;
 * 3. the drift is inside the pool, per lane and in total;
 * 4. it is a pure function — same cord, same progress, same drift, in a live
 *    session and in a replay of it on another machine.
 */

/** A straight cord, home (index 0) to the far end. Straight so distances are readable. */
const SPINE: Point[] = Array.from({ length: 21 }, (_unused, i) => ({ x: i * 10, y: 0 }))

function job(overrides: Partial<Dissolve> = {}): Dissolve {
  return {
    cause: 'severance',
    spine: SPINE,
    progress: 0.5,
    sizeFrac: 1,
    family: DONE,
    seed: 'a-lane',
    peak: 0.6,
    ...overrides,
  }
}

/** How far along the cord a mote is, in the spine's own units (0 = home). */
function along(point: Point): number {
  return point.x
}

describe('a cord coming apart', () => {
  it('draws nothing before it starts or after it has finished', () => {
    // The end of the act is the end of the act: at progress 1 the last mote has
    // landed, and what is left is a heart with a ring in it. A drift that outlived
    // its own span would be matter with nowhere to arrive.
    expect(dissolutionMotes(job({ progress: 0 }), DISSOLUTION.maxLive)).toHaveLength(0)
    expect(dissolutionMotes(job({ progress: 1 }), DISSOLUTION.maxLive)).toHaveLength(0)
    expect(dissolutionMotes(job({ progress: 1.4 }), DISSOLUTION.maxLive)).toHaveLength(0)
  })

  it('unravels outward from the cut, and only that far', () => {
    // Birth delay proportional to distance from the cut, which is at home: early in
    // the act only the near end has come apart, and the far end of the cord has not
    // started. The reading is a fraying front running out along the cord while every
    // piece of it streams in — which is what "the cord unravels into the mass" is.
    const early = dissolutionMotes(job({ progress: 0.12 }), DISSOLUTION.maxLive)
    const late = dissolutionMotes(job({ progress: 0.62 }), DISSOLUTION.maxLive)
    expect(early.length).toBeGreaterThan(0)

    // Nothing has been born past the front yet…
    const front = Math.max(...early.map((mote) => along(mote.at)))
    const total = along(SPINE[SPINE.length - 1] as Point)
    expect(front).toBeLessThan(total * 0.5)
    // …and by the end of the birth window, the far end has.
    expect(Math.max(...late.map((mote) => along(mote.at)))).toBeGreaterThan(front)
  })

  it('carries every mote home along the cord rather than across the gap', () => {
    // A mote's position is a parameter along the stored spine, so the drift follows
    // the hypha that was there: substance translocated through a network, not thrown
    // across it. On a straight cord that shows up as `y` never leaving the line.
    for (const progress of [0.2, 0.5, 0.8, 0.95]) {
      for (const mote of dissolutionMotes(job({ progress }), DISSOLUTION.maxLive)) {
        expect(Math.abs(mote.at.y)).toBeLessThan(1e-9)
        expect(along(mote.at)).toBeGreaterThanOrEqual(-1e-9)
      }
    }
  })

  it('has every mote nearer home at the end of its life than at the start', () => {
    // The direction is the whole ruling: matter *returns*. One mote, followed
    // across the act — the same index, which is the same piece of cord.
    const at = (progress: number): number | null => {
      const motes = dissolutionMotes(job({ progress, sizeFrac: 0 }), DISSOLUTION.maxLive)
      return motes.length === 0 ? null : along(motes[0]?.at as Point)
    }
    const track = [0.05, 0.1, 0.15, 0.2].map(at).filter((x): x is number => x !== null)
    expect(track.length).toBeGreaterThan(2)
    for (let i = 1; i < track.length; i += 1) {
      expect(track[i] as number).toBeLessThan(track[i - 1] as number)
    }
  })

  it('is born its lane own colour and cools into the accent (ruling 12)', () => {
    // The gradient is `returningInk`'s and is asserted in `palette.test.ts`; what
    // this pins is that the drift *spends* it along the journey — the motes nearest
    // the cut are still green and the ones arriving are not.
    const motes = dissolutionMotes(job({ progress: 0.5 }), DISSOLUTION.maxLive)
    expect(motes.length).toBeGreaterThan(4)
    const sorted = [...motes].sort((a, b) => along(b.at) - along(a.at))
    const young = sorted[0]?.ink.rgb as [number, number, number]
    const arriving = sorted[sorted.length - 1]?.ink.rgb as [number, number, number]

    // Green-dominant at the cut; violet-dominant (blue over green) at the heart.
    expect(young[1]).toBeGreaterThan(young[2])
    expect(arriving[2]).toBeGreaterThan(arriving[1])
  })

  it('fades in luminance and never in size (ruling 10)', () => {
    // The class's own rule, checked where it is actually spent. A mote's radius is a
    // pure function of *which piece of cord it is* — never of how far through its
    // life it has got — so across the whole act the drift draws from a small fixed
    // table of sizes while its luminance takes a continuum of values.
    //
    // Sampled across the act rather than per index on purpose: the live motes are a
    // moving window, so `items[0]` is a different piece of cord at every progress
    // and comparing by position would be comparing two different motes.
    const radii = new Set<string>()
    const lights = new Set<string>()
    for (let progress = 0.02; progress < 1; progress += 0.02) {
      for (const mote of dissolutionMotes(job({ progress, sizeFrac: 0 }), DISSOLUTION.maxLive)) {
        radii.add(mote.radius.toFixed(6))
        lights.add(luminance(mote.ink).toFixed(6))
      }
    }
    expect(radii.size, 'a mote changed size over its life').toBeLessThanOrEqual(5)
    expect(lights.size, 'a mote never changed brightness').toBeGreaterThan(radii.size * 4)

    // …and every mote is under the peak it was handed, which is what keeps a drift
    // inside the calm band without the budget having to visit two hundred inks.
    for (const mote of dissolutionMotes(job(), DISSOLUTION.maxLive)) {
      expect(luminance(mote.ink)).toBeLessThanOrEqual(0.6)
    }
  })
})

describe('the pool', () => {
  it('never exceeds the per-lane share, whatever the lane produced', () => {
    for (const sizeFrac of [0, 0.5, 1, 4]) {
      expect(moteCount(sizeFrac)).toBeLessThanOrEqual(DISSOLUTION.maxPerLane)
      expect(dissolutionMotes(job({ sizeFrac }), DISSOLUTION.maxLive).length).toBeLessThanOrEqual(
        DISSOLUTION.maxPerLane,
      )
    }
  })

  it('scales the drift with the substance that came apart', () => {
    // A mote is a piece of a lane's work, so a big landing comes apart into more of
    // them. Monotone, so the reading is honest at every size in between.
    expect(moteCount(1)).toBeGreaterThan(moteCount(0))
    for (let size = 0; size < 1; size += 0.1) {
      expect(moteCount(size + 0.1)).toBeGreaterThanOrEqual(moteCount(size))
    }
  })

  it('truncates to whatever is left of the pool rather than overrunning it', () => {
    // The ceiling is scene-wide, so an act is handed what the acts before it left.
    expect(dissolutionMotes(job(), 3).length).toBeLessThanOrEqual(3)
    expect(dissolutionMotes(job(), 0)).toHaveLength(0)
    expect(dissolutionMotes(job(), -5)).toHaveLength(0)
  })

  it('refuses a cord with no geometry rather than inventing one', () => {
    expect(dissolutionMotes(job({ spine: [] }), DISSOLUTION.maxLive)).toHaveLength(0)
    expect(dissolutionMotes(job({ spine: [{ x: 0, y: 0 }] }), DISSOLUTION.maxLive)).toHaveLength(0)
  })
})

describe('an absorbed bud — ruling 2 in miniature', () => {
  it('is the same arithmetic, aimed at the junction rather than at the mass', () => {
    // Ruling 9's completion grammar: the bud's matter goes back into the *parent*,
    // so the only difference from a severance is which end of the spine is home.
    // Same function, same class, same pool — which is the point.
    const bud = dissolutionMotes(
      job({ cause: 'absorption', sizeFrac: 0, seed: 'a-lane/bud' }),
      DISSOLUTION.maxLive,
    )
    expect(bud.length).toBeGreaterThan(0)
    expect(bud.length).toBeLessThanOrEqual(moteCount(0))
    for (const mote of bud) expect(along(mote.at)).toBeGreaterThanOrEqual(-1e-9)
  })
})

describe('determinism', () => {
  it('draws the same drift twice — no clock, no random', () => {
    // The property a replay depends on, and the reason `motes.ts` reads neither
    // `Date.now` nor `Math.random`: the same cord at the same progress is the same
    // picture on any machine, in any session.
    expect(dissolutionMotes(job(), DISSOLUTION.maxLive)).toEqual(
      dissolutionMotes(job(), DISSOLUTION.maxLive),
    )
  })

  it('gives two lanes different motes from the same cord', () => {
    const mine = dissolutionMotes(job({ seed: 'a-lane' }), DISSOLUTION.maxLive)
    const yours = dissolutionMotes(job({ seed: 'another-lane-entirely' }), DISSOLUTION.maxLive)
    expect(mine.map((mote) => mote.radius)).not.toEqual(yours.map((mote) => mote.radius))
  })
})
