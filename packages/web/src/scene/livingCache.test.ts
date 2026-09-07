import { buildFleet, fixtureHistory, fleet20Spec, manifestFor } from '../fleet/index.js'
import { reduceAll } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { layoutScene } from './geometry.js'
import { ribbonOutline } from './ribbon.js'

/**
 * THE LIVING-SPINE CACHE'S LAWS (loop 14) — #178's discipline, extended to
 * lanes that are still alive, with the measurement that justified it recorded
 * in the design note and the journal rather than asserted here (a wall clock
 * under --maxWorkers measures the box, not the code — perf.test.ts's rule).
 *
 * What IS asserted is the contract: identity stability inside a lifecycle
 * tick, honest invalidation on every real input, byte-safety of the cached
 * values, and the bud's exemption (the one time-varying organ is never
 * cached).
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const PANEL = { width: 1100, height: 620 }

function fleetAt(now = NOW) {
  const spec = fleet20Spec()
  const history = fixtureHistory(spec, now)
  return buildFleet(reduceAll(history), { now, manifest: manifestFor(spec) })
}

describe('the living-spine cache', () => {
  it('hands back the SAME path arrays inside one lifecycle tick', () => {
    const fleet = fleetAt()
    const a = layoutScene(fleet, { ...PANEL, now: NOW, retire: new Map() })
    const b = layoutScene(fleet, { ...PANEL, now: NOW + 400, retire: new Map() })
    for (let i = 0; i < a.threads.length; i++) {
      expect(b.threads[i]?.path).toBe(a.threads[i]?.path)
      expect(b.threads[i]?.filaments).toBe(a.threads[i]?.filaments)
    }
  })

  it('recomputes across a tick, and the step is invisible — under 0.05px', () => {
    const fleet = fleetAt()
    const a = layoutScene(fleet, { ...PANEL, now: NOW, retire: new Map() })
    const b = layoutScene(fleet, { ...PANEL, now: NOW + 1_000, retire: new Map() })
    let maxDelta = 0
    for (let i = 0; i < a.threads.length; i++) {
      const pa = a.threads[i]?.path ?? []
      const pb = b.threads[i]?.path ?? []
      expect(pb).not.toBe(pa)
      expect(pb.length).toBe(pa.length)
      for (let j = 0; j < pa.length; j++) {
        const p = pa[j] as { x: number; y: number }
        const q = pb[j] as { x: number; y: number }
        maxDelta = Math.max(maxDelta, Math.abs(p.x - q.x), Math.abs(p.y - q.y))
      }
    }
    expect(maxDelta).toBeLessThan(0.05)
  })

  it('a growth step is a real input — no stale spine during the choreography', () => {
    const fleet = fleetAt()
    const laneId = fleet.lanes[0]?.id as string
    const half = layoutScene(fleet, {
      ...PANEL, now: NOW, retire: new Map(), growth: new Map([[laneId, 0.5]]),
    })
    const more = layoutScene(fleet, {
      ...PANEL, now: NOW + 16, retire: new Map(), growth: new Map([[laneId, 0.51]]),
    })
    const a = half.threads.find((t) => t.laneId === laneId)
    const b = more.threads.find((t) => t.laneId === laneId)
    expect(b?.path).not.toBe(a?.path)
    // and the reach genuinely advanced: a longer truncation of the same curve
    expect((b?.path.length ?? 0) >= (a?.path.length ?? 0)).toBe(true)
  })

  it('never changes the values — a cache hit is byte-identical to a fresh build', () => {
    // Two identical worlds built from scratch: the second fleet's lanes carry
    // the same ids and sizes, so the second layout READS the first one's cache.
    // If the cache were wrong in any byte, this fresh-vs-cached comparison and
    // the pinned parity captures would both see it.
    const one = layoutScene(fleetAt(), { ...PANEL, now: NOW, retire: new Map() })
    const two = layoutScene(fleetAt(), { ...PANEL, now: NOW, retire: new Map() })
    expect(two.threads.map((t) => t.path)).toEqual(one.threads.map((t) => t.path))
  })

  it('the bud is never cached — its vitality reading stays on the clock', () => {
    const fleet = fleetAt()
    const a = layoutScene(fleet, { ...PANEL, now: NOW, retire: new Map() })
    const b = layoutScene(fleet, { ...PANEL, now: NOW + 400, retire: new Map() })
    const budded = a.threads
      .map((t, i) => [t, b.threads[i]] as const)
      .filter(([t]) => t.bud !== null)
    expect(budded.length).toBeGreaterThan(0)
    for (const [was, is] of budded) {
      expect(is?.path).toBe(was.path) // same tick: the spine coasted…
      expect(is?.bud).not.toBe(was.bud) // …and the bud did not
    }
  })
})

describe('the outline cache', () => {
  const spine = Array.from({ length: 12 }, (_, i) => ({ x: i * 10, y: Math.sin(i / 3) * 8 }))

  it('answers the same spine identity with the same arrays', () => {
    const a = ribbonOutline({ spine, widthRoot: 4, widthTip: 1 })
    const b = ribbonOutline({ spine, widthRoot: 4, widthTip: 1 })
    expect(b).toBe(a)
  })

  it('a different width is a different outline — and a cloned spine rebuilds the same bytes', () => {
    const a = ribbonOutline({ spine, widthRoot: 4, widthTip: 1 })
    const wider = ribbonOutline({ spine, widthRoot: 8, widthTip: 1 })
    expect(wider).not.toBe(a)
    const fresh = ribbonOutline({ spine: spine.map((p) => ({ ...p })), widthRoot: 4, widthTip: 1 })
    expect(fresh).not.toBe(a)
    expect(fresh).toEqual(a)
  })
})

describe('the pre-truncation cache (prd-52 ruling 4, #315)', () => {
  /** Every lane at one growth value, so `growth` is the only term that moves. */
  function growthOf(fleet: ReturnType<typeof fleetAt>, at: number): Map<string, number> {
    return new Map(fleet.lanes.map((lane) => [lane.id, at]))
  }

  it('reuses the curve when only growth moved', () => {
    // The living cache cannot answer either of these frames from the other:
    // its key carries both growth terms and both differ here, so it misses.
    // What survives the miss is the *base* — and both of these frames draw the
    // whole curve (one because it is fully grown, one because travel is off),
    // so a base hit is observable as literally the same array.
    const fleet = fleetAt()
    const a = layoutScene(fleet, { ...PANEL, now: NOW, growth: growthOf(fleet, 1) })
    const b = layoutScene(fleet, {
      ...PANEL,
      now: NOW,
      growth: growthOf(fleet, 0.4),
      growthTravel: false,
    })

    expect(a.threads.length).toBeGreaterThan(0)
    for (let i = 0; i < a.threads.length; i++) {
      expect(b.threads[i]?.path).toBe(a.threads[i]?.path)
    }
  })

  it('still truncates a growing lane, rather than handing it the whole curve', () => {
    // The risk the cache introduces, stated as a law: a shared base must not
    // leak the full curve to a lane that has not grown into it. A half-grown
    // thread's tip is nearer the mass than a finished one's.
    const fleet = fleetAt()
    const grown = layoutScene(fleet, { ...PANEL, now: NOW, growth: growthOf(fleet, 1) })
    const half = layoutScene(fleet, { ...PANEL, now: NOW, growth: growthOf(fleet, 0.5) })

    let checked = 0
    for (let i = 0; i < grown.threads.length; i++) {
      const g = grown.threads[i]
      const h = half.threads[i]
      if (g === undefined || h === undefined) continue
      const reach = (t: typeof g) => {
        const tip = t.path[t.path.length - 1]
        if (tip === undefined) return 0
        return Math.hypot(tip.x - grown.centre.x, tip.y - grown.centre.y)
      }
      expect(h.path).not.toBe(g.path)
      expect(reach(h)).toBeLessThan(reach(g))
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('keeps a fully-grown lane on one array, which is what the outline cache rides', () => {
    // `ribbon.ts`'s OUTLINE_CACHE is a WeakMap keyed on the path array's own
    // identity. It needs no change of its own precisely because a grown lane's
    // path IS the base's curve rather than a copy of it — asserted here so
    // that stays true, since a copy would silently cost every grown lane its
    // outline every frame.
    const fleet = fleetAt()
    const a = layoutScene(fleet, { ...PANEL, now: NOW, growth: growthOf(fleet, 1) })
    const b = layoutScene(fleet, { ...PANEL, now: NOW + 400, growth: growthOf(fleet, 1) })
    for (let i = 0; i < a.threads.length; i++) {
      expect(b.threads[i]?.path).toBe(a.threads[i]?.path)
    }
  })
})
