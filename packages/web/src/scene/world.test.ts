/**
 * THE WORLD'S LAWS (prd-52 wave 1, placement ruled 2026-09-07).
 *
 * The load-bearing one is ruling 2: **one colony renders byte-identically to
 * today.** Composition is additive or it is a regression, and the regression
 * it would be is the worst kind — a solo user's picture quietly changing
 * because a feature they do not have was built. prd-37 ruling 6 asks for the
 * same thing in product language ("solo must never show team scaffolding");
 * this file is that sentence as a test.
 *
 * The placement ruling adds two more of the same shape. **A teammate joining
 * never moves you**: the first colony's origin and geometry are the same
 * whether it is alone or one of nine. And **every colony looks the way its
 * owner sees it**: nobody is shrunk to make room, so a colony's mass radius
 * and rim are its solo values. Thread width is a locked channel meaning work
 * size, and a colony drawn smaller to signal distance would be lying about
 * the fleet it belongs to.
 *
 * "Byte-identical" is meant literally and is asserted structurally, against
 * the shipped 20-lane fixture rather than a hand-built one, because the
 * fixture is what a first-run user actually sees.
 */
import { reduceAll } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import {
  buildFleet,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  type Fleet,
  type FixtureSpec,
} from '../fleet/index.js'
import { contentBounds } from './camera.js'
import { layoutScene } from './geometry.js'
import {
  RING_SPACING,
  layoutWorld,
  ringOrigin,
  type ColonyGeometry,
  type ColonySource,
  type WorldGeometry,
} from './geometry/world.js'

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const SIZE = { width: 900, height: 260 }

function fleetFor(spec: FixtureSpec): Fleet {
  const state = reduceAll(fixtureHistory(spec, NOW))
  return buildFleet(state, { now: NOW, manifest: manifestFor(spec) })
}

function sourcesOf(...fleets: Fleet[]): ColonySource[] {
  return fleets.map((fleet, i) => ({ id: `colony-${i}`, fleet }))
}

/** Indexing with the checked-access rule on, without weakening it with a cast. */
function colonyAt(world: WorldGeometry, i: number): ColonyGeometry {
  const colony = world.colonies[i]
  if (colony === undefined) throw new Error(`the world laid out no colony at ${i}`)
  return colony
}

/** N fleets, alternating the two shipped fixtures so no two neighbours are the same shape. */
function team(n: number): Fleet[] {
  return Array.from({ length: n }, (_unused, i) => fleetFor(i % 2 === 0 ? fleet20Spec() : pathologySpec()))
}

describe('one colony is unchanged (prd-52 ruling 2)', () => {
  it('lays out byte-identically to the single-colony path, on the shipped fixture', () => {
    const fleet = fleetFor(fleet20Spec())
    const direct = layoutScene(fleet, { ...SIZE, now: NOW })
    const world = layoutWorld(sourcesOf(fleet), { ...SIZE, now: NOW })

    expect(world.colonies).toHaveLength(1)
    // The whole claim, in one assertion: every geometric fact the single
    // path produces, the world path produces too, to the last float.
    expect(colonyAt(world, 0).geometry).toStrictEqual(direct)
  })

  it('places the only colony at the world origin exactly, not near it', () => {
    const fleet = fleetFor(fleet20Spec())
    const world = layoutWorld(sourcesOf(fleet), { ...SIZE, now: NOW })
    // Object.is, not toBeCloseTo — a colony that is 0.0001px off the origin
    // has had a translation applied to it, which is the thing ruling 2 forbids.
    expect(colonyAt(world, 0).origin).toStrictEqual({ x: 0, y: 0 })
  })

  it('holds for a fixture with pathologies too, not just the healthy one', () => {
    const fleet = fleetFor(pathologySpec())
    const direct = layoutScene(fleet, { ...SIZE, now: NOW })
    const world = layoutWorld(sourcesOf(fleet), { ...SIZE, now: NOW })
    expect(colonyAt(world, 0).geometry).toStrictEqual(direct)
  })

  it('keeps the viewport box as its own size', () => {
    const fleet = fleetFor(fleet20Spec())
    const world = layoutWorld(sourcesOf(fleet), { ...SIZE, now: NOW })
    expect(world.width).toBe(SIZE.width)
    expect(world.height).toBe(SIZE.height)
  })
})

