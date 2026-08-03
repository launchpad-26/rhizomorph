import { describe, expect, it } from 'vitest'
import { heartAnatomy, ringContour, type Landing } from './heart.js'
import type { Point } from './geometry.js'

/**
 * THE MYCORRHIZAL ANATOMY (prd10 ruling 3), as geometry.
 *
 * Three claims are worth a test here, and each of them is a claim the *picture*
 * cannot make on its own:
 *
 * - **the ring closes seamlessly.** The spike's verdict was to sample the noise
 *   field around a circle rather than along an angle, and the whole point of that
 *   choice is invisible in a display list and obvious on a canvas: a join. So the
 *   test walks across the seam.
 * - **it is baked once per landing.** "Never per frame" is a performance claim, and
 *   a performance claim that nothing checks is a comment. The cache is asserted by
 *   identity: the same roster gets the same object back.
 * - **it is data-honest.** One ring per landing, in the order they landed, seeded
 *   from the lane whose landing deposited it — so no ring can exist for a lane that
 *   did not land and no two sessions draw the same rings by accident.
 */

function landing(seed: string, sizeFrac = 0.5): Landing {
  return { laneId: seed, seed, sizeFrac }
}

/** Distance from the origin — the unit-space radius a ring point sits at. */
function radiusOf(point: Point): number {
  return Math.hypot(point.x, point.y)
}

describe('a growth ring', () => {
  it('closes without a seam, whatever angle the walk started at', () => {
    // The failure this is about: `r(θ) = 1 + a·noise(θ)` has a step at the join,
    // because `noise(0)` and `noise(2π)` are different numbers. Sampling the field
    // along the circle `(cos θ, sin θ)` closes by construction — θ and θ + 2π are
    // the same *point* in the field — and the way to see that is to compare the
    // step across the wrap with the steps everywhere else.
    const ring = ringContour(0.5, 0.06, 'a-lane')
    const step = (i: number): number =>
      Math.hypot(
        (ring[(i + 1) % ring.length] as Point).x - (ring[i] as Point).x,
        (ring[(i + 1) % ring.length] as Point).y - (ring[i] as Point).y,
      )

    const wrap = step(ring.length - 1)
    const elsewhere = Array.from({ length: ring.length - 1 }, (_unused, i) => step(i))
    const longest = Math.max(...elsewhere)
    // The wrap is an edge like any other. A seam would show up here as a step an
    // order of magnitude larger than its neighbours.
    expect(wrap).toBeLessThanOrEqual(longest * 1.35)
  })

  it('stays inside the spike’s amplitude band, so two rings never cross', () => {
    // 0.02–0.06 of the ring's own radius. Below the band a ring is a compass
    // circle — the exact form prd7 ruling 5 removed from this mass; above it, a
    // ring wanders far enough to cross its neighbour and the memoir becomes a
    // scribble. The band is the reason the amplitude can carry work size at all.
    for (const amplitude of [0.02, 0.04, 0.06]) {
      const ring = ringContour(0.5, amplitude, `lane-${amplitude}`)
      for (const point of ring) {
        expect(Math.abs(radiusOf(point) / 0.5 - 1)).toBeLessThanOrEqual(amplitude + 1e-9)
      }
    }
  })

  it('is irregular rather than round — and differently so per lane', () => {
    const ring = ringContour(0.5, 0.06, 'a-lane')
    const radii = ring.map(radiusOf)
    // Actually irregular: a compass circle would have zero spread.
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.5 * 0.02)

    // …and seeded from the lane, so two landings do not lay down the same ring.
    // Adjacent lane names are the case that matters (`variation.ts`'s own finding):
    // a hash rather than a character sum, so `113-` and `114-` are not neighbours.
    const other = ringContour(0.5, 0.06, 'b-lane')
    const differ = ring.filter(
      (point, i) => Math.abs(radiusOf(point) - radiusOf(other[i] as Point)) > 1e-6,
    )
    expect(differ.length).toBeGreaterThan(ring.length / 2)
  })

  it('is the same ring in a replay as in the session that recorded it', () => {
    // No clock, no `Math.random`: the same lane lays down the same ring on any
    // machine, which is what makes a recorded session replay as the same picture.
    expect(ringContour(0.5, 0.04, 'a-lane')).toEqual(ringContour(0.5, 0.04, 'a-lane'))
  })
})

