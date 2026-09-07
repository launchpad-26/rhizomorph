/**
 * THE WORLD'S LAWS (prd-52 wave 1).
 *
 * The load-bearing one is ruling 2: **one colony renders byte-identically to
 * today.** Composition is additive or it is a regression, and the regression
 * it would be is the worst kind — a solo user's picture quietly changing
 * because a feature they do not have was built. prd-37 ruling 6 asks for the
 * same thing in product language ("solo must never show team scaffolding");
 * this file is that sentence as a test.
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
import { layoutScene } from './geometry.js'
import {
  colonyColumns,
  layoutWorld,
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

  it('keeps the world box, not the colony box, as its own size', () => {
    const fleet = fleetFor(fleet20Spec())
    const world = layoutWorld(sourcesOf(fleet), { ...SIZE, now: NOW })
    expect(world.width).toBe(SIZE.width)
    expect(world.height).toBe(SIZE.height)
  })
})

describe('a world of several colonies', () => {
  it('lays out every colony it was given, in the order it was given them', () => {
    const fleets = [fleetFor(fleet20Spec()), fleetFor(pathologySpec()), fleetFor(fleet20Spec())]
    const world = layoutWorld(sourcesOf(...fleets), { ...SIZE, now: NOW })
    expect(world.colonies.map((c) => c.id)).toEqual(['colony-0', 'colony-1', 'colony-2'])
  })

  it('gives every colony a box inside the world, and no two the same origin', () => {
    const fleets = [fleetFor(fleet20Spec()), fleetFor(pathologySpec()), fleetFor(fleet20Spec())]
    const world = layoutWorld(sourcesOf(...fleets), { ...SIZE, now: NOW })

    const seen = new Set<string>()
    for (const colony of world.colonies) {
      const { x, y } = colony.origin
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x + colony.geometry.width).toBeLessThanOrEqual(world.width + 1e-9)
      expect(y + colony.geometry.height).toBeLessThanOrEqual(world.height + 1e-9)
      seen.add(`${x}|${y}`)
    }
    expect(seen.size).toBe(world.colonies.length)
  })

  it('counts every thread in the world, not every thread in one colony', () => {
    const fleets = [fleetFor(fleet20Spec()), fleetFor(pathologySpec())]
    const world = layoutWorld(sourcesOf(...fleets), { ...SIZE, now: NOW })
    const summed = world.colonies.reduce((n, c) => n + c.geometry.threads.length, 0)

    expect(world.threadCount).toBe(summed)
    // And it is genuinely the sum of two different colonies, so the assertion
    // above cannot pass by both being the same number.
    expect(colonyAt(world, 0).geometry.threads.length).not.toBe(
      colonyAt(world, 1).geometry.threads.length,
    )
  })

  it('gives each colony a smaller box than the world once there is more than one', () => {
    const fleets = [fleetFor(fleet20Spec()), fleetFor(pathologySpec())]
    const world = layoutWorld(sourcesOf(...fleets), { ...SIZE, now: NOW })
    for (const colony of world.colonies) {
      expect(colony.geometry.width * colony.geometry.height).toBeLessThan(
        world.width * world.height,
      )
    }
  })
})

describe('colonyColumns', () => {
  it('is one column for one colony, whatever the box', () => {
    expect(colonyColumns(1, 900, 260)).toBe(1)
    expect(colonyColumns(1, 260, 900)).toBe(1)
  })

  it('lays three colonies in a row on a wide box and a column on a tall one', () => {
    // 900x260 is the shipped panel's shape: a row of three is far closer to
    // square per cell (300x260) than a stack of three (900x87) would be.
    expect(colonyColumns(3, 900, 260)).toBe(3)
    expect(colonyColumns(3, 260, 900)).toBe(1)
  })

  it('chooses the least distorted cell available, measured symmetrically', () => {
    // Distortion is the long side over the short one, so 2:1 and 1:2 are the
    // same number — which is the point. `|aspect - 1|` is not: it is capped at
    // 1 below and unbounded above, so it scores a tall cell cheaper than an
    // equally-distorted wide one and picks a genuinely worse cell to get it.
    //
    // Six colonies in 480x500 is the case that separates them. A symmetric
    // score picks 2 columns (a 1.44:1 cell); a linear one picks 3 (a 1.56:1
    // cell) — measurably worse, chosen because the score is lopsided rather
    // than because the cell is. Without this case the suite passes either way.
    const cases: ReadonlyArray<readonly [number, number, number]> = [
      [6, 480, 500],
      [3, 900, 260],
      [2, 400, 400],
      [5, 900, 260],
      [12, 1400, 900],
    ]
    for (const [n, w, h] of cases) {
      const distortion = (c: number): number => {
        const aspect = w / c / (h / Math.ceil(n / c))
        return Math.max(aspect, 1 / aspect)
      }
      const available = Array.from({ length: n }, (_, i) => distortion(i + 1))
      expect(distortion(colonyColumns(n, w, h))).toBeCloseTo(Math.min(...available), 9)
    }
  })

  it('never asks for more columns than there are colonies', () => {
    for (const n of [1, 2, 3, 4, 7, 12]) {
      expect(colonyColumns(n, 900, 260)).toBeLessThanOrEqual(n)
      expect(colonyColumns(n, 900, 260)).toBeGreaterThanOrEqual(1)
    }
  })
})
