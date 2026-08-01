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
  RECENCY_SPAN_MS,
  layoutScene,
  ringAngles,
  type SceneGeometry,
} from './geometry.js'

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

  it('puts a silent lane further from the root-mass than a busy one', () => {
    const busy = geometry.byLane.get('44-scene-pulses')
    const silent = geometry.byLane.get('42-otel-receiver')
    expect(busy).toBeDefined()
    expect(silent).toBeDefined()

    const from = (node: { x: number; y: number }): number =>
      Math.hypot(node.x - geometry.centre.x, node.y - geometry.centre.y)
    expect(from(silent?.node as { x: number; y: number })).toBeGreaterThan(
      from(busy?.node as { x: number; y: number }),
    )
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
