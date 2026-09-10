import { describe, expect, it } from 'vitest'
import { experimentHasOutcome, experimentRowCounts, NOT_MEASURED_VOICE, runOutcomeVoice, toBranchingArms } from './adapters.js'
import { layoutBranching } from './branching/index.js'
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
    expect(toBranchingArms(experiment([arm({ arm: 1 })]))).toEqual([{ id: 'arm-1', state: 'running', runs: 1 }])
  })

  it('an arm whose every judged run is "not-run" reads as dead — the gate never ran, read as abandoned', () => {
    const exp = experiment([arm({ arm: 1, runs: [run('a', 1, outcome({ verified: 'not-run', verifiedDetail: 'checkpoint restore failed', costUsd: null, durationMs: null, commits: null }))] })])
    expect(toBranchingArms(exp)).toEqual([{ id: 'arm-1', state: 'dead', runs: 1 }])
  })

  it('a pass or fail on any run reads as finished — completion, not death — even beside an unmeasured sibling run (prd53 ruling 3)', () => {
    const exp = experiment([
      arm({ arm: 1, runs: [run('a', 1, outcome({ verified: 'pass' })), run('b', 2)] }),
      arm({ arm: 2, runs: [run('c', 1, outcome({ verified: 'fail', verifiedDetail: 'tests failed' }))] }),
    ])
    expect(toBranchingArms(exp)).toEqual([
      { id: 'arm-1', state: 'finished', runs: 2 },
      { id: 'arm-2', state: 'finished', runs: 1 },
    ])
  })

  it('keeps arm order — the layout must never re-sort what it is handed', () => {
    const exp = experiment([arm({ arm: 3 }), arm({ arm: 1 }), arm({ arm: 2 })])
    expect(toBranchingArms(exp).map((a) => a.id)).toEqual(['arm-3', 'arm-1', 'arm-2'])
  })

  it('carries each arm its RUN COUNT, from the record and nowhere else — so the header glyph draws runs, not arms (prd-55 ruling 11)', () => {
    const exp = experiment([
      arm({ arm: 1, runs: [run('a', 1), run('b', 2), run('c', 3)] }),
      arm({ arm: 2, runs: [] }),
    ])
    expect(toBranchingArms(exp).map((a) => a.runs)).toEqual([3, 0])
    // The count is the record's own, never the arm count and never a floor
    // applied here: an arm that has dispatched nothing says zero, and
    // `branching/geometry.ts` is the one that decides an arm it was told
    // about is an arm it draws.
    expect(layoutBranching({ width: 480, height: 120, arms: toBranchingArms(exp) }).arms.map((strand) => strand.id)).toEqual([
      'arm-1-run-1',
      'arm-1-run-2',
      'arm-1-run-3',
      'arm-2',
    ])
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

describe('experimentRowCounts (prd-55 ruling 8 — what a rail row counts)', () => {
  it('counts the arms and runs on the record, with every run in exactly one verdict bucket', () => {
    const exp = experiment([
      arm({ arm: 1, runs: [run('p1', 1, outcome({ verified: 'pass' })), run('p2', 2, outcome({ verified: 'pass' }))] }),
      arm({ arm: 2, runs: [run('f1', 1, outcome({ verified: 'fail', verifiedDetail: '2 tests failed' })), run('u1', 2)] }),
    ])
    const counts = experimentRowCounts(exp)
    expect(counts).toEqual({ arms: 2, runs: 4, passed: 2, failed: 1, unmeasured: 1 })
    expect(counts.passed + counts.failed + counts.unmeasured, 'every run is counted once and only once').toBe(counts.runs)
  })

  it('a run whose gate never ran counts as unmeasured, never as a failure — nobody judged it', () => {
    const exp = experiment([arm({ arm: 1, runs: [run('n', 1, outcome({ verified: 'not-run', verifiedDetail: 'npm: not found' }))] })])
    expect(experimentRowCounts(exp)).toEqual({ arms: 1, runs: 1, passed: 0, failed: 0, unmeasured: 1 })
  })

  it('an arm that has dispatched nothing is still an arm, and contributes no run', () => {
    expect(experimentRowCounts(experiment([arm({ arm: 1, runs: [] })]))).toEqual({ arms: 1, runs: 0, passed: 0, failed: 0, unmeasured: 0 })
  })

  it('the counts are the comparison’s own — an arm’s completed count is passed + failed, the floor’s denominator', () => {
    const exp = experiment([
      arm({ arm: 1, runs: [run('p', 1, outcome({ verified: 'pass' })), run('f', 2, outcome({ verified: 'fail' })), run('n', 3, outcome({ verified: 'not-run' }))] }),
    ])
    const counts = experimentRowCounts(exp)
    expect(counts.passed + counts.failed, 'the same denominator Compare and Metrics count').toBe(2)
  })
})
