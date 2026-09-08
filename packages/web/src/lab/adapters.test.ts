import { describe, expect, it } from 'vitest'
import { experimentHasOutcome, NOT_MEASURED_VOICE, runOutcomeVoice, toBranchingArms, toComparisonInput } from './adapters.js'
import type { LabArm, LabExperiment, LabRun, LabRunOutcome } from './types.js'

const provenance = { source: 'measure-route' as const, verifyCommand: 'npm test', measuredAt: 2000 }

function outcome(overrides: Partial<LabRunOutcome> & { verified: LabRunOutcome['verified'] }): LabRunOutcome {
  return { verifiedDetail: null, costUsd: 1, durationMs: 1, commits: 1, provenance, ...overrides }
}

function run(id: string, runNumber: number, measured?: LabRunOutcome): LabRun {
  return {
    eventId: id,
    dispatchedAt: 1000,
    run: runNumber,
    laneHandle: `lane-${id}`,
    worktreePath: '/tmp/x',
    ...(measured === undefined ? {} : { outcome: measured }),
  }
}

function arm(overrides: Partial<LabArm> & { arm: number }): LabArm {
  return {
    treatment: { model: null, promptDigest: null },
    runs: [run(`evt-${overrides.arm}`, 1)],
    ...overrides,
  }
}

function experiment(arms: LabArm[]): LabExperiment {
  return { forkId: 'fork-1', parentLane: 'feature', checkpointId: 'ckpt-1', arms }
}

describe('toBranchingArms', () => {
  it('an arm none of whose runs has an outcome reads as running — nothing has told the console otherwise', () => {
    expect(toBranchingArms(experiment([arm({ arm: 1 })]))).toEqual([{ id: 'arm-1', state: 'running' }])
  })

  it('an arm whose every judged run is "not-run" reads as dead — the gate never ran, read as abandoned', () => {
    const exp = experiment([arm({ arm: 1, runs: [run('a', 1, outcome({ verified: 'not-run', verifiedDetail: 'checkpoint restore failed', costUsd: null, durationMs: null, commits: null }))] })])
    expect(toBranchingArms(exp)).toEqual([{ id: 'arm-1', state: 'dead' }])
  })

  it('a pass or fail on any run reads as finished — completion, not death — even beside an unmeasured sibling run (prd53 ruling 3)', () => {
    const exp = experiment([
      arm({ arm: 1, runs: [run('a', 1, outcome({ verified: 'pass' })), run('b', 2)] }),
      arm({ arm: 2, runs: [run('c', 1, outcome({ verified: 'fail', verifiedDetail: 'tests failed' }))] }),
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
  it('false when every run of every arm is still unmeasured', () => {
    expect(experimentHasOutcome(experiment([arm({ arm: 1 }), arm({ arm: 2 })]))).toBe(false)
  })

  it('true once even one run has been measured', () => {
    const exp = experiment([arm({ arm: 1 }), arm({ arm: 2, runs: [run('m', 1, outcome({ verified: 'pass', costUsd: 2 }))] })])
    expect(experimentHasOutcome(exp)).toBe(true)
  })
})

describe('runOutcomeVoice (prd53 ruling 3 — not-run is legal, and voiced as not measured)', () => {
  it('an unmeasured run and a not-run verdict speak the same sentence — no outcome is invented in either case', () => {
    expect(runOutcomeVoice(run('a', 1))).toBe(NOT_MEASURED_VOICE)
    expect(runOutcomeVoice(run('b', 1, outcome({ verified: 'not-run', verifiedDetail: 'npm: not found' })))).toBe(NOT_MEASURED_VOICE)
    expect(NOT_MEASURED_VOICE).toBe('not measured yet — no outcome is invented in its place')
  })

  it('a verdict names the gate that gave it and the hand that ran it — provenance, not a bare tick', () => {
    expect(runOutcomeVoice(run('a', 1, outcome({ verified: 'pass' })))).toBe('passed npm test (measure-route)')
    expect(runOutcomeVoice(run('b', 1, outcome({ verified: 'fail', verifiedDetail: '1 test failed' })))).toBe(
      'failed npm test (measure-route): 1 test failed',
    )
  })
})

describe('toComparisonInput', () => {
  it("an unmeasured run reads as pending — no fabricated value", () => {
    const input = toComparisonInput(experiment([arm({ arm: 1, treatment: { model: 'opus', promptDigest: null } })]))
    expect(input.arms).toEqual([{ id: 'arm-1', model: 'opus', brief: 'no-brief', runs: [{ id: 'evt-1', status: 'pending' }] }])
  })

  it('a promptDigest becomes its own first-8-characters label — the brief text itself never reaches this console', () => {
    const digest = 'a'.repeat(64)
    const input = toComparisonInput(experiment([arm({ arm: 1, treatment: { model: null, promptDigest: digest } })]))
    expect(input.arms[0]?.brief).toBe('aaaaaaaa')
    expect(input.arms[0]?.model).toBe('default')
  })

  it('each run carries ITS OWN verdict — two runs of one arm can differ, which the old arm-level outcome could not express (prd53 rulings 1 and 3)', () => {
    const exp = experiment([
      arm({
        arm: 1,
        runs: [
          run('a', 1, outcome({ verified: 'pass', costUsd: 4.5 })),
          run('b', 2, outcome({ verified: 'fail', verifiedDetail: 'gate exited 1' })),
          run('c', 3),
        ],
      }),
    ])
    expect(toComparisonInput(exp).arms[0]?.runs).toEqual([
      { id: 'a', status: 'complete', value: 4.5 },
      { id: 'b', status: 'failed', error: 'gate exited 1' },
      { id: 'c', status: 'pending' },
    ])
  })

  it('a verified pass with no cost booked yet reads as pending, never a fabricated $0', () => {
    const exp = experiment([arm({ arm: 1, runs: [run('a', 1, outcome({ verified: 'pass', costUsd: null }))] })])
    expect(toComparisonInput(exp).arms[0]?.runs).toEqual([{ id: 'a', status: 'pending' }])
  })

  it('a "not-run" verdict reads as pending too — the gate did not run, so there is no result to report as failed', () => {
    const exp = experiment([arm({ arm: 1, runs: [run('a', 1, outcome({ verified: 'not-run', verifiedDetail: 'restore failed', costUsd: null }))] })])
    expect(toComparisonInput(exp).arms[0]?.runs).toEqual([{ id: 'a', status: 'pending' }])
  })

  it('a failed run with no detail carries no error field, rather than inventing one', () => {
    const exp = experiment([arm({ arm: 1, runs: [run('a', 1, outcome({ verified: 'fail' }))] })])
    expect(toComparisonInput(exp).arms[0]?.runs).toEqual([{ id: 'a', status: 'failed' }])
  })
})
