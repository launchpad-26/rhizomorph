import { reduceAll, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import {
  buildFleet,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  type Fleet,
  type FixtureSpec,
  type Lane,
} from '../fleet/index.js'
import {
  LABELS_ALL_MAX,
  LIFE_SPAN_MS,
  RADIAL_BORN,
  RECENCY_SPAN_MS,
  ROOT_GROWTH,
  RELAX_REACH_MAX_PX,
  RELAX_REACH_MIN_PX,
  SEED_CEILING,
  SEED_FLOOR,
  SEED_FULL_TOKENS,
  bornRadial,
  bundleRadial,
  layoutScene,
  lifecycleFrac,
  rootFullness,
  rootRadiusFor,
  rimSpacing,
  ringAngles,
  seedSize,
  type Point,
  type SceneGeometry,
  type ThreadGeometry,
} from './geometry.js'
import { RETURN, returnAt, homecoming, type RetireState } from './retire.js'
import { WANDER_MAX_SPACING } from './variation.js'

/**
 * WHERE A LANE LIVES, and what is allowed to move it.
 *
 * Graft g7 is the load-bearing claim here: a lane's angular position is stable
 * for the session, so "72 lives at four o'clock" survives every rank change,
 * every burst of work and every reordering above it. These tests are what pin
 * it — the prd asks for it by test, because the failure mode is invisible in a
 * screenshot and obvious only to somebody who looked away and looked back.
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const SIZE = { width: 900, height: 260 }

function fleetFor(spec: FixtureSpec, events?: readonly RhizomorphEvent[]): Fleet {
  const state = reduceAll(events ?? fixtureHistory(spec, NOW))
  return buildFleet(state, { now: NOW, manifest: manifestFor(spec) })
}

function layout(fleet: Fleet, now = NOW): SceneGeometry {
  return layoutScene(fleet, { ...SIZE, now })
}

function anglesOf(geometry: SceneGeometry): Record<string, number> {
  const angles: Record<string, number> = {}
  for (const thread of geometry.threads) angles[thread.laneId] = thread.angle
  return angles
}

/**
 * The same log, delivered in a different interleaving.
 *
 * "Any event order" means any order a stream can actually produce: collectors
 * poll on their own schedules and emit in batches, so two facts recorded in the
 * same instant can arrive either way round, and the replay burst can meet the
 * live tail at any point. It does **not** mean total chaos — a `commit.landed`
 * cannot reach us before the `worktree.discovered` for the worktree it landed
 * in, and a log claiming otherwise is not a log any collector wrote. So this
 * shuffles and then re-sorts by timestamp: every equal-`ts` group is scrambled,
 * the causal order is kept, and each event still knows when it happened.
 */
function reordered(events: readonly RhizomorphEvent[]): RhizomorphEvent[] {
  const out = [...events]
  let seed = 12345
  for (let i = out.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const j = seed % (i + 1)
    ;[out[i], out[j]] = [out[j] as RhizomorphEvent, out[i] as RhizomorphEvent]
  }
  return out.sort((a, b) => a.ts - b.ts)
}

/** A copy of the fleet with one lane's mood changed and nothing else touched. */
function withLane(fleet: Fleet, id: string, changes: Partial<Lane>): Fleet {
  return {
    ...fleet,
    lanes: fleet.lanes.map((lane) => (lane.id === id ? { ...lane, ...changes } : lane)),
  }
}

describe('pointability — graft g7', () => {
  const spec = pathologySpec()
  const history = fixtureHistory(spec, NOW)

  it('gives the same lanes the same angles whatever order the events arrived in', () => {
    const inOrder = anglesOf(layout(fleetFor(spec, history)))
    const jumbled = anglesOf(layout(fleetFor(spec, reordered(history))))

    expect(Object.keys(jumbled).sort()).toEqual(Object.keys(inOrder).sort())
    for (const [laneId, angle] of Object.entries(inOrder)) {
      expect(jumbled[laneId], `${laneId} moved when the events were reordered`).toBeCloseTo(
        angle,
        10,
      )
    }
  })

  it('does not move a lane because its rank, age or size changed', () => {
    const fleet = fleetFor(spec, history)
    const victim = fleet.lanes[3] as Lane
    const before = anglesOf(layout(fleet))

    const after = anglesOf(
      layout(
        withLane(fleet, victim.id, {
          rank: 'broken',
          outputTokens: victim.outputTokens * 40,
          ageMs: RECENCY_SPAN_MS * 2,
          pathologies: [],
        }),
      ),
    )

    expect(after[victim.id]).toBeCloseTo(before[victim.id] as number, 10)
  })

  it('reads the slot, not the attention order the fleet is sorted into', () => {
    const fleet = fleetFor(spec, history)
    const reversed = { ...fleet, lanes: [...fleet.lanes].reverse() }
    expect(anglesOf(layout(reversed))).toEqual(anglesOf(layout(fleet)))
  })

  it('spaces the ring by arc length, so a wide panel does not pile lanes at its ends', () => {
    // On a 3:1 ellipse, equal *angles* would put a quarter of the fleet in each
    // narrow end, where there is no room for a label. Equal arc does not.
    const angles = ringAngles(12, 300, 100)
    const rightEnd = angles.filter((angle) => Math.abs(Math.cos(angle)) > 0.94)
    expect(rightEnd.length).toBeLessThanOrEqual(2)
    expect(new Set(angles.map((a) => a.toFixed(6))).size).toBe(12)
  })
})

describe('what the geometry encodes', () => {
  const fleet = fleetFor(pathologySpec())
  const geometry = layout(fleet)

  it('puts a lane that has done more work further through its journey', () => {
    // prd6 ruling 4: distance is the lifecycle, not recency. The busiest lane in
    // the fixture is the furthest along; the one that has produced least is the
    // least far along, whatever either of them last said.
    const busy = geometry.byLane.get('44-scene-pulses') as ThreadGeometry
    const small = geometry.byLane.get('42-otel-receiver') as ThreadGeometry

    expect(busy.lifeFrac).toBeGreaterThan(small.lifeFrac)
    expect(reach(geometry, busy)).toBeGreaterThan(reach(geometry, small))
  })

  it('makes the busiest lane the widest thread', () => {
    const widest = [...geometry.threads].sort((a, b) => b.widthRoot - a.widthRoot)[0]
    const busiest = [...fleet.lanes].sort((a, b) => b.outputTokens - a.outputTokens)[0]
    expect(widest?.laneId).toBe(busiest?.id)
  })

  it('glides the drift forward from the snapshot rather than jumping with it', () => {
    const still = layout(fleet, NOW)
    const later = layout(fleet, NOW + 60_000)
    const lane = '46-spend-selectors'

    const ageStill = still.byLane.get(lane)?.ageFrac as number
    const ageLater = later.byLane.get(lane)?.ageFrac as number
    expect(ageLater).toBeGreaterThan(ageStill)
    expect(ageLater - ageStill).toBeCloseTo(60_000 / RECENCY_SPAN_MS, 6)
  })

  it('sprouts second growth only for the threads that are not the trunk', () => {
    const withSubagents = geometry.byLane.get('44-scene-pulses')
    expect(withSubagents?.filaments.length).toBeGreaterThan(0)
    expect(withSubagents?.filaments.every((f) => f.thread !== 'main')).toBe(true)
  })

  it('aims a trespass at the lane whose fence it crossed', () => {
    const offender = geometry.byLane.get('45-ledger-subrows')
    expect(offender?.rogue).not.toBeNull()
    expect(offender?.rogue?.victimId).toBe('46-spend-selectors')
  })

  it('draws no rogue filament for a lane with no trespass', () => {
    expect(geometry.byLane.get('47-format-module')?.rogue).toBeNull()
  })
})

/**
 * ABSOLUTE SEED GROWTH (prd6 ruling 1).
 *
 * The law with teeth is the first one: a lane's size is a fact about that lane.
 * The old reading divided by the fleet's own busiest lane, so every seed in the
 * picture shrank when one whale worked harder — which is why growth, the thing
 * the operator actually asked to see, never read.
 */
describe('seeds grow with the work, absolutely — prd6 ruling 1', () => {
  const fleet = fleetFor(pathologySpec())

  it('does not change a lane size when a sibling grows', () => {
    const whale = '44-scene-pulses'
    const bystander = '47-format-module'
    const before = layout(fleet).byLane.get(bystander) as ThreadGeometry

    for (const multiple of [2, 10, 100]) {
      const grown = layout(
        withLane(fleet, whale, {
          outputTokens: (fleet.lanes.find((l) => l.id === whale) as Lane).outputTokens * multiple,
        }),
      ).byLane.get(bystander) as ThreadGeometry

      expect(grown.sizeFrac, `sizeFrac moved at ${multiple}×`).toBe(before.sizeFrac)
      expect(grown.widthRoot).toBe(before.widthRoot)
      expect(grown.widthTip).toBe(before.widthTip)
    }
  })

  it('grows a lane own seed as its own output grows', () => {
    const lane = '47-format-module'
    const at = (tokens: number): number =>
      (layout(withLane(fleet, lane, { outputTokens: tokens })).byLane.get(lane) as ThreadGeometry)
        .sizeFrac

    let previous = -1
    for (const tokens of [0, 2_000, 8_000, 20_000, 60_000, SEED_FULL_TOKENS]) {
      const size = at(tokens)
      expect(size, `${tokens} tokens did not grow the seed`).toBeGreaterThanOrEqual(previous)
      previous = size
    }
    // …and it is worth *reading*: the whole point of ruling 1 is that the growth
    // is visible, not merely present in the third decimal place.
    expect(at(SEED_FULL_TOKENS) - at(8_000)).toBeGreaterThan(0.3)
  })

  it('holds the ceiling and the floor, at ten times the reference and at nothing', () => {
    expect(seedSize(SEED_FULL_TOKENS)).toBe(SEED_CEILING)
    expect(seedSize(SEED_FULL_TOKENS * 10)).toBe(SEED_CEILING)
    expect(seedSize(SEED_FULL_TOKENS * 1_000)).toBe(SEED_CEILING)
    // A lane that has produced nothing is still a lane (ruling 22).
    expect(seedSize(0)).toBe(SEED_FLOOR)
    expect(seedSize(-1)).toBe(SEED_FLOOR)
    expect(SEED_FLOOR).toBeGreaterThan(0)
  })

  it('draws a whale and a ten-times whale exactly the same', () => {
    const lane = '47-format-module'
    const at = (tokens: number): ThreadGeometry =>
      layout(withLane(fleet, lane, { outputTokens: tokens })).byLane.get(lane) as ThreadGeometry

    expect(at(SEED_FULL_TOKENS * 10).widthRoot).toBe(at(SEED_FULL_TOKENS).widthRoot)
  })
})

/**
 * DISTANCE IS THE LIFECYCLE JOURNEY (prd6 ruling 4).
 *
 * Born at the centre, travelling outward as it works, retiring at the rim. The
 * claims worth pinning are that the journey only ever goes one way, that a landing
 * ends it, and that ANGLE — graft g7 — was not touched to do any of it.
 */
describe('the lifecycle journey — prd6 ruling 4', () => {
  const fleet = fleetFor(pathologySpec())
  const LANE = '47-format-module'

  it('is monotone in every signal it reads', () => {
    for (const homecoming of [0, 0.5, 1]) {
      let previous = -1
      for (const worked of [0, 0.25, 0.5, 1]) {
        const value = lifecycleFrac(worked, 0, homecoming)
        expect(value).toBeGreaterThanOrEqual(previous)
        previous = value
      }
    }

    let previous = -1
    for (const age of [0, LIFE_SPAN_MS / 4, LIFE_SPAN_MS / 2, LIFE_SPAN_MS, LIFE_SPAN_MS * 4]) {
      const value = lifecycleFrac(0.3, age, 0)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })

  it('starts a newborn lane against the mass and never inside it', () => {
    const newborn = lifecycleFrac(SEED_FLOOR, 0, 0)
    expect(newborn).toBeLessThan(0.1)

    const geometry = layout(withLane(fleet, LANE, { outputTokens: 0, firstSeenAt: NOW }))
    const thread = geometry.byLane.get(LANE) as ThreadGeometry
    // Clear of the root-mass it grew out of, and short of the ring the worked
    // lanes have reached.
    expect(reach(geometry, thread)).toBeGreaterThan(geometry.rootRadius)
    expect(thread.lifeFrac).toBeLessThan(
      (geometry.byLane.get('44-scene-pulses') as ThreadGeometry).lifeFrac,
    )
    // Clear of the bundle trunk too, so a new thread reads as a thread.
    expect(RADIAL_BORN).toBeGreaterThan(0.32)
  })

  it('keeps a newborn out of the mass on a panel with no room for one', () => {
    // A fraction of the rim is only half the answer: squeeze the panel and the
    // rim closes in on a mass that does not shrink with it.
    const newborns = {
      ...fleet,
      lanes: fleet.lanes.map((lane) => ({ ...lane, outputTokens: 0, firstSeenAt: NOW })),
    }

    for (const size of [{ width: 900, height: 260 }, { width: 320, height: 120 }, { width: 240, height: 90 }]) {
      const geometry = layoutScene(newborns, { ...size, now: NOW })
      for (const thread of geometry.threads) {
        expect(
          reach(geometry, thread),
          `${thread.laneId} was born inside the mass at ${size.width}×${size.height}`,
        ).toBeGreaterThan(geometry.rootRadius)
      }
      // …and there is still a journey left to make.
      expect(bornRadial(geometry.rootRadius, geometry.rx, geometry.ry)).toBeLessThan(1)
    }
  })

  it('carries a lane outward as it works, and never back in', () => {
    let previous = -1
    for (const tokens of [0, 5_000, 20_000, 80_000, 400_000]) {
      const geometry = layout(withLane(fleet, LANE, { outputTokens: tokens }))
      const out = reach(geometry, geometry.byLane.get(LANE) as ThreadGeometry)
      expect(out, `${tokens} tokens pulled the lane back in`).toBeGreaterThanOrEqual(previous)
      previous = out
    }
  })

  it('glides outward with the clock rather than jumping with the snapshot', () => {
    const still = layout(fleet).byLane.get(LANE) as ThreadGeometry
    const later = layout(fleet, NOW + 6 * 60_000).byLane.get(LANE) as ThreadGeometry

    expect(later.lifeFrac).toBeGreaterThan(still.lifeFrac)
    // Ten minutes of a sixty-minute life, at the wall-clock term's share of the
    // blend — small, continuous, and exactly what `now` moved it by.
    expect(later.lifeFrac - still.lifeFrac).toBeCloseTo(0.35 * (6 / 60), 6)
  })

  it('pins a landed lane at the rim, and gets it there on the cut own spring', () => {
    const at = (state: RetireState | null): ThreadGeometry =>
      layoutScene(fleet, {
        ...SIZE,
        now: NOW,
        ...(state === null ? {} : { retire: new Map([[LANE, state]]) }),
      }).byLane.get(LANE) as ThreadGeometry

    const living = at(null)
    expect(at(returnAt(RETURN.tensionMs)).lifeFrac).toBeCloseTo(living.lifeFrac, 9)
    expect(at(returnAt(RETURN.totalMs)).lifeFrac).toBe(1)

    // …and it travels there, one frame at a time, over the withdraw.
    let previous = living.lifeFrac
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const value = at(returnAt(RETURN.tensionMs + RETURN.withdrawMs * t)).lifeFrac
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = value
    }
  })

  it('moves nothing sideways doing it — graft g7 is untouched', () => {
    const before = anglesOf(layout(fleet))
    const worked = anglesOf(
      layout(withLane(fleet, LANE, { outputTokens: 500_000, firstSeenAt: NOW })),
    )
    const landed = anglesOf(
      layoutScene(fleet, { ...SIZE, now: NOW, retire: new Map([[LANE, returnAt(RETURN.totalMs)]]) }),
    )

    for (const [laneId, angle] of Object.entries(before)) {
      expect(worked[laneId], `${laneId} moved when work landed`).toBeCloseTo(angle, 10)
      expect(landed[laneId], `${laneId} moved when a lane retired`).toBeCloseTo(angle, 10)
    }
  })
})

/**
 * SEEDS GERMINATE (prd6 ruling 3).
 *
 * A retired lane keeps its slot, so a handle that comes back grows out of the seed
 * it left instead of appearing as a stranger somewhere else in the ring.
 */
describe('seeds germinate — prd6 ruling 3', () => {
  const fleet = fleetFor(pathologySpec())
  const RETIRED = '47-format-module'
  const finished = new Map([[RETIRED, returnAt(RETURN.totalMs)]])

  /** The same fleet, re-dispatched: a brand-new lane wearing the old handle. */
  function redispatched(): Fleet {
    const seed = fleet.lanes.find((lane) => lane.id === RETIRED) as Lane
    return {
      ...fleet,
      lanes: [
        ...fleet.lanes,
        {
          ...seed,
          id: '47-format-module-again',
          branch: '47-format-module-again',
          worktreePath: '/repo__worktrees/47-format-module-again',
          // The one thread of continuity: workmux relaunched it under its handle.
          handles: [...seed.handles],
          slot: Math.max(...fleet.lanes.map((lane) => lane.slot)) + 1,
          outputTokens: 0,
          firstSeenAt: NOW,
          activity: 'working',
        } as Lane,
      ],
    }
  }

  const before = layoutScene(fleet, { ...SIZE, now: NOW, retire: finished })
  const after = layoutScene(redispatched(), { ...SIZE, now: NOW, retire: finished })

  it('grows the returning handle from its old seed, at its old angle', () => {
    const sprout = after.byLane.get('47-format-module-again') as ThreadGeometry
    expect(sprout.germinatedFrom).toBe(RETIRED)
    expect(sprout.angle).toBe((before.byLane.get(RETIRED) as ThreadGeometry).angle)
  })

  it('re-spaces nobody — the ring keeps the seats it had', () => {
    // The whole reason the seat is shared: a stranger appearing elsewhere would
    // subdivide the ring one finer and move every other lane in the fleet.
    for (const thread of before.threads) {
      expect(
        (after.byLane.get(thread.laneId) as ThreadGeometry).angle,
        `${thread.laneId} moved when a lane came back`,
      ).toBe(thread.angle)
    }
    expect(after.threads).toHaveLength(before.threads.length + 1)
  })

  it('carries the seed retained size over as the starting point', () => {
    const seedSizeFrac = (before.byLane.get(RETIRED) as ThreadGeometry).sizeFrac
    const sprout = after.byLane.get('47-format-module-again') as ThreadGeometry

    // It has produced nothing yet, so on its own it would be a floor-sized seed.
    expect(seedSize(0)).toBe(SEED_FLOOR)
    expect(sprout.sizeFrac).toBe(seedSizeFrac)
    expect(sprout.sizeFrac).toBeGreaterThan(SEED_FLOOR)
    // …and it is still at the start of its own journey, not at the end of the
    // seed's: the size came back, the lifecycle did not.
    expect(sprout.lifeFrac).toBeLessThan((before.byLane.get(RETIRED) as ThreadGeometry).lifeFrac)
  })

  it('leaves the seed where it is — a finished lane is not consumed by sprouting', () => {
    const seed = after.byLane.get(RETIRED) as ThreadGeometry
    expect(seed.retire).not.toBeNull()
    expect(seed.node).toEqual((before.byLane.get(RETIRED) as ThreadGeometry).node)
  })

  it('germinates nothing when no handle came back', () => {
    for (const thread of before.threads) expect(thread.germinatedFrom).toBeNull()
    for (const thread of layout(fleet).threads) expect(thread.germinatedFrom).toBeNull()
  })

  it('sprouts one seed once, however many lanes reach for it', () => {
    const twice = redispatched()
    const sprout = twice.lanes[twice.lanes.length - 1] as Lane
    const geometry = layoutScene(
      {
        ...twice,
        lanes: [...twice.lanes, { ...sprout, id: `${sprout.id}-2`, slot: sprout.slot + 1 }],
      },
      { ...SIZE, now: NOW, retire: finished },
    )

    const claimed = geometry.threads.filter((thread) => thread.germinatedFrom === RETIRED)
    expect(claimed).toHaveLength(1)
    // The second one is a stranger, and strangers get their own ground.
    const other = geometry.byLane.get(`${sprout.id}-2`) as ThreadGeometry
    expect(other.germinatedFrom).toBeNull()
    expect(other.angle).not.toBe(claimed[0]?.angle)
  })
})

describe('render everything, always — ruling 22', () => {
  it('threads all twenty lanes and names every one of them', () => {
    const geometry = layout(fleetFor(fleet20Spec()))
    expect(geometry.threads).toHaveLength(20)
    expect(geometry.labelPolicy).toBe('all')
    expect(geometry.threads.every((thread) => thread.path.length > 2)).toBe(true)
  })

  it('retreats to labels-on-hover past the threshold — and still threads them all', () => {
    // Ruling 31's named cheap retreat. Hiding lanes stayed off the table, so the
    // thread count must not move when the labels do.
    const fleet = fleetFor(fleet20Spec())
    const many = {
      ...fleet,
      lanes: Array.from({ length: LABELS_ALL_MAX + 6 }, (_unused, i) => ({
        ...(fleet.lanes[i % fleet.lanes.length] as Lane),
        id: `lane-${i}`,
        slot: i,
      })),
    }

    const geometry = layout(many)
    expect(geometry.labelPolicy).toBe('hover')
    expect(geometry.threads).toHaveLength(LABELS_ALL_MAX + 6)
  })

  it('lays out an empty fleet without inventing one', () => {
    const fleet = fleetFor(pathologySpec())
    const geometry = layout({ ...fleet, lanes: [] })
    expect(geometry.threads).toHaveLength(0)
    expect(geometry.rootRadius).toBeGreaterThan(0)
  })
})

/**
 * THE MASS GROWS WITH THE WORK, AND THE SCENE MAKES ROOM (prd6 ruling 2, #118).
 *
 * The size of the centre is a geometry fact rather than a drawing one, and this
 * is why: everything that has to stay clear of the mass — the newborn radius, the
 * shared trunk, the point each thread leaves the surface at — is placed here,
 * before any mark builder runs. A mass that grew after the layout had committed
 * would simply be drawn over the youngest lane in the fleet.
 *
 * The cap has to be a fraction of the *scene*, not of the mass. That is the whole
 * of #118's finding: a ceiling of "+30% of its own resting size" is a statement
 * about the blob and says nothing about the picture, so a night of thirty-eight
 * landings still read as a wreath around an empty middle.
 */
describe('the mass grows with the landed work — prd6 ruling 2, #118', () => {
  const fleet = fleetFor(fleet20Spec())
  const settled = returnAt(RETURN.totalMs)

  /** The first `count` lanes, landed. */
  function landed(count: number): Map<string, RetireState> {
    return new Map(fleet.lanes.slice(0, count).map((lane) => [lane.id, settled]))
  }

  function grown(
    retire: ReadonlyMap<string, RetireState>,
    size = SIZE,
    of: Fleet = fleet,
  ): SceneGeometry {
    return layoutScene(of, { ...size, now: NOW, retire })
  }

  it('reads landed work exactly as the cord-cut reads it', () => {
    // `layoutScene` weighs each landing by `clamp01(cut.withdraw)` rather than by
    // `retire.ts`'s `homecoming`, because taking that one value would close an
    // import cycle (`motion` → `geometry` → `retire` → `motion`). The copy is
    // deliberate and this is what stops it drifting: same question, same answer,
    // over every stage of a cut.
    for (const at of [0, RETURN.tensionMs, RETURN.tensionMs + RETURN.withdrawMs / 2, RETURN.totalMs]) {
      const state = returnAt(at)
      const only = new Map([[(fleet.lanes[0] as Lane).id, state]])
      const tokens = (fleet.lanes[0] as Lane).outputTokens
      expect(grown(only).rootFullness).toBe(rootFullness(tokens * homecoming(state)))
    }
  })

  it('is monotone in the work, absolute, and capped against the rim', () => {
    let previous = layout(fleet).rootRadius
    const resting = previous
    for (const count of [1, 3, 8, 20]) {
      const now = grown(landed(count)).rootRadius
      expect(now, `${count} landings did not grow the mass`).toBeGreaterThan(previous)
      previous = now
    }
    expect(previous).toBeGreaterThan(resting * 1.5)

    // Absolute: a sibling's work is not in this reading. One lane landing 200K
    // draws the same mass whether the lanes beside it hold nothing or millions.
    const only = new Map([[(fleet.lanes[0] as Lane).id, settled]])
    const zeroed = {
      ...fleet,
      lanes: fleet.lanes.map((lane, i) => (i === 0 ? lane : { ...lane, outputTokens: 0 })),
    }
    const whales = {
      ...fleet,
      lanes: fleet.lanes.map((lane, i) =>
        i === 0 ? lane : { ...lane, outputTokens: 10_000_000 },
      ),
    }
    expect(grown(only, SIZE, whales).rootRadius).toBe(grown(only, SIZE, zeroed).rootRadius)

    // Capped, and the cap is the scene's own geometry — on any panel shape.
    const everything = {
      ...fleet,
      lanes: fleet.lanes.map((lane) => ({ ...lane, outputTokens: 10_000_000 })),
    }
    for (const size of [SIZE, { width: 760, height: 640 }, { width: 1404, height: 497 }]) {
      const geometry = grown(landed(20), size, everything)
      expect(geometry.rootFullness).toBe(1)
      expect(geometry.rootRadius).toBeCloseTo(
        ROOT_GROWTH.maxReach * Math.min(geometry.rx, geometry.ry),
        9,
      )
    }
  })

  it('makes room for itself: newborns, the trunk and the thread roots all clear it', () => {
    // The reason the growth lives in this file. Every one of these is placed
    // against the mass's radius, and every one of them would be swallowed by a
    // full centre if it were placed against a resting one.
    const everything = {
      ...fleet,
      lanes: fleet.lanes.map((lane) => ({
        ...lane,
        outputTokens: 10_000_000,
        firstSeenAt: NOW,
      })),
    }

    for (const size of [SIZE, { width: 760, height: 640 }, { width: 320, height: 120 }]) {
      const geometry = grown(landed(20), size, everything)
      const { rootRadius, rx, ry } = geometry
      const where = `${size.width}×${size.height}`

      // A newborn node sits outside the mass, and the trunk it leaves through
      // sits outside it too — but inside the node, or the bundle stops bundling.
      const born = bornRadial(rootRadius, rx, ry)
      const trunk = bundleRadial(rootRadius, rx, ry)
      expect(born * Math.min(rx, ry), `${where}: newborn inside the mass`).toBeGreaterThan(
        rootRadius,
      )
      expect(trunk * Math.min(rx, ry), `${where}: trunk inside the mass`).toBeGreaterThan(
        rootRadius,
      )
      expect(trunk, `${where}: trunk past the newborns`).toBeLessThanOrEqual(born)
      // …and there is still a journey left to make.
      expect(born, `${where}: nothing left of the lifecycle`).toBeLessThan(1)

      // Every thread leaves the mass *at* its surface, wherever that now is.
      for (const thread of geometry.threads) {
        const root = thread.path[0] as Point
        const out = Math.hypot(root.x - geometry.centre.x, root.y - geometry.centre.y)
        expect(out / rootRadius, `${where}: ${thread.laneId} left from nowhere`).toBeCloseTo(
          0.94,
          6,
        )
      }
    }
  })

  it('is a floor on a panel with no room to grow, never a shrink', () => {
    // "Unknown, not zero" applies to a scene with nowhere to put the answer just
    // as it does to a fleet with no answer: a mass whose scene-derived ceiling
    // lands below its own resting size draws the resting size.
    expect(rootRadiusFor(80, 60, 60, 1)).toBe(80)
    expect(rootRadiusFor(80, 60, 60, 0.5)).toBe(80)
    expect(rootFullness(0)).toBe(0)
    // A quiet session looks quiet: nothing landed, nothing grown.
    expect(layout(fleet).rootFullness).toBe(0)
    expect(layout({ ...fleet, lanes: [] }).rootRadius).toBe(layout(fleet).rootRadius)
  })
})

describe('the settle, as geometry — graft g3', () => {
  const fleet = fleetFor(pathologySpec())

  it('grows a discovered thread out of the mass rather than teleporting it', () => {
    const lane = '43-drawer-attach'
    const grown = layout(fleet).byLane.get(lane)
    const growing = layoutScene(fleet, {
      ...SIZE,
      now: NOW,
      growth: new Map([[lane, 0.3]]),
    }).byLane.get(lane)

    expect(growing?.growth).toBe(0.3)
    const reach = (t?: { node: { x: number; y: number } }): number =>
      t === undefined ? 0 : Math.hypot(t.node.x - 450, t.node.y - 130)
    expect(reach(growing)).toBeLessThan(reach(grown))
    // Still a thread, not a point: it is growing, not absent (ruling 22).
    expect(growing?.path.length).toBe(grown?.path.length)
  })

  it('treats a lane the registry has forgotten as fully grown', () => {
    expect(layout(fleet).byLane.get('43-drawer-attach')?.growth).toBe(1)
  })
})

/**
 * THE CORD-RETURN, as shape (prd5 ruling 3).
 *
 * The clock is `retire.test.ts`'s; this is what those numbers do to the picture.
 * The three claims worth pinning are the three the ruling is actually about: the
 * thread loosens at the *root* end, the freed end travels along the thread's own
 * path, and what is left is a short mark near the rim that still measures the work.
 */
describe('the cut, as geometry — prd5 ruling 3', () => {
  const fleet = fleetFor(pathologySpec())
  const LANE = '47-format-module'

  function cutting(state: RetireState, hideFinished = false): ThreadGeometry {
    return layoutScene(fleet, {
      ...SIZE,
      now: NOW,
      retire: new Map([[LANE, state]]),
      hideFinished,
    }).byLane.get(LANE) as ThreadGeometry
  }

  const whole = layout(fleet).byLane.get(LANE) as ThreadGeometry

  it('leaves every other lane on its own bearing, and only eases it outward', () => {
    // One lane retiring is not a reflow. The ring is subdivided by how many lanes
    // there *are*, and a lane leaving the network does not leave the fleet — so
    // nobody's *seat* moves, and graft g7 survives a landing.
    //
    // What does move, by a fraction of a pixel, is how far out everyone sits:
    // #118 grows the mass with the landed work, and {@link bornRadial} keeps the
    // youngest node clear of it, so a body that swelled pushes the living band
    // out with it. That is not a reflow and it is not recency creeping back onto
    // the radius — the *reading* is untouched, because `lifeFrac` is still a fact
    // about the lane alone and all that changed is where "just born" is on this
    // panel, exactly as it changes when the panel is resized. It has to be
    // outward-only and it has to be small, and this is where both are pinned.
    const before = layout(fleet)
    const during = layoutScene(fleet, {
      ...SIZE,
      now: NOW,
      retire: new Map([[LANE, returnAt(RETURN.tensionMs + 200)]]),
    })
    const out = (p: Point): number => Math.hypot(p.x - SIZE.width / 2, p.y - SIZE.height / 2)
    const bearing = (p: Point): number =>
      Math.atan2(p.y - SIZE.height / 2, p.x - SIZE.width / 2)

    for (const thread of during.threads) {
      if (thread.laneId === LANE) continue
      const was = before.byLane.get(thread.laneId) as ThreadGeometry
      expect(thread.angle, `${thread.laneId} moved`).toBe(was.angle)
      expect(thread.lifeFrac, `${thread.laneId} aged`).toBe(was.lifeFrac)
      expect(bearing(thread.node), `${thread.laneId} swung`).toBeCloseTo(bearing(was.node), 9)
      const eased = out(thread.node) - out(was.node)
      expect(eased, `${thread.laneId} moved inward`).toBeGreaterThanOrEqual(0)
      expect(eased, `${thread.laneId} lurched`).toBeLessThan(1)
    }
  })

  it('draws no cut at all for a lane the registry says nothing about', () => {
    expect(whole.retire).toBeNull()
  })

  describe('stage 1 — the tension goes out of it', () => {
    const slack = cutting(returnAt(RETURN.tensionMs))

    it('loosens the curve at the root end and leaves the node where it was', () => {
      const drift = (at: number): number => {
        const before = pointOn(whole, at)
        const after = pointOn(slack, at)
        return Math.hypot(after.x - before.x, after.y - before.y)
      }

      // The loosening is unmistakably a root-end fact: that is where the strain
      // was, and a sag that peaked in the middle would read as something pulling
      // on the thread rather than as the thread letting go.
      expect(drift(0.3)).toBeGreaterThan(3)
      expect(drift(0.3)).toBeGreaterThan(drift(0.75))
      // Nothing has moved at the tip yet — stage 1 is curvature only.
      expect(drift(1)).toBeCloseTo(0, 6)
      expect(slack.node).toEqual(whole.node)
    })

    it('relaxes the taper without losing the work-size', () => {
      const taut = whole.widthRoot - whole.widthTip
      const released = (slack.retire?.widthRoot as number) - (slack.retire?.widthTip as number)
      expect(released).toBeLessThan(taut)
      expect(released).toBeGreaterThan(0)
    })

    it('is still threaded into the mass — as it will be for the rest of the session', () => {
      // The strand is the whole thread, so a mid-tension frame is a complete
      // thread that has gone slack rather than a shortened one. Ruling 13 makes
      // that true of every later frame too, which is what the suite below pins.
      const strand = slack.retire?.path as Point[]
      expect(distance(strand[0] as Point, pointOn(slack, 0))).toBeCloseTo(0, 6)
    })
  })

  /**
   * THE STRAND IS NEVER SHORTENED, AND NEVER DELETED (prd10 ruling 13).
   *
   * The suite this replaces measured a *remnant* — an arc that shrank on the
   * withdraw's own spring until it came to rest a mark's length short of the
   * node, and which prd10 ruling 2 then erased outright when the dissolve
   * finished. Ruling 13 rescinds both, so the assertions invert: the claim is now
   * that nothing anywhere in the return can make this path shorter than the
   * thread it belongs to, at any instant, ever.
   *
   * It is checked past `RETURN.dissolvedMs` deliberately. That is the instant the
   * old code returned an empty list at, and it is the one a regression would
   * reappear at.
   */
  describe('stage 2 — the vitality goes home and the strand stays', () => {
    /** Every instant that mattered, plus a long way past the end of all of them. */
    const INSTANTS = [
      0,
      RETURN.tensionMs * 0.5,
      RETURN.tensionMs,
      RETURN.tensionMs + RETURN.withdrawMs * 0.5,
      RETURN.tensionMs + RETURN.withdrawMs,
      RETURN.totalMs,
      RETURN.dissolvedMs - 1,
      RETURN.dissolvedMs,
      RETURN.dissolvedMs + 10_000,
      RETURN.totalMs * 1_000,
    ]

    it('keeps the strand threaded into the mass at every instant of the return', () => {
      for (const ms of INSTANTS) {
        const cut = cutting(returnAt(ms))
        const strand = cut.retire?.path as Point[]
        expect(strand, `no strand at ${ms} ms`).toBeDefined()
        expect(strand.length, `strand emptied at ${ms} ms`).toBeGreaterThan(2)
        // Its root end is the thread's root end — where it leaves the mass. A
        // strand that had let go would start somewhere out along the curve.
        expect(distance(strand[0] as Point, pointOn(cut, 0)), `parted at ${ms} ms`).toBeCloseTo(0, 6)
        // …and its far end is the node, so it spans the whole journey.
        expect(distance(strand[strand.length - 1] as Point, cut.node)).toBeCloseTo(0, 6)
      }
    })

    it('never draws less arc than the living thread had — nothing shortens', () => {
      const living = arcLength(whole.path)
      for (const ms of INSTANTS) {
        const cut = cutting(returnAt(ms))
        const length = arcLength(cut.retire?.path as Point[])
        // The release bows the curve (slack at the root, relax at the tip), so a
        // finished strand is a shade *longer* than the thread it grew from. What
        // it can never be is meaningfully shorter, which is the whole of ruling 13
        // as a number. The 1% is #118 rather than slack: the mass grows as this
        // lane's own work lands, and a thread leaving a bigger mass starts a
        // fraction further out.
        expect(length, `strand shrank at ${ms} ms`).toBeGreaterThan(living * 0.99)
        expect(length, `strand ballooned at ${ms} ms`).toBeLessThan(living * 1.3)
      }
    })

    it('is the drawn strand itself, not a copy that could drift off it', () => {
      // Every sample of the strand is a sample of the thread as drawn, which is
      // what lets `marks/dissolve.ts` ride motes down `thread.path` and land them
      // on the strand rather than beside it.
      const cut = cutting(returnAt(RETURN.totalMs))
      expect(cut.retire?.path).toEqual(cut.path)
    })

    it('carries the lane the last of the way to the rim — prd6 ruling 4', () => {
      const settled = cutting(returnAt(RETURN.totalMs))
      const out = (node: Point): number =>
        Math.hypot(node.x - SIZE.width / 2, node.y - SIZE.height / 2)

      // Coming to rest at the rim *is* the end of the journey, so the node really
      // does travel — and it travels straight out along the angle it always had,
      // which is the half graft g7 protects.
      expect(out(settled.node)).toBeGreaterThan(out(whole.node))
      expect(settled.angle).toBe(whole.angle)
      expect(settled.lifeFrac).toBe(1)

      // On the withdraw's own spring, one frame at a time — no jump.
      let previous = out(whole.node)
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const at = cutting(returnAt(RETURN.tensionMs + RETURN.withdrawMs * t))
        const now = out(at.node)
        expect(now).toBeGreaterThanOrEqual(previous - 1e-9)
        previous = now
      }

      // Reduced motion has no travel at all: the registry hands out a state with
      // the drift zeroed, so the lane's own journey does not advance by so much
      // as a frame. The node is not *identical* any more and that is #118 rather
      // than travel — this lane has landed its work, the mass is bigger for it,
      // and `bornRadial` has eased the whole living band out by a fraction of a
      // pixel to keep clear of it. Lifecycle unmoved, bearing unmoved, and the
      // displacement well under the pixel that would make it visible.
      const inPlace = cutting(returnAt(0, false))
      expect(inPlace.lifeFrac).toBe(whole.lifeFrac)
      expect(out(inPlace.node) - out(whole.node)).toBeLessThan(1)
      expect(out(inPlace.node)).toBeGreaterThanOrEqual(out(whole.node))
      // …and it keeps its whole strand, because a still line is not motion and
      // WCAG 2.3.3 has nothing to say about one. Asserted as an identity rather
      // than as a length: the strand *is* this lane's thread, in place.
      expect(inPlace.retire?.path).toEqual(inPlace.path)
    })
  })

  /**
   * SEVERED SUBSTANCE RETURNS HOME (prd6 ruling 2).
   *
   * The geometry half: a stretch of the lane's *own* thread, on the way down it
   * into the mass, over the withdraw and only over the withdraw.
   */
  describe('the way home', () => {
    /** Every frame of the withdraw that has substance in transit. */
    function inTransit(): { at: number; flow: Point[]; thread: ThreadGeometry }[] {
      const frames: { at: number; flow: Point[]; thread: ThreadGeometry }[] = []
      for (let ms = 0; ms <= RETURN.withdrawMs; ms += 10) {
        const thread = cutting(returnAt(RETURN.tensionMs + ms))
        const flow = thread.retire?.homeward ?? null
        if (flow !== null) frames.push({ at: ms, flow, thread })
      }
      return frames
    }

    it('travels the thread own path, from the node to the mass', () => {
      const frames = inTransit()
      // Long enough to be a journey rather than a flicker.
      expect(frames.length).toBeGreaterThan(20)

      let previous = Infinity
      for (const { at, flow, thread } of frames) {
        // *On* the thread, not near it: it is the thread's own matter.
        for (const point of flow) {
          expect(nearestOn(thread.path, point), `off the thread at ${at} ms`).toBeLessThan(0.6)
        }
        // Homeward: the leading edge never once turns back toward the node.
        const lead = distance(flow[0] as Point, pointOn(thread, 0))
        expect(lead, `went back outward at ${at} ms`).toBeLessThanOrEqual(previous + 1e-9)
        previous = lead
      }
      // It starts out at the node and finishes at the mass.
      const first = frames[0] as { flow: Point[]; thread: ThreadGeometry }
      const last = frames[frames.length - 1] as { flow: Point[]; thread: ThreadGeometry }
      expect(distance(first.flow[0] as Point, first.thread.node)).toBeLessThan(4)
      expect(distance(last.flow[0] as Point, pointOn(last.thread, 0))).toBeLessThan(1)
    })

    it('is nowhere to be seen before the withdraw, or after it', () => {
      // Nothing has parted during the tension release, so nothing is on its way.
      expect(cutting(returnAt(RETURN.tensionMs * 0.5)).retire?.homeward).toBeNull()
      // It arrived. A settled strand has sent everything it had.
      expect(cutting(returnAt(RETURN.totalMs)).retire?.homeward).toBeNull()
      expect(cutting(returnAt(RETURN.tensionMs + RETURN.withdrawMs)).retire?.homeward).toBeNull()
      // History, replay and reduced motion: settled outright, never in transit.
      expect(cutting(returnAt(0, false)).retire?.homeward).toBeNull()
    })

    it('sends the same amount of substance whatever angle the lane sits at', () => {
      // #102's surviving half, applied to the flow: measured in px, never in
      // fractions of a thread whose length is a fact about the aspect ratio. The
      // most any lane has in transit at once is one parcel, and it is one parcel
      // for all of them; what differs after that is only how much of it the mass
      // has already swallowed.
      const most = new Map<string, number>()
      for (let ms = 0; ms <= RETURN.withdrawMs; ms += 10) {
        const state = returnAt(RETURN.tensionMs + ms)
        const geometry = layoutScene(fleet, {
          ...SIZE,
          now: NOW,
          retire: new Map(fleet.lanes.map((lane) => [lane.id, state])),
        })
        for (const thread of geometry.threads) {
          const flow = thread.retire?.homeward ?? null
          if (flow === null) continue
          most.set(thread.laneId, Math.max(most.get(thread.laneId) ?? 0, arcLength(flow)))
        }
      }

      const lengths = [...most.values()]
      expect(lengths).toHaveLength(fleet.lanes.length)
      expect(Math.max(...lengths) / Math.min(...lengths)).toBeLessThan(1.05)
    })
  })

  describe('stage 3 — what stays', () => {
    const settledThread = cutting(returnAt(RETURN.totalMs))

    it('keeps the whole strand, from the mass to the node', () => {
      // Ruling 22 with the volume down, and ruling 13 with the volume back up: a
      // finished lane is still *drawn*, and what is drawn is the network it was
      // part of rather than a mark where it used to be.
      expect(settledThread.retire?.path.length).toBeGreaterThan(2)
      expect(arcLength(settledThread.retire?.path as Point[])).toBeGreaterThanOrEqual(
        arcLength(whole.path) * 0.999,
      )
    })

    /**
     * WHERE THE WORK-SIZE CHANNEL WENT (prd6 ruling 1, re-sited by ruling 13).
     *
     * The rim used to show a session's finished work in the **length** of each
     * stub, which is why `RELAX_REACH_*` was called a scar length. With the whole
     * strand kept, length is a fact about where the lane sits on the ellipse
     * again — so the channel is carried entirely by the strand's **width**, which
     * is the same channel the living network is drawn on and therefore the one an
     * operator is already reading. The relax reach still uses the lane's work,
     * but only to scatter where the strand ends (`RETIRE_RELAX_PX`).
     */
    it('tells the work in the strand width, on the absolute scale — prd6 ruling 1', () => {
      const settled = returnAt(RETURN.totalMs)
      const geometry = layoutScene(fleet, {
        ...SIZE,
        now: NOW,
        retire: new Map(fleet.lanes.map((lane) => [lane.id, settled])),
      })

      const sorted = [...geometry.threads].sort((a, b) => a.sizeFrac - b.sizeFrac)
      const smallest = sorted[0] as ThreadGeometry
      const biggest = sorted[sorted.length - 1] as ThreadGeometry
      // The premise: these lanes really do differ a lot in work.
      expect(biggest.sizeFrac).toBeGreaterThan(smallest.sizeFrac * 1.5)

      expect(biggest.retire?.widthRoot as number).toBeGreaterThan(
        (smallest.retire?.widthRoot as number) * 1.5,
      )
      // …and it is absolute, so it is the same width whatever else is in the fleet.
      const alone = layoutScene(fleet, {
        ...SIZE,
        now: NOW,
        retire: new Map([[biggest.laneId, settled]]),
      })
      expect((alone.byLane.get(biggest.laneId) as ThreadGeometry).retire?.widthRoot).toBeCloseTo(
        biggest.retire?.widthRoot as number,
        9,
      )
    })

    it('scatters where two equal lanes end, so a rim of them is not a wreath', () => {
      // #117's finding, which matters more with the strands kept than it did with
      // the stubs: same work, different clock position, and the ends must still
      // not land on one perfect ellipse.
      const settled = returnAt(RETURN.totalMs)
      const same = {
        ...fleet,
        lanes: fleet.lanes.map((lane) => ({ ...lane, outputTokens: 20_000 })),
      }
      const geometry = layoutScene(same, {
        ...SIZE,
        now: NOW,
        retire: new Map(same.lanes.map((lane) => [lane.id, settled])),
      })

      const radii = geometry.threads.map((thread) =>
        Math.hypot(thread.node.x - SIZE.width / 2, thread.node.y - SIZE.height / 2),
      )
      const spread = Math.max(...radii) - Math.min(...radii)
      expect(spread, 'every finished lane ended at the same radius').toBeGreaterThan(2)
      expect(RELAX_REACH_MIN_PX).toBeLessThan(RELAX_REACH_MAX_PX)
    })

    it('still measures the work: a bigger lane keeps a wider strand', () => {
      const busiest = [...fleet.lanes].sort((a, b) => b.outputTokens - a.outputTokens)[0]
      const smallest = [...fleet.lanes].sort((a, b) => a.outputTokens - b.outputTokens)[0]
      const settled = returnAt(RETURN.totalMs)
      const geometry = layoutScene(fleet, {
        ...SIZE,
        now: NOW,
        retire: new Map([
          [busiest?.id as string, settled],
          [smallest?.id as string, settled],
        ]),
      })

      const widthOf = (id: string): number =>
        (geometry.byLane.get(id) as ThreadGeometry).retire?.widthRoot as number
      expect(widthOf(busiest?.id as string)).toBeGreaterThan(widthOf(smallest?.id as string))
    })

    it('lands its label on the drifted node, so the name follows the mark', () => {
      expect(settledThread.label.anchor).not.toEqual(whole.label.anchor)
      expect(distance(settledThread.label.anchor, settledThread.node)).toBeCloseTo(
        distance(whole.label.anchor, whole.node),
        6,
      )
    })
  })

  describe('the hide-finished toggle', () => {
    it('hides a settled strand and nothing else', () => {
      expect(cutting(returnAt(RETURN.totalMs), true).retire?.hidden).toBe(true)
      expect(cutting(returnAt(RETURN.totalMs), false).retire?.hidden).toBe(false)
    })

    it('never hides a cut in progress — a completion is always announced', () => {
      // The one thing worse than a finished lane the operator asked not to see is a
      // completion they never saw at all.
      for (const ms of [0, RETURN.tensionMs, RETURN.tensionMs + 400, RETURN.totalMs - 1]) {
        expect(cutting(returnAt(ms), true).retire?.hidden, `hidden at ${ms} ms`).toBe(false)
      }
    })

    it('leaves the lane in the ring, so toggling never re-spaces the fleet', () => {
      const shown = layoutScene(fleet, { ...SIZE, now: NOW, retire: hidden(fleet), hideFinished: false })
      const gone = layoutScene(fleet, { ...SIZE, now: NOW, retire: hidden(fleet), hideFinished: true })

      expect(gone.threads).toHaveLength(shown.threads.length)
      for (const thread of gone.threads) {
        expect(thread.angle).toBe((shown.byLane.get(thread.laneId) as ThreadGeometry).angle)
      }
    })
  })

  /** Every lane in the fleet, settled into a persistent strand. */
  function hidden(of: Fleet): Map<string, RetireState> {
    return new Map(of.lanes.map((lane) => [lane.id, returnAt(RETURN.totalMs)]))
  }
})