describe('you stay at the origin (placement ruling, 2026-09-07)', () => {
  it('does not move the first colony when others join — not by a float', () => {
    // The property a grid cannot promise: every arrival re-flows every cell.
    // Here the first source is laid out with the untouched options whether it
    // is alone or one of nine, so its geometry is the SAME object graph.
    const [you, ...others] = team(9)
    if (you === undefined) throw new Error('no fleet')
    const alone = layoutWorld(sourcesOf(you), { ...SIZE, now: NOW })
    const crowded = layoutWorld(sourcesOf(you, ...others), { ...SIZE, now: NOW })

    expect(crowded.colonies).toHaveLength(9)
    expect(colonyAt(crowded, 0).origin).toStrictEqual({ x: 0, y: 0 })
    expect(colonyAt(crowded, 0).geometry).toStrictEqual(colonyAt(alone, 0).geometry)
  })

  it('places every other colony off the origin, in the caller’s order', () => {
    const world = layoutWorld(sourcesOf(...team(4)), { ...SIZE, now: NOW })
    expect(world.colonies.map((c) => c.id)).toEqual(['colony-0', 'colony-1', 'colony-2', 'colony-3'])
    for (let i = 1; i < world.colonies.length; i++) {
      const { x, y } = colonyAt(world, i).origin
      expect(Math.hypot(x, y)).toBeGreaterThan(0)
    }
  })

  it('puts a two-person world’s other colony due east', () => {
    // So "you, and them beside you" reads left-to-right rather than landing
    // them above or below you at an angle nobody chose.
    const world = layoutWorld(sourcesOf(...team(2)), { ...SIZE, now: NOW })
    const other = colonyAt(world, 1).origin
    expect(other.y).toBeCloseTo(0, 9)
    expect(other.x).toBeCloseTo(SIZE.width * RING_SPACING, 9)
  })
})

describe('every colony looks the way its owner sees it', () => {
  it('lays every colony out at the full box, never a shrunken cell', () => {
    // The mass radius and the rim's half-axes are derived from the box a
    // colony is handed. Shrink the box and a teammate's work renders at a
    // different scale from the one they are looking at.
    const fleets = team(5)
    const world = layoutWorld(sourcesOf(...fleets), { ...SIZE, now: NOW })
    for (const [i, colony] of world.colonies.entries()) {
      const solo = layoutScene(fleets[i] as Fleet, { ...SIZE, now: NOW })
      expect(colony.geometry.width).toBe(SIZE.width)
      expect(colony.geometry.height).toBe(SIZE.height)
      expect(colony.geometry.rootRadius).toBe(solo.rootRadius)
      expect(colony.geometry.rx).toBe(solo.rx)
      expect(colony.geometry.ry).toBe(solo.ry)
      expect(colony.geometry.threads).toHaveLength(solo.threads.length)
    }
  })

  it('keeps every colony’s content clear of every other’s, up to nine on the ring', () => {
    // Full-size colonies overlap unless they are a box apart in some axis, and
    // RING_SPACING is chosen so they are. Asserted over CONTENT bounds rather
    // than boxes — trespasses and labels reach past the rim, and those are the
    // parts that would collide first.
    for (const n of [2, 3, 5, 7, 9]) {
      const world = layoutWorld(sourcesOf(...team(n)), { ...SIZE, now: NOW })
      const boxes = world.colonies.map((c) => contentBounds(c.geometry))
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const p = boxes[a]
          const q = boxes[b]
          if (p === undefined || q === undefined) throw new Error('no bounds')
          const apart = p.maxX < q.minX || q.maxX < p.minX || p.maxY < q.minY || q.maxY < p.minY
          expect(apart, `colonies ${a} and ${b} overlap in a world of ${n}`).toBe(true)
        }
      }
    }
  })

  it('counts every thread in the world, not every thread in one colony', () => {
    const world = layoutWorld(sourcesOf(...team(2)), { ...SIZE, now: NOW })
    const summed = world.colonies.reduce((n, c) => n + c.geometry.threads.length, 0)
    expect(world.threadCount).toBe(summed)
    // And it is genuinely the sum of two different colonies, so the assertion
    // above cannot pass by both being the same number.
    expect(colonyAt(world, 0).geometry.threads.length).not.toBe(
      colonyAt(world, 1).geometry.threads.length,
    )
  })
})

describe('ringOrigin', () => {
  it('spaces the ring at least a box apart in some axis at every angle', () => {
    // The mutation this catches: RING_SPACING dropping below √2. At 45° the
    // offset is (k·w·0.707, k·h·0.707), and both are under a box when k < √2.
    for (const count of [1, 2, 3, 4, 6, 8, 12]) {
      for (let i = 0; i < count; i++) {
        const { x, y } = ringOrigin(i, count, SIZE.width, SIZE.height)
        const clearX = Math.abs(x) >= SIZE.width - 1e-9
        const clearY = Math.abs(y) >= SIZE.height - 1e-9
        expect(clearX || clearY, `slot ${i} of ${count} is inside the box in both axes`).toBe(true)
      }
    }
  })

  it('is elliptical in the box’s own aspect, so a wide panel gives a wide ring', () => {
    const east = ringOrigin(0, 4, SIZE.width, SIZE.height)
    const north = ringOrigin(1, 4, SIZE.width, SIZE.height)
    expect(Math.abs(east.x) / Math.abs(north.y)).toBeCloseTo(SIZE.width / SIZE.height, 9)
  })
})
