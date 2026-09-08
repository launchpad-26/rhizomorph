import { canSummariseArm, MIN_COMPLETED_RUNS_TO_SUMMARISE } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { summariseArm } from './summarise.js'
import type { Arm, Run } from './types.js'

function passed(id: string, value: number | null): Run {
  return { id, status: 'complete', verdict: 'pass', value }
}
function failed(id: string, value: number | null, detail?: string): Run {
  return detail === undefined ? { id, status: 'complete', verdict: 'fail', value } : { id, status: 'complete', verdict: 'fail', value, detail }
}
function pending(id: string): Run {
  return { id, status: 'pending' }
}

function arm(runs: Run[]): Arm {
  return { id: 'arm', model: 'opus', brief: 'brief', runs }
}

describe('summariseArm — law 1: every run is kept, always', () => {
  it('keeps every run on the summary regardless of status or verdict', () => {
    const runs = [passed('r1', 1), pending('r2'), failed('r3', 2)]
    const summary = summariseArm(arm(runs))
    expect(summary.runs).toEqual(runs)
    expect(summary.runs).toHaveLength(3)
  })
})

describe("summariseArm — the floor is core's, and this surface agrees with it verdict for verdict (prd53 ruling 2)", () => {
  it('states a summary exactly when core says the completed-run count clears the floor — the same fixture the CLI test walks', () => {
    for (let completed = 0; completed <= MIN_COMPLETED_RUNS_TO_SUMMARISE + 1; completed += 1) {
      const runs = Array.from({ length: completed }, (_unused, index) => passed(`r${index + 1}`, index + 1))
      const summary = summariseArm(arm(runs))
      expect(summary.insufficientReason === null, `completed=${completed}`).toBe(canSummariseArm(completed))
    }
  })

  it('a failed gate is a COMPLETED run — three fails clear the floor, and the spread is over what they cost (ruling 2, amendment 2026-09-08)', () => {
    const summary = summariseArm(arm([failed('r1', 4, 'x'), failed('r2', 9), failed('r3', 6)]))
    expect(summary.completedCount).toBe(3)
    expect(summary.failCount).toBe(3)
    expect(summary.insufficientReason).toBeNull()
    expect(summary.spread).toEqual({ min: 4, max: 9 })
  })

  it('a judged run with nothing booked under this measure counts toward the floor and not toward the spread — nothing is invented', () => {
    const summary = summariseArm(arm([passed('r1', null), passed('r2', null), passed('r3', null)]))
    expect(summary.completedCount).toBe(3)
    expect(summary.insufficientReason).toBeNull()
    expect(summary.values).toEqual([])
    expect(summary.spread).toBeNull()
    expect(summary.unbookedNote).toBe('3 completed — no value is booked under this measure for any of them yet')
  })
})

describe('summariseArm — law 3: below n=3 completed runs, no summary statistic, under any code path', () => {
  it('0 completed runs -> spread null', () => {
    const summary = summariseArm(arm([]))
    expect(summary.spread).toBeNull()
    expect(summary.insufficientReason).not.toBeNull()
  })

  it('2 completed runs, nothing else pending -> spread null (the ruling 3 arm-C shape)', () => {
    const summary = summariseArm(arm([passed('r1', 4), passed('r2', 7)]))
    expect(summary.spread).toBeNull()
    expect(summary.insufficientReason).toBe('n=2 — too few runs to summarise')
  })

  it('2 completed + 2 pending (design n=4, still running) -> spread null, reason mentions the gap', () => {
    const summary = summariseArm(arm([passed('r1', 1), passed('r2', 2), pending('r3'), pending('r4')]))
    expect(summary.spread).toBeNull()
    expect(summary.insufficientReason).toBe('2 of 4 runs completed so far — too few completed to summarise yet')
  })

  it('1 pass + 1 fail is two completed runs — still below the floor, and the fail is not hidden in the reason', () => {
    const summary = summariseArm(arm([passed('r1', 1), failed('r2', 2)]))
    expect(summary.completedCount).toBe(2)
    expect(summary.spread).toBeNull()
    expect(summary.insufficientReason).toBe('n=2 — too few runs to summarise')
  })
})

describe('summariseArm — n>=3 completed runs renders a spread, a range never a point', () => {
  it('computes min/max from the values that exist', () => {
    const summary = summariseArm(arm([passed('r1', 4), passed('r2', 9), passed('r3', 6), passed('r4', 4)]))
    expect(summary.spread).toEqual({ min: 4, max: 9 })
    expect(summary.insufficientReason).toBeNull()
  })

  it('a completed run with no value under this measure narrows the spread’s n, not the floor', () => {
    const summary = summariseArm(arm([passed('r1', 4), passed('r2', null), failed('r3', 6)]))
    expect(summary.completedCount).toBe(3)
    expect(summary.values).toEqual([4, 6])
    expect(summary.spread).toEqual({ min: 4, max: 6 })
    expect(summary.unbookedNote).toBeNull()
  })
})

describe('summariseArm — a partial experiment reports what is missing rather than averaging over the gap', () => {
  it('3 complete + 1 pending: spread from the 3, plus an explicit incomplete note', () => {
    const summary = summariseArm(arm([passed('r1', 1), passed('r2', 5), passed('r3', 3), pending('r4')]))
    expect(summary.spread).toEqual({ min: 1, max: 5 })
    expect(summary.incompleteNote).toBe('3 of 4 runs completed — 1 still pending')
  })

  it('a fully judged arm has no incomplete note at all — a fail is not a gap', () => {
    const summary = summariseArm(arm([passed('r1', 1), passed('r2', 5), failed('r3', 3)]))
    expect(summary.incompleteNote).toBeNull()
  })
})