describe('the heart anatomy', () => {
  it('deposits exactly one ring per landing, and none for anything else', () => {
    const roster = [landing('one'), landing('two'), landing('three')]
    const anatomy = heartAnatomy(roster, 'main')
    expect(anatomy.rings).toHaveLength(3)
    expect(anatomy.rings.map((ring) => ring.laneId)).toEqual(['one', 'two', 'three'])
    expect(heartAnatomy([], 'main').rings).toHaveLength(0)
  })

  it('lays each ring outside the one before it — the memoir reads outward', () => {
    const anatomy = heartAnatomy([landing('one'), landing('two'), landing('three')], 'main')
    const radii = anatomy.rings.map((ring) => ring.at)
    for (let i = 1; i < radii.length; i += 1) {
      expect(radii[i] as number).toBeGreaterThan(radii[i - 1] as number)
    }
    // Interior anatomy: inside the rim, and clear of the very middle where the
    // core glow is.
    expect(Math.min(...radii)).toBeGreaterThan(0.15)
    expect(Math.max(...radii)).toBeLessThan(1)
  })

  it('does not move a ring that is already there when a new lane lands', () => {
    // What a growth ring *is*: wood laid down outside the wood that was already
    // there. A roster that re-spaced itself on every landing would be a diagram
    // redrawn, and the memoir's whole claim — that the second ring is the second
    // landing — would stop being legible over the course of a session.
    const two = heartAnatomy([landing('one'), landing('two')], 'main')
    const three = heartAnatomy([landing('one'), landing('two'), landing('three')], 'main')
    expect(three.rings[0]?.at).toBe(two.rings[0]?.at)
    expect(three.rings[1]?.at).toBe(two.rings[1]?.at)
  })

  it('compresses rather than overflowing once the band is full', () => {
    // Past ten landings the band has to share, which is also what a tree does.
    // What it may never do is put a ring outside the rim.
    const many = heartAnatomy(
      Array.from({ length: 40 }, (_unused, i) => landing(`lane-${i}`)),
      'main',
    )
    expect(many.rings).toHaveLength(40)
    for (const ring of many.rings) {
      expect(ring.at).toBeGreaterThan(0)
      expect(ring.at).toBeLessThan(1)
      for (const point of ring.ring) expect(radiusOf(point)).toBeLessThan(1)
    }
  })

  it('bakes once per roster and hands the same object back', () => {
    // The performance claim, as identity rather than as a comment. "Baked once per
    // landing, never per frame" is only true if a second call with the same roster
    // does no work — which is what the painter's `Path2D` cache depends on, since
    // it is keyed on `bake`.
    const roster = [landing('one'), landing('two')]
    const first = heartAnatomy(roster, 'main')
    const second = heartAnatomy([landing('one'), landing('two')], 'main')
    expect(second).toBe(first)
    expect(second.bake).toBe(first.bake)

    // …and a *different* roster is a different bake, so a landing genuinely
    // rebuilds rather than reusing somebody else's rings.
    const grown = heartAnatomy([...roster, landing('three')], 'main')
    expect(grown).not.toBe(first)
    expect(grown.bake).not.toBe(first.bake)
  })

  it('keeps the work-size channel on the ring rather than on the roster', () => {
    // prd6 ruling 1's fact, moved to the mark a landing leaves for good (ruling 2
    // took the rim stubs away). A bigger landing lays down a rougher, heavier ring.
    const small = heartAnatomy([landing('small', 0)], 'main').rings[0]
    const large = heartAnatomy([landing('large', 1)], 'main').rings[0]
    expect(small?.sizeFrac).toBe(0)
    expect(large?.sizeFrac).toBe(1)

    const spread = (ring: readonly Point[]): number => {
      const radii = ring.map(radiusOf)
      return Math.max(...radii) - Math.min(...radii)
    }
    expect(spread(large?.ring ?? [])).toBeGreaterThan(spread(small?.ring ?? []))
  })
})

describe('the hyphal fan', () => {
  it('radiates rimward, and every strand starts inside and ends at the rim', () => {
    const { fan } = heartAnatomy([], 'main')
    expect(fan.length).toBeGreaterThan(12)

    for (const strand of fan) {
      const radii = strand.map(radiusOf)
      const first = radii[0] as number
      const last = radii[radii.length - 1] as number
      // Outward, monotone: a strand that doubled back would read as a scribble
      // rather than as a lattice.
      for (let i = 1; i < radii.length; i += 1) {
        expect(radii[i] as number).toBeGreaterThan(radii[i - 1] as number)
      }
      // It leaves the interior and reaches the rim, where the threads outside pick
      // up — which is the whole claim: the mass is the middle of a network.
      expect(first).toBeGreaterThan(0.2)
      expect(first).toBeLessThan(0.6)
      expect(last).toBeGreaterThan(0.85)
    }
  })

  it('is unequal — no rotational symmetry for the eye to lock onto', () => {
    const { fan } = heartAnatomy([], 'main')
    const lengths = fan.map((strand) => {
      const radii = strand.map(radiusOf)
      return (radii[radii.length - 1] as number) - (radii[0] as number)
    })
    // A sunburst would have one length repeated; this must not.
    expect(new Set(lengths.map((length) => length.toFixed(4))).size).toBeGreaterThan(fan.length / 2)
  })

  it('is the same fan for the same repo, and does not depend on the rings', () => {
    // Seeded off the main branch alone: the mass has the same lattice all session
    // and in every replay of it, and a landing rebakes the rings without disturbing
    // the anatomy around them.
    const bare = heartAnatomy([], 'main')
    const landed = heartAnatomy([landing('one')], 'main')
    expect(landed.fan).toEqual(bare.fan)
    expect(heartAnatomy([], 'other-branch').fan).not.toEqual(bare.fan)
  })
})