/**
 * BOUNDED UNIQUENESS, IN SITU (prd7 ruling 4).
 *
 * `variation.test.ts` holds the channel table's arithmetic in isolation. This is
 * the half that matters to the instrument: that the wander reached the layout,
 * that it stayed inside its cap *in pixels on this panel*, and — the whole
 * point — that a lane's encoded facts are still recoverable from the geometry it
 * came out with.
 *
 * The threat model is worth naming, because it is the reason the ruling exists
 * at all. Every geometric channel here already carries a fact. If the wander
 * moved a node, the picture would report a lane as further through its life than
 * it is; if it moved an angle, "72 lives at four o'clock" would stop being true;
 * if it moved a width, a lane would look like it had done work it had not. None
 * of those failures looks like a bug. They look like data.
 */
describe('the wander is bounded, and the encoding survives it', () => {
  const fleet = fleetFor(fleet20Spec())

  it('bends the thread — the fleet is not drafted any more', () => {
    // The premise. Without this the three bounds below are vacuously satisfied
    // by a scene that never varied anything.
    const geometry = layout(fleet)
    const bows = geometry.threads.map((thread) => {
      const first = thread.path[0] as Point
      const straight = (t: number): Point => ({
        x: first.x + (thread.node.x - first.x) * t,
        y: first.y + (thread.node.y - first.y) * t,
      })
      return Math.max(
        ...thread.path.map((point, i) => distance(point, straight(i / (thread.path.length - 1)))),
      )
    })
    expect(Math.min(...bows)).toBeGreaterThan(1)
    // …and no two lanes bow the same amount, which is the "hand-grown" claim.
    expect(new Set(bows.map((bow) => bow.toFixed(6))).size).toBe(bows.length)
  })

  it('never moves a thread further sideways than the cap allows', () => {
    /**
     * The wander is the *only* difference between two fleets that are identical
     * but for their handles, because the handle is the seed and nothing else in
     * the layout reads one. So the distance between the two pictures is exactly
     * twice the wander, and bounding it bounds the channel — without this file
     * having to reconstruct the curve the wander was applied to.
     */
    const named = (lanes: number, suffix: string): SceneGeometry =>
      layout({
        ...fleet,
        lanes: Array.from({ length: lanes }, (_unused, i) => ({
          ...(fleet.lanes[i % fleet.lanes.length] as Lane),
          id: `lane-${i}`,
          handles: [`lane-${i}${suffix}`],
          slot: i,
        })),
      })

    // The cap is a fraction of lane spacing, so it is the same *perceptual*
    // amount at four lanes and at thirty — which is what stops the wander from
    // reading as one lane crossing into another's territory on a busy fleet.
    for (const lanes of [4, 12, 30]) {
      const mine = named(lanes, '')
      const theirs = named(lanes, '-elsewhere')
      const cap = WANDER_MAX_SPACING * rimSpacing(mine.rx, mine.ry, lanes)

      let apart = 0
      mine.threads.forEach((thread, i) => {
        const other = theirs.threads[i] as ThreadGeometry
        expect(other.node).toEqual(thread.node)
        thread.path.forEach((point, k) => {
          apart = Math.max(apart, distance(point, other.path[k] as Point))
        })
      })

      expect(apart, `${lanes} lanes wandered past the cap`).toBeLessThanOrEqual(2 * cap + 1e-9)
      expect(apart, `${lanes} lanes did not wander at all`).toBeGreaterThan(cap * 0.2)
    }
  })

  it('leaves the encoded endpoints exactly where the layout put them', () => {
    // The invariant everything else rests on. Recomputed here from the *fleet
    // facts* rather than read off the geometry, so it is a claim about the
    // encoding rather than a tautology: a lane's node sits at its lifecycle
    // radius, on its own angle, whatever the wander did in between.
    const geometry = layout(fleet)
    for (const thread of geometry.threads) {
      const life = lifecycleFrac(thread.sizeFrac, NOW - thread.lane.firstSeenAt, 0)
      const born = bornRadial(geometry.rootRadius, geometry.rx, geometry.ry)
      const radial = born + (1 - born) * life

      expect(thread.node.x, `${thread.laneId} moved off its radius`).toBeCloseTo(
        geometry.centre.x + geometry.rx * radial * Math.cos(thread.angle),
        9,
      )
      expect(thread.node.y).toBeCloseTo(
        geometry.centre.y + geometry.ry * radial * Math.sin(thread.angle),
        9,
      )
    }
  })

  it('leaves the encoded width exactly where the layout put it', () => {
    // The ±10% jitter is spent on the *drawn outline* (`marks/`), never on the
    // number. So the work-size channel reads back off the geometry unchanged,
    // and prd6 ruling 1's absolute scale is untouched by prd7.
    const geometry = layout(fleet)
    for (const thread of geometry.threads) {
      expect(thread.widthRoot).toBe(1.2 + 5 * seedSize(thread.lane.outputTokens))
    }
  })

  it('draws the same fleet the same way, twice', () => {
    // Determinism, at the level the operator sees it: same state in, same
    // geometry out — no clock in the noise, no `Math.random`, no dependence on
    // which lane was laid out first.
    const once = layout(fleet)
    const twice = layout(fleet)
    expect(twice.threads.map((t) => t.path)).toEqual(once.threads.map((t) => t.path))
  })

  it('gives a lane the same shape however its handles arrived', () => {
    // The seed is the handle, and two collectors can report a lane's handles in
    // either order. A picture that changed shape depending on which collector
    // spoke first would be reporting the collectors.
    const swapped = {
      ...fleet,
      lanes: fleet.lanes.map((lane) => ({ ...lane, handles: [...lane.handles].reverse() })),
    }
    expect(layout(swapped).threads.map((t) => t.path)).toEqual(
      layout(fleet).threads.map((t) => t.path),
    )
  })
})

function pointOn(thread: ThreadGeometry, t: number): Point {
  const at = Math.max(0, Math.min(1, t)) * (thread.path.length - 1)
  const i = Math.floor(at)
  const a = thread.path[i] as Point
  const b = thread.path[Math.min(thread.path.length - 1, i + 1)] as Point
  const f = at - i
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** How far this lane's node sits from the root-mass — the lifecycle, in px. */
function reach(geometry: SceneGeometry, thread: ThreadGeometry): number {
  return distance(thread.node, geometry.centre)
}

/** How far a point is from the polyline itself — segments, not just vertices. */
function nearestOn(path: readonly Point[], point: Point): number {
  let best = Infinity
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const dx = b.x - a.x
    const dy = b.y - a.y
    const span = dx * dx + dy * dy
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / span))
    best = Math.min(best, distance(point, { x: a.x + dx * t, y: a.y + dy * t }))
  }
  return best
}

function arcLength(path: readonly Point[]): number {
  let total = 0
  for (let i = 1; i < path.length; i += 1) {
    total += distance(path[i - 1] as Point, path[i] as Point)
  }
  return total
}
