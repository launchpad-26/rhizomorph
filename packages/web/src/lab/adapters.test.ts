import { describe, expect, it } from 'vitest'
import { experimentHasOutcome, toBranchingArms, toComparisonInput } from './adapters.js'
import type { LabArm, LabExperiment } from './types.js'

function arm(overrides: Partial<LabArm> & { arm: number }): LabArm {
  return {
    treatment: { model: null, promptDigest: null },
    runs: [{ eventId: `evt-${overrides.arm}`, dispatchedAt: 1000, laneHandle: `lane-${overrides.arm}`, worktreePath: '/tmp/x' }],
    ...overrides,
  }
}

function experiment(arms: LabArm[]): LabExperiment {
  return { forkId: 'fork-1', parentLane: 'feature', checkpointId: 'ckpt-1', arms }
}

describe('toBranchingArms', () => {
  it('an arm with no outcome yet reads as running — nothing has told the console otherwise', () => {
    const arms = toBranchingArms(experiment([arm({ arm: 1 })]))
    expect(arms).toEqual([{ id: 'arm-1', state: 'running' }])
  })

  it('a "not-run" verified outcome reads as dead — the gate never ran, read as abandoned', () => {
    const exp = experiment([
      arm({ arm: 1, outcome: { verified: 'not-run', verifiedDetail: 'checkpoint restore failed', costUsd: null, durationMs: null, commits: null } }),
    ])
    expect(toBranchingArms(exp)).toEqual([{ id: 'arm-1', state: 'dead' }])
  })

  it('a pass or fail verified outcome both read as finished — completion, not death', () => {
    const exp = experiment([
      arm({ arm: 1, outcome: { verified: 'pass', verifiedDetail: null, costUsd: 1, durationMs: 1, commits: 1 } }),
      arm({ arm: 2, outcome: { verified: 'fail', verifiedDetail: 'tests failed', costUsd: 1, durationMs: 1, commits: 1 } }),
    ])
    expect(toBranchingArms(exp)).toEqual([
      { id: 'arm-1', state: 'finished' },
      { id: 'arm-2', state: 'finished' },
    ])
  })

  it('keeps arm order — the layout must never re-sort what it is handed', () => {
    const exp = experiment([arm({ arm: 3 }), arm({ arm: 1 }), arm({ arm: 2 })])
    expect(toBranchingArms(exp).map((a) => a.id)).toEqual(['arm-3', 'arm-1', 'arm-2'])
  })
})

describe('experimentHasOutcome', () => {
  it('false when every arm is still unmeasured', () => {
    expect(experimentHasOutcome(experiment([arm({ arm: 1 }), arm({ arm: 2 })]))).toBe(false)
  })

  it('true once even one arm has been measured', () => {
    const exp = experiment([
      arm({ arm: 1 }),
      arm({ arm: 2, outcome: { verified: 'pass', verifiedDetail: null, costUsd: 2, durationMs: 500, commits: 3 } }),
    ])
    expect(experimentHasOutcome(exp)).toBe(true)
  })
})

describe('toComparisonInput', () => {
  it('an unmeasured arm\'s run reads as pending — no fabricated value', () => {
    const input = toComparisonInput(experiment([arm({ arm: 1, treatment: { model: 'opus', promptDigest: null } })]))
    expect(input.arms).toEqual([{ id: 'arm-1', model: 'opus', brief: 'no-brief', runs: [{ id: 'evt-1', status: 'pending' }] }])
  })

  it('a promptDigest becomes its own first-8-characters label — the brief text itself never reaches this console', () => {
    const digest = 'a'.repeat(64)
    const input = toComparisonInput(experiment([arm({ arm: 1, treatment: { model: null, promptDigest: digest } })]))
    expect(input.arms[0]?.brief).toBe('aaaaaaaa')
    expect(input.arms[0]?.model).toBe('default')
  })

  it('a verified pass with a booked cost reads as a complete run, valued at that cost', () => {
    const exp = experiment([
      arm({ arm: 1, outcome: { verified: 'pass', verifiedDetail: null, costUsd: 4.5, durationMs: 1000, commits: 2 } }),
    ])
    expect(toComparisonInput(exp).arms[0]?.runs).toEqual([{ id: 'evt-1', status: 'complete', value: 4.5 }])
  })

  it('a verified pass with no cost booked yet reads as pending, never a fabricated $0', () => {
    const exp = experiment([
      arm({ arm: 1, outcome: { verified: 'pass', verifiedDetail: null, costUsd: null, durationMs: 1000, commits: 2 } }),
    ])
    expect(toComparisonInput(exp).arms[0]?.runs).toEqual([{ id: 'evt-1', status: 'pending' }])
  })

  it('a verified fail reads as a failed run, carrying its detail as the error', () => {
    const exp = experiment([
      arm({ arm: 1, outcome: { verified: 'fail', verifiedDetail: 'gate exited 1', costUsd: 1, durationMs: 1, commits: 1 } }),
    ])
    expect(toComparisonInput(exp).arms[0]?.runs).toEqual([{ id: 'evt-1', status: 'failed', error: 'gate exited 1' }])
  })

  it('a "not-run" verified outcome also reads as a failed run — there is no honest run value to show', () => {
    const exp = experiment([
      arm({ arm: 1, outcome: { verified: 'not-run', verifiedDetail: 'restore failed', costUsd: null, durationMs: null, commits: null } }),
    ])
    expect(toComparisonInput(exp).arms[0]?.runs).toEqual([{ id: 'evt-1', status: 'failed', error: 'restore failed' }])
  })

  it('a failed run with no detail carries no error field, rather than inventing one', () => {
    const exp = experiment([
      arm({ arm: 1, outcome: { verified: 'fail', verifiedDetail: null, costUsd: 1, durationMs: 1, commits: 1 } }),
    ])
    expect(toComparisonInput(exp).arms[0]?.runs).toEqual([{ id: 'evt-1', status: 'failed' }])
  })
})
