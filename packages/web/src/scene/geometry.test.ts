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
  SCAR_LENGTH_PX,
  layoutScene,
  ringAngles,
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
      // …and it comes to rest about SCAR_LENGTH_PX of arc length short of the
      // node, whatever the thread's own length is. "About" because the node has
      // drifted outward by then, which bows the mark a little longer than the
      // straight measure taken before the drift.
      const scar = cutting(cutAt(CUT.totalMs))
      expect(arcLength(scar.retire?.path as Point[])).toBeGreaterThan(SCAR_LENGTH_PX)
      expect(arcLength(scar.retire?.path as Point[])).toBeLessThan(SCAR_LENGTH_PX * 1.3)
    })

    it('drifts the node outward toward the rim, a little', () => {
      const settled = cutting(cutAt(CUT.totalMs))
      const out = (node: Point): number =>
        Math.hypot(node.x - SIZE.width / 2, node.y - SIZE.height / 2)

      expect(out(settled.node)).toBeGreaterThan(out(whole.node))
      // "Slightly": a drift big enough to re-read as a layout change would undo
      // graft g7's whole promise that a lane stays where you left it.
      expect(distance(settled.node, whole.node)).toBeLessThan(14)
      // And it is the drift, not the retract, that does it — so reduced motion
      // (which zeroes the drift) leaves the node exactly put.
      const inPlace = cutting(cutAt(0, false))
      expect(inPlace.node).toEqual(whole.node)
      // No drift, so the mark is the measured length plus only the slack's own
      // couple of pixels of bow.
      const still = arcLength(inPlace.retire?.path as Point[])
      expect(still).toBeGreaterThan(SCAR_LENGTH_PX)
      expect(still).toBeLessThan(SCAR_LENGTH_PX * 1.1)
    })
  })

  describe('stage 3 — what is left', () => {
    const scar = cutting(cutAt(CUT.totalMs))

    it('keeps a short tapering mark near the rim, not a point', () => {
      // Ruling 22 with the volume down: a scar is still *drawn*, and a mark with
      // no length would be a lane the operator cannot point at.
      expect(scar.retire?.path.length).toBeGreaterThan(2)
      const length = arcLength(scar.retire?.path as Point[])
      expect(length).toBeGreaterThan(SCAR_LENGTH_PX)
      expect(length).toBeLessThan(SCAR_LENGTH_PX * 1.3)
    })

    it('is the same size mark for every lane, wherever the lane sits', () => {
      // The rim is a wide ellipse, so a lane at three o'clock has a thread three
      // times as long as one at noon. A scar is a mark, not a fraction of a
      // thread: its size must not be a fact about the panel's aspect ratio.
      const settled = cutAt(CUT.totalMs)
      const geometry = layoutScene(fleet, {
        ...SIZE,
        now: NOW,
        retire: new Map(fleet.lanes.map((lane) => [lane.id, settled])),
      })

      const lengths = geometry.threads.map(
        (thread) => arcLength(thread.retire?.path as Point[]),
      )
      const threads = geometry.threads.map((thread) => arcLength(thread.path))
      // The premise: the threads really do differ a lot in length.
      expect(Math.max(...threads) / Math.min(...threads)).toBeGreaterThan(1.5)
      // The claim: the scars barely differ at all.
      expect(Math.max(...lengths) / Math.min(...lengths)).toBeLessThan(1.2)
      for (const length of lengths) {
        expect(length).toBeGreaterThan(SCAR_LENGTH_PX)
        expect(length).toBeLessThan(SCAR_LENGTH_PX * 1.3)
      }
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

function arcLength(path: readonly Point[]): number {
  let total = 0
  for (let i = 1; i < path.length; i += 1) {
    total += distance(path[i - 1] as Point, path[i] as Point)
  }
  return total
}
