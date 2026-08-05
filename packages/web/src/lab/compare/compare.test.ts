import { describe, expect, it } from 'vitest'
import { compareArms } from './compare.js'
import type { Arm, Run } from './types.js'

function complete(id: string, value: number): Run {
  return { id, status: 'complete', value }
}

function arm(id: string, model: string, brief: string, runs: Run[]): Arm {
  return { id, model, brief, runs }
}

describe('compareArms', () => {
  it('preserves input order — a "no winner" surface must never sort by value', () => {
    const armA = arm('a', 'opus', 'brief-x', [complete('r1', 9), complete('r2', 9), complete('r3', 9)])
    const armC = arm('c', 'sonnet', 'brief-x', [complete('r1', 1), complete('r2', 1), complete('r3', 1)])

    const comparison = compareArms({ arms: [armC, armA] })

    expect(comparison.arms.map((a) => a.armId)).toEqual(['c', 'a'])
  })

  it('the ruling 3 worked example: n=4, n=4, n=2', () => {
    const armA = arm('opus', 'opus', 'brief-x', [
      complete('r1', 4),
      complete('r2', 9),
      complete('r3', 6),
      complete('r4', 4),
    ])
    const armC = arm('haiku', 'haiku', 'brief-x', [complete('r1', 3), complete('r2', 5)])

    const comparison = compareArms({ arms: [armA, armC] })

    expect(comparison.arms[0]?.spread).not.toBeNull()
    expect(comparison.arms[1]?.spread).toBeNull()
    expect(comparison.arms[1]?.insufficientReason).toBe('n=2 — too few runs to summarise')
    // arms differ only in model here -> comparable, spread shown for the arm that has enough runs
    expect(comparison.claim).toEqual({ kind: 'comparable', dimension: 'model' })
  })

  it('confounded arms yield no comparative claim, even though both arms individually have full summaries', () => {
    const armA = arm('a', 'opus', 'brief-x', [complete('r1', 1), complete('r2', 2), complete('r3', 3)])
    const armB = arm('b', 'sonnet', 'brief-y', [complete('r1', 4), complete('r2', 5), complete('r3', 6)])

    const comparison = compareArms({ arms: [armA, armB] })

    expect(comparison.arms[0]?.spread).not.toBeNull()
    expect(comparison.arms[1]?.spread).not.toBeNull()
    expect(comparison.claim.kind).toBe('confounded')
    expect('dimension' in comparison.claim).toBe(false)
  })
})
