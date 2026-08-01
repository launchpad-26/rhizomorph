import { reduceAll, type ObservatoryEvent } from '@observatory/core'
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
  SCAR_LENGTH_MAX_PX,
  SCAR_LENGTH_MIN_PX,
  SEED_CEILING,
  SEED_FLOOR,
  SEED_FULL_TOKENS,
  layoutScene,
  lifecycleFrac,
  ringAngles,
  scarLengthPx,
  seedSize,
  type Point,
  type SceneGeometry,
  type ThreadGeometry,
} from './geometry.js'
import { CUT, cutAt, type RetireState } from './retire.js'

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

function fleetFor(spec: FixtureSpec, events?: readonly ObservatoryEvent[]): Fleet {
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
function reordered(events: readonly ObservatoryEvent[]): ObservatoryEvent[] {
  const out = [...events]
  let seed = 12345
  for (let i = out.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const j = seed % (i + 1)
    ;[out[i], out[j]] = [out[j] as ObservatoryEvent, out[i] as ObservatoryEvent]
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

    const geometry = layout(
      withLane(fleet, LANE, { outputTokens: 0, firstSeenAt: NOW }),
    )
    const thread = geometry.byLane.get(LANE) as ThreadGeometry
    // Clear of the root-mass it grew out of, and short of the ring the worked
    // lanes have reached.
    expect(reach(geometry, thread)).toBeGreaterThan(geometry.rootRadius)
    expect(thread.lifeFrac).toBeLessThan(
      (geometry.byLane.get('44-scene-pulses') as ThreadGeometry).lifeFrac,
    )
    expect(RADIAL_BORN).toBeGreaterThan(0.32)
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
    expect(at(cutAt(CUT.tensionMs)).lifeFrac).toBeCloseTo(living.lifeFrac, 9)
    expect(at(cutAt(CUT.totalMs)).lifeFrac).toBe(1)

    // …and it travels there, one frame at a time, over the retract.
    let previous = living.lifeFrac
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const value = at(cutAt(CUT.tensionMs + CUT.retractMs * t)).lifeFrac
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
      layoutScene(fleet, { ...SIZE, now: NOW, retire: new Map([[LANE, cutAt(CUT.totalMs)]]) }),
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
  const scar = new Map([[RETIRED, cutAt(CUT.totalMs)]])

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

  const before = layoutScene(fleet, { ...SIZE, now: NOW, retire: scar })
  const after = layoutScene(redispatched(), { ...SIZE, now: NOW, retire: scar })

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

  it('leaves the seed where it is — a scar is not consumed by sprouting', () => {
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
      { ...SIZE, now: NOW, retire: scar },
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
 * THE CORD-CUT, as shape (prd5 ruling 3).
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
  /** What this lane's own work buys it at the rim (prd6 ruling 1). */
  const MARK_PX = scarLengthPx(whole.sizeFrac)

  it('leaves every other lane exactly where it was', () => {
    // One lane retiring is not a reflow. The ring is subdivided by how many lanes
    // there *are*, and a lane leaving the network does not leave the fleet — so
    // nobody else moves, and graft g7 survives a landing.
    const before = layout(fleet)
    const during = layoutScene(fleet, {
      ...SIZE,
      now: NOW,
      retire: new Map([[LANE, cutAt(CUT.tensionMs + 200)]]),
    })

    for (const thread of during.threads) {
      if (thread.laneId === LANE) continue
      const was = before.byLane.get(thread.laneId) as ThreadGeometry
      expect(thread.angle, `${thread.laneId} moved`).toBe(was.angle)
      expect(thread.node).toEqual(was.node)
      expect(thread.path).toEqual(was.path)
    }
  })

  it('draws no cut at all for a lane the registry says nothing about', () => {
    expect(whole.retire).toBeNull()
  })

  describe('stage 1 — the tension goes out of it', () => {
    const slack = cutting(cutAt(CUT.tensionMs))

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

    it('is still tied into the mass — nothing has parted', () => {
      expect(slack.retire?.from).toBe(0)
      // The remnant is still the whole thread, so a mid-tension frame is a
      // complete thread that has gone slack rather than a shortened one.
      const remnant = slack.retire?.path as Point[]
      expect(distance(remnant[0] as Point, pointOn(slack, 0))).toBeCloseTo(0, 6)
    })
  })

  describe('stage 2 — it springs back', () => {
    it('carries the freed end along the thread own path', () => {
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const state = cutAt(CUT.tensionMs + CUT.retractMs * t)
        const cut = cutting(state)
        const freed = (cut.retire?.path as Point[])[0] as Point
        // Not "near the path" — *on* it, at exactly the parameter the retract
        // says it has reached. The freed end is a point travelling along a curve
        // that already existed, which is what makes it read as the same thread
        // rather than as a new mark flying in.
        expect(distance(freed, pointOn(cut, cut.retire?.from as number))).toBeCloseTo(0, 6)
      }
    })

    it('shortens the remnant monotonically, and never past the scar', () => {
      let previous = Infinity
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const cut = cutting(cutAt(CUT.tensionMs + CUT.retractMs * t))
        const length = arcLength(cut.retire?.path as Point[])
        expect(length).toBeLessThanOrEqual(previous + 1e-9)
        previous = length
      }
      // …and it comes to rest about a mark's length of arc short of the node,
      // whatever the thread's own length is. "About" because the node has moved
      // out to the rim by then, which bows the mark a little longer than the
      // straight measure taken before it travelled.
      const scar = cutting(cutAt(CUT.totalMs))
      expect(arcLength(scar.retire?.path as Point[])).toBeGreaterThan(MARK_PX)
      expect(arcLength(scar.retire?.path as Point[])).toBeLessThan(MARK_PX * 1.3)
    })

    it('carries the lane the last of the way to the rim — prd6 ruling 4', () => {
      const settled = cutting(cutAt(CUT.totalMs))
      const out = (node: Point): number =>
        Math.hypot(node.x - SIZE.width / 2, node.y - SIZE.height / 2)

      // Retiring at the rim *is* the end of the journey now, so the node really
      // does travel — and it travels straight out along the angle it always had,
      // which is the half graft g7 protects.
      expect(out(settled.node)).toBeGreaterThan(out(whole.node))
      expect(settled.angle).toBe(whole.angle)
      expect(settled.lifeFrac).toBe(1)

      // On the retract's own spring, one frame at a time — no jump.
      let previous = out(whole.node)
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const at = cutting(cutAt(CUT.tensionMs + CUT.retractMs * t))
        const now = out(at.node)
        expect(now).toBeGreaterThanOrEqual(previous - 1e-9)
        previous = now
      }

      // Reduced motion has no travel at all: the registry hands out a state with
      // the drift zeroed, and the node is left exactly where it was.
      const inPlace = cutting(cutAt(0, false))
      expect(inPlace.node).toEqual(whole.node)
      // No drift, so the mark is the measured length plus only the slack's own
      // couple of pixels of bow.
      const still = arcLength(inPlace.retire?.path as Point[])
      expect(still).toBeGreaterThan(MARK_PX)
      expect(still).toBeLessThan(MARK_PX * 1.1)
    })
  })

  /**
   * SEVERED SUBSTANCE RETURNS HOME (prd6 ruling 2).
   *
   * The geometry half: a stretch of the lane's *own* thread, on the way down it
   * into the mass, over the retract and only over the retract.
   */
  describe('the way home', () => {
    /** Every frame of the retract that has substance in transit. */
    function inTransit(): { at: number; flow: Point[]; thread: ThreadGeometry }[] {
      const frames: { at: number; flow: Point[]; thread: ThreadGeometry }[] = []
      for (let ms = 0; ms <= CUT.retractMs; ms += 10) {
        const thread = cutting(cutAt(CUT.tensionMs + ms))
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

    it('is nowhere to be seen before the retract, or after it', () => {
      // Nothing has parted during the tension release, so nothing is on its way.
      expect(cutting(cutAt(CUT.tensionMs * 0.5)).retire?.homeward).toBeNull()
      // It arrived. A settled scar has sent everything it had.
      expect(cutting(cutAt(CUT.totalMs)).retire?.homeward).toBeNull()
      expect(cutting(cutAt(CUT.tensionMs + CUT.retractMs)).retire?.homeward).toBeNull()
      // History, replay and reduced motion: scarred outright, never in transit.
      expect(cutting(cutAt(0, false)).retire?.homeward).toBeNull()
    })

    it('sends the same amount of substance whatever angle the lane sits at', () => {
      // #102's surviving half, applied to the flow: measured in px, never in
      // fractions of a thread whose length is a fact about the aspect ratio. The
      // most any lane has in transit at once is one parcel, and it is one parcel
      // for all of them; what differs after that is only how much of it the mass
      // has already swallowed.
      const most = new Map<string, number>()
      for (let ms = 0; ms <= CUT.retractMs; ms += 10) {
        const state = cutAt(CUT.tensionMs + ms)
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

  describe('stage 3 — what is left', () => {
    const scar = cutting(cutAt(CUT.totalMs))

    it('keeps a short tapering mark near the rim, not a point', () => {
      // Ruling 22 with the volume down: a scar is still *drawn*, and a mark with
      // no length would be a lane the operator cannot point at.
      expect(scar.retire?.path.length).toBeGreaterThan(2)
      const length = arcLength(scar.retire?.path as Point[])
      expect(length).toBeGreaterThan(MARK_PX)
      expect(length).toBeLessThan(MARK_PX * 1.3)
    })

    it('keeps the seed size it earned, and only that — prd6 ruling 1', () => {
      // Two halves of #102, and prd6 ruling 1 overrules exactly one of them.
      //
      // Standing: the mark is measured in **px**, so a lane at three o'clock —
      // whose thread is three times as long as one at noon on this ellipse — does
      // not get three times the scar. That was never a fact about the lane.
      //
      // Overruled: "the same size for every lane". The rim is where a session's
      // finished work is on display, and nine identical stubs throw away the only
      // thing the rim had to say about them.
      const settled = cutAt(CUT.totalMs)
      const geometry = layoutScene(fleet, {
        ...SIZE,
        now: NOW,
        retire: new Map(fleet.lanes.map((lane) => [lane.id, settled])),
      })

      const threads = geometry.threads.map((thread) => arcLength(thread.path))
      // The premise: the threads really do differ a lot in length.
      expect(Math.max(...threads) / Math.min(...threads)).toBeGreaterThan(1.5)

      for (const thread of geometry.threads) {
        const wanted = scarLengthPx(thread.sizeFrac)
        const length = arcLength(thread.retire?.path as Point[])
        expect(length, `${thread.laneId} scarred off its own work`).toBeGreaterThan(wanted)
        expect(length).toBeLessThan(wanted * 1.3)
      }

      // And the big lane's mark really is bigger than the small one's.
      const sorted = [...geometry.threads].sort((a, b) => a.sizeFrac - b.sizeFrac)
      const smallest = arcLength((sorted[0] as ThreadGeometry).retire?.path as Point[])
      const biggest = arcLength(
        (sorted[sorted.length - 1] as ThreadGeometry).retire?.path as Point[],
      )
      expect(biggest).toBeGreaterThan(smallest * 1.15)
      expect(SCAR_LENGTH_MIN_PX).toBeLessThan(SCAR_LENGTH_MAX_PX)
    })

    it('scars two equal lanes the same length wherever they sit', () => {
      // The aspect-ratio half of #102, stated on its own: same work, different
      // clock position, same mark.
      const settled = cutAt(CUT.totalMs)
      const same = {
        ...fleet,
        lanes: fleet.lanes.map((lane) => ({ ...lane, outputTokens: 20_000 })),
      }
      const geometry = layoutScene(same, {
        ...SIZE,
        now: NOW,
        retire: new Map(same.lanes.map((lane) => [lane.id, settled])),
      })

      const lengths = geometry.threads.map((thread) => arcLength(thread.retire?.path as Point[]))
      expect(Math.max(...lengths) / Math.min(...lengths)).toBeLessThan(1.2)
    })

    it('still measures the work: a bigger lane scars a wider mark', () => {
      const busiest = [...fleet.lanes].sort((a, b) => b.outputTokens - a.outputTokens)[0]
      const smallest = [...fleet.lanes].sort((a, b) => a.outputTokens - b.outputTokens)[0]
      const settled = cutAt(CUT.totalMs)
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
      expect(scar.label.anchor).not.toEqual(whole.label.anchor)
      expect(distance(scar.label.anchor, scar.node)).toBeCloseTo(
        distance(whole.label.anchor, whole.node),
        6,
      )
    })
  })

  describe('the hide-finished toggle', () => {
    it('hides a settled scar and nothing else', () => {
      expect(cutting(cutAt(CUT.totalMs), true).retire?.hidden).toBe(true)
      expect(cutting(cutAt(CUT.totalMs), false).retire?.hidden).toBe(false)
    })

    it('never hides a cut in progress — a completion is always announced', () => {
      // The one thing worse than a scar the operator asked not to see is a
      // completion they never saw at all.
      for (const ms of [0, CUT.tensionMs, CUT.tensionMs + 400, CUT.totalMs - 1]) {
        expect(cutting(cutAt(ms), true).retire?.hidden, `hidden at ${ms} ms`).toBe(false)
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

  /** Every lane in the fleet, settled into a scar. */
  function hidden(of: Fleet): Map<string, RetireState> {
    return new Map(of.lanes.map((lane) => [lane.id, cutAt(CUT.totalMs)]))
  }
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
