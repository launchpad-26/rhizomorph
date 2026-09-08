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
 * The placement ruling adds three more of the same shape. **A colony joining
 * moves nobody**: append a source and every existing colony's origin and
 * geometry are the same object graph. **The layout has no viewer**: the same
 * sources give the same world whoever is looking, because a shared world has
 * one map. And **every colony looks the way its owner sees it**: nobody is
 * shrunk to make room, so a colony's mass radius and rim are its solo values.
 * Thread width is a locked channel meaning work size, and a colony drawn
 * smaller to signal distance would be lying about the fleet it belongs to.
 *
 * "Byte-identical" is meant literally and is asserted structurally, against
 * the shipped 20-lane fixture rather than a hand-built one, because the
 * fixture is what a first-run user actually sees.
 */
import { reduceAll } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import {
  buildFleet,
  finishedSpec,
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
  RING_SLOTS,
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

describe('one world, one arrangement, whoever is looking (placement ruling, 2026-09-07)', () => {
  it('moves NOBODY when a colony joins — every existing origin and geometry is the same object graph', () => {
    // The property a grid cannot promise: every arrival re-flows every cell.
    // Here sources are laid out in the caller's stable order, so appending a
    // ninth leaves the first eight exactly where they were, to the identity.
    // Generalised from "the viewer" to everyone on purpose: the viewer is not
    // slot 0, they are wherever they landed, and they must not move either.
    const fleets = team(9)
    const eight = layoutWorld(sourcesOf(...fleets.slice(0, 8)), { ...SIZE, now: NOW })
    const nine = layoutWorld(sourcesOf(...fleets), { ...SIZE, now: NOW })

    expect(nine.colonies).toHaveLength(9)
    for (let i = 0; i < 8; i++) {
      expect(colonyAt(nine, i).origin).toStrictEqual(colonyAt(eight, i).origin)
      expect(colonyAt(nine, i).geometry).toStrictEqual(colonyAt(eight, i).geometry)
    }
  })

  it('does not depend on who is looking — the layout has no viewer', () => {
    // The same sources in the same order produce the same world no matter
    // which colony the viewer happens to own. Two teammates opening one
    // repository must see one map. This is a structural claim about the
    // function's signature as much as its output, stated so a "viewer" or
    // "focus" parameter can never be added to layout without turning it red.
    const fleets = team(4)
    const a = layoutWorld(sourcesOf(...fleets), { ...SIZE, now: NOW })
    const b = layoutWorld(sourcesOf(...fleets), { ...SIZE, now: NOW })
    expect(layoutWorld.length).toBe(2)
    expect(b.colonies.map((c) => c.origin)).toStrictEqual(a.colonies.map((c) => c.origin))
  })

  it('places every colony after the first off the origin, in the caller’s order', () => {
    const world = layoutWorld(sourcesOf(...team(4)), { ...SIZE, now: NOW })
    expect(world.colonies.map((c) => c.id)).toEqual(['colony-0', 'colony-1', 'colony-2', 'colony-3'])
    for (let i = 1; i < world.colonies.length; i++) {
      const { x, y } = colonyAt(world, i).origin
      expect(Math.hypot(x, y)).toBeGreaterThan(0)
    }
  })

  it('puts a two-colony world’s second colony due east', () => {
    // So two colonies read left to right rather than landing one above the
    // other at an angle nobody chose.
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

  /**
   * EXPLICIT TIMEOUT, and why it is not the banned kind. This test is the most
   * expensive in the file by an order of magnitude — 906 ms against a 254 ms
   * runner-up — because it lays out six worlds, the largest of them 17
   * full-size colonies. Vitest's default bound is 5 s, and under a full suite
   * run with an uncapped worker pool it measured **6044 ms** and timed out,
   * failing the landing of an unrelated PR (the merge at `41775df8`). Idle it
   * is 926 ms: a 6.5× starvation factor, not a slowdown in the code under
   * test.
   *
   * AGENTS.md forbids fixing a flake by widening a timeout, and that rule is
   * about masking a RACE. There is no race here to mask: every assertion below
   * is pure geometry over `layoutWorld`'s output, with a fixed `now`, no wall
   * clock, no randomness and no concurrency — so the only thing the default
   * bound measures is how much CPU the test happened to get. Widening it
   * removes a false negative rather than hiding a true one. `app/
   * streamState.test.ts`'s 120k-event soak carries `}, 60_000)` for exactly
   * this reason and states its determinism the same way.
   *
   * It is deliberately NOT a `@gate-timing` file: that set exists for tests
   * that ASSERT wall-clock, so `gate.sh` runs them serially and their
   * assertions mean something. This one asserts no duration at all — enrolling
   * it would buy nothing and add to the serial pass every landing waits on.
   */
  it('keeps every colony’s content clear of every other’s, across two full rings', () => {
    // Full-size colonies overlap unless they are a box apart in some axis, and
    // RING_SPACING is chosen so they are. Asserted over CONTENT bounds rather
    // than boxes — trespasses and labels reach past the rim, and those are the
    // parts that would collide first. 17 = centre + ring 0 full + ring 1 full.
    for (const n of [2, 3, 5, 9, 12, 17]) {
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
  }, 30_000)

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

describe('a departed colony stays as landed mass (prd-52 ruling 7)', () => {
  it('moves nobody when a colony goes quiet — its slot keeps its fleet swapped, not dropped', () => {
    // Departure is a change to a slot's FLEET, never to the world's order.
    // Swap the middle colony for one whose every lane has finished and every
    // other colony is exactly where it was, to the identity.
    const [a, b, c] = team(3)
    if (a === undefined || b === undefined || c === undefined) throw new Error('no fleets')
    const quiet = fleetFor(finishedSpec())

    const before = layoutWorld(sourcesOf(a, b, c), { ...SIZE, now: NOW })
    const after = layoutWorld(
      [{ id: 'colony-0', fleet: a }, { id: 'colony-1', fleet: quiet }, { id: 'colony-2', fleet: c }],
      { ...SIZE, now: NOW },
    )

    expect(colonyAt(after, 0).geometry).toStrictEqual(colonyAt(before, 0).geometry)
    expect(colonyAt(after, 2).geometry).toStrictEqual(colonyAt(before, 2).geometry)
    expect(colonyAt(after, 1).origin).toStrictEqual(colonyAt(before, 1).origin)
  })

  it('still lays the quiet colony out — landed mass, in its slot, at full size', () => {
    const quiet = fleetFor(finishedSpec())
    const world = layoutWorld(sourcesOf(fleetFor(fleet20Spec()), quiet), { ...SIZE, now: NOW })
    const colony = colonyAt(world, 1)
    expect(colony.geometry.rootRadius).toBeGreaterThan(0)
    expect(colony.geometry.width).toBe(SIZE.width)
    expect(colony.geometry.threads.length).toBe(quiet.lanes.length)
  })

  it('is REMOVAL that moves people — which is why removal is what the ruling forbids', () => {
    // The contrapositive, so the ruling's reason is on the record as a test
    // and not only as prose: drop the middle colony and the one after it
    // slides into the gap.
    const [a, b, c] = team(3)
    if (a === undefined || b === undefined || c === undefined) throw new Error('no fleets')
    const kept = layoutWorld(sourcesOf(a, b, c), { ...SIZE, now: NOW })
    const dropped = layoutWorld(
      [{ id: 'colony-0', fleet: a }, { id: 'colony-2', fleet: c }],
      { ...SIZE, now: NOW },
    )
    expect(colonyAt(dropped, 1).origin).not.toStrictEqual(colonyAt(kept, 2).origin)
  })
})

describe('ringOrigin', () => {
  it('is a function of the slot alone — a slot does not move when the ring fills', () => {
    // The law that makes "joining moves nobody" true. A ring that divided 2π
    // by the number present would relocate every colony on each arrival; the
    // slot's position must depend on nothing but its own index.
    for (let i = 0; i < 20; i++) {
      const a = ringOrigin(i, SIZE.width, SIZE.height)
      const b = ringOrigin(i, SIZE.width, SIZE.height)
      expect(b).toStrictEqual(a)
    }
    // And the signature cannot quietly grow a `count` back.
    expect(ringOrigin.length).toBe(3)
  })

  it('clears the centre by at least a box in some axis at every slot', () => {
    // The mutation this catches: RING_SPACING dropping below √2. At 45° the
    // offset is (k·w·0.707, k·h·0.707), and both are under a box when k < √2.
    for (let i = 0; i < RING_SLOTS * 2; i++) {
      const { x, y } = ringOrigin(i, SIZE.width, SIZE.height)
      const clearX = Math.abs(x) >= SIZE.width - 1e-9
      const clearY = Math.abs(y) >= SIZE.height - 1e-9
      expect(clearX || clearY, `slot ${i} is inside the box in both axes`).toBe(true)
    }
  })

  it('opens a second ring, further out, once the first eight slots are full', () => {
    const last = ringOrigin(RING_SLOTS - 1, SIZE.width, SIZE.height)
    const ninth = ringOrigin(RING_SLOTS, SIZE.width, SIZE.height)
    // Same angle as slot 0 (due east), a full ring further out.
    expect(ninth.y).toBeCloseTo(0, 9)
    expect(ninth.x).toBeCloseTo(SIZE.width * RING_SPACING * 2, 9)
    expect(Math.hypot(ninth.x, ninth.y)).toBeGreaterThan(Math.hypot(last.x, last.y))
  })

  it('is elliptical in the box’s own aspect, so a wide panel gives a wide ring', () => {
    const east = ringOrigin(0, SIZE.width, SIZE.height)
    const north = ringOrigin(RING_SLOTS / 4, SIZE.width, SIZE.height)
    expect(Math.abs(east.x) / Math.abs(north.y)).toBeCloseTo(SIZE.width / SIZE.height, 9)
  })
})
