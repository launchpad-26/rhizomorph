import { describe, expect, it } from 'vitest'
import { bandsFor } from './bands.js'
import { TIDE_START_TS, generateEventLog } from './fixtures.js'
import { rowPlan, type RowCandidate, type RowDescriptor } from './rowPlan.js'

const T0 = TIDE_START_TS
const MINUTE = 60_000

const FLEET: RowCandidate[] = [
  { lane: 'ke5', firstSeenTs: T0 },
  { lane: 'zz', firstSeenTs: T0 + MINUTE },
  { lane: 'aa', firstSeenTs: T0 + 2 * MINUTE },
  { lane: 'm2', firstSeenTs: T0 + 3 * MINUTE },
  { lane: 'q9', firstSeenTs: T0 + 4 * MINUTE },
  { lane: 'w1', firstSeenTs: T0 + 5 * MINUTE },
]

function laneNames(plan: readonly RowDescriptor[]): string[] {
  return plan.flatMap((row) => (row.kind === 'lane' ? [row.lane] : [...row.lanes]))
}

describe('rowPlan — a lane keeps its row for the session (ruling 3)', () => {
  it('orders by first sighting, not alphabetically and never by attention', () => {
    expect(laneNames(rowPlan(FLEET, 10))).toEqual(['ke5', 'zz', 'aa', 'm2', 'q9', 'w1'])
  })

  it('breaks a tie on the handle, so a shared instant is still one order', () => {
    const tied: RowCandidate[] = [
      { lane: 'zz', firstSeenTs: T0 },
      { lane: 'aa', firstSeenTs: T0 },
      { lane: 'mm', firstSeenTs: T0 },
    ]
    expect(laneNames(rowPlan(tied, 10))).toEqual(['aa', 'mm', 'zz'])
  })

  it('collapses a repeated lane onto its earliest sighting', () => {
    const repeated: RowCandidate[] = [
      { lane: 'ke5', firstSeenTs: T0 + 5 * MINUTE },
      { lane: 'm2', firstSeenTs: T0 + MINUTE },
      { lane: 'ke5', firstSeenTs: T0 },
    ]
    expect(rowPlan(repeated, 10)).toEqual([
      { kind: 'lane', lane: 'ke5', firstSeenTs: T0 },
      { kind: 'lane', lane: 'm2', firstSeenTs: T0 + MINUTE },
    ])
  })

  it('appends a newly-seen lane rather than inserting it among the others', () => {
    const before = rowPlan(FLEET, 10)
    const after = rowPlan([...FLEET, { lane: 'new', firstSeenTs: T0 + 9 * MINUTE }], 10)
    expect(after.slice(0, before.length)).toEqual(before)
  })
})

describe('rowPlan — the remainder coalesces (ruling 4)', () => {
  it('folds everything past the budget into one `+N` row carrying its count', () => {
    const plan = rowPlan(FLEET, 3)
    expect(plan).toEqual([
      { kind: 'lane', lane: 'ke5', firstSeenTs: T0 },
      { kind: 'lane', lane: 'zz', firstSeenTs: T0 + MINUTE },
      { kind: 'lane', lane: 'aa', firstSeenTs: T0 + 2 * MINUTE },
      { kind: 'more', count: 3, lanes: ['m2', 'q9', 'w1'] },
    ])
  })

  it('never spends a row on `+1` — it costs the same and says less', () => {
    const plan = rowPlan(FLEET, 5)
    expect(plan.every((row) => row.kind === 'lane')).toBe(true)
    expect(plan).toHaveLength(6)
  })

  it('never returns more than topN + 1 descriptors', () => {
    for (let topN = 0; topN <= 8; topN += 1) {
      expect(rowPlan(FLEET, topN).length).toBeLessThanOrEqual(topN + 1)
    }
  })

  it('coalesces the whole fleet at topN 0, and returns nothing for no lanes', () => {
    expect(rowPlan(FLEET, 0)).toEqual([
      { kind: 'more', count: 6, lanes: ['ke5', 'zz', 'aa', 'm2', 'q9', 'w1'] },
    ])
    expect(rowPlan([], 5)).toEqual([])
  })

  it('keeps every lane exactly once, at every budget', () => {
    for (let topN = 0; topN <= 8; topN += 1) {
      const names = laneNames(rowPlan(FLEET, topN))
      expect([...names].sort()).toEqual(FLEET.map((row) => row.lane).sort())
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it('counts exactly the lanes it names', () => {
    for (let topN = 0; topN <= 8; topN += 1) {
      for (const row of rowPlan(FLEET, topN)) {
        if (row.kind === 'more') expect(row.count).toBe(row.lanes.length)
      }
    }
  })

  it('shows a prefix of one canonical order, whatever the budget', () => {
    const canonical = laneNames(rowPlan(FLEET, FLEET.length))
    for (let topN = 0; topN <= 8; topN += 1) {
      const plan = rowPlan(FLEET, topN)
      const rows = plan.filter((row) => row.kind === 'lane').map((row) => row.lane)
      expect(rows).toEqual(canonical.slice(0, rows.length))
      expect(laneNames(plan)).toEqual(canonical)
    }
  })
})

describe('rowPlan — composes with the bands it will label', () => {
  it('takes `bandsFor`’s own output as candidates, unmapped', () => {
    const lanes = bandsFor(generateEventLog(42, 200))
    const plan = rowPlan(lanes, 2)
    expect(laneNames(plan)).toEqual(lanes.map((lane) => lane.lane))
    expect(JSON.stringify(rowPlan(lanes, 2))).toBe(JSON.stringify(plan))
  })
})
