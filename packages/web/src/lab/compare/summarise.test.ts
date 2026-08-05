import { describe, expect, it } from 'vitest'
import { summariseArm } from './summarise.js'
import type { Arm, Run } from './types.js'

function complete(id: string, value: number): Run {
  return { id, status: 'complete', value }
}
function pending(id: string): Run {
  return { id, status: 'pending' }
}
function failed(id: string, error?: string): Run {
  return error === undefined ? { id, status: 'failed' } : { id, status: 'failed', error }
}

function arm(runs: Run[]): Arm {
  return { id: 'arm', model: 'opus', brief: 'brief', runs }
}

describe('summariseArm — law 1: every run is kept, always', () => {
  it('keeps every run on the summary regardless of status', () => {
    const runs = [complete('r1', 1), pending('r2'), failed('r3')]
    const summary = summariseArm(arm(runs))
    expect(summary.runs).toEqual(runs)
    expect(summary.runs).toHaveLength(3)
  })
})

describe('summariseArm — law 3: below n=3 completed runs, no summary statistic, under any code path', () => {
  it('0 completed runs -> spread null', () => {
    const summary = summariseArm(arm([]))
    expect(summary.spread).toBeNull()
    expect(summary.insufficientReason).not.toBeNull()
  })

  it('2 completed runs, nothing else pending or failed -> spread null (the ruling 3 arm-C shape)', () => {
    const summary = summariseArm(arm([complete('r1', 4), complete('r2', 7)]))
    expect(summary.spread).toBeNull()
    expect(summary.insufficientReason).toBe('n=2 — too few runs to summarise')
  })

  it('2 completed + 2 pending (design n=4, still running) -> spread null, reason mentions the gap', () => {
    const summary = summariseArm(arm([complete('r1', 1), complete('r2', 2), pending('r3'), pending('r4')]))
    expect(summary.spread).toBeNull()
    expect(summary.insufficientReason).toBe('2 of 4 runs completed so far — too few completed to summarise yet')
  })

  it('2 completed + 1 failed -> spread null, reason notes the failure without hiding it', () => {
    const summary = summariseArm(arm([complete('r1', 1), complete('r2', 2), failed('r3')]))
    expect(summary.spread).toBeNull()
    expect(summary.insufficientReason).toBe('n=2 — too few runs to summarise (1 failed)')
  })

  it('a 4-run arm with only 2 complete and 2 failed (no pending) is still insufficient, never averaged', () => {
    const summary = summariseArm(arm([complete('r1', 1), complete('r2', 2), failed('r3'), failed('r4')]))
    expect(summary.spread).toBeNull()
    expect(summary.completedValues).toEqual([1, 2])
  })
})

describe('summariseArm — n>=3 completed runs renders a spread, a range never a point', () => {
  it('computes min/max from completed runs only', () => {
    const summary = summariseArm(arm([complete('r1', 4), complete('r2', 9), complete('r3', 6), complete('r4', 4)]))
    expect(summary.spread).toEqual({ min: 4, max: 9 })
    expect(summary.insufficientReason).toBeNull()
  })
})

describe('summariseArm — a partial experiment reports what is missing rather than averaging over the gap', () => {
  it('3 complete + 1 pending: spread from the 3, plus an explicit incomplete note', () => {
    const summary = summariseArm(arm([complete('r1', 1), complete('r2', 5), complete('r3', 3), pending('r4')]))
    expect(summary.spread).toEqual({ min: 1, max: 5 })
    expect(summary.incompleteNote).toBe('3 of 4 runs completed — 1 still pending')
  })

  it('3 complete + 1 failed: spread shown, failure stated plainly', () => {
    const summary = summariseArm(arm([complete('r1', 1), complete('r2', 5), complete('r3', 3), failed('r4')]))
    expect(summary.spread).toEqual({ min: 1, max: 5 })
    expect(summary.incompleteNote).toBe('3 of 4 runs completed — 1 failed')
  })

  it('a fully complete arm has no incomplete note at all', () => {
    const summary = summariseArm(arm([complete('r1', 1), complete('r2', 5), complete('r3', 3)]))
    expect(summary.incompleteNote).toBeNull()
  })
})
