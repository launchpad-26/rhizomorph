import { MIN_COMPLETED_RUNS_TO_SUMMARISE } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import type { LabExperiment, LabRun, LabRunOutcome } from '../types.js'
import { armFloor, dispatchedLine, experimentSpend, provenanceRows } from './spend.js'

const provenance = { source: 'measure-route' as const, verifyCommand: 'npm test', measuredAt: 2000 }
function outcome(overrides: Partial<LabRunOutcome> & { verified: LabRunOutcome['verified'] }): LabRunOutcome {
  return { verifiedDetail: null, costUsd: 1, durationMs: 1, commits: 1, provenance, ...overrides }
}
function run(id: string, n: number, measured?: LabRunOutcome): LabRun {
  return { eventId: id, dispatchedAt: 1000, run: n, laneHandle: `lane-${id}`, worktreePath: '/tmp/x', ...(measured === undefined ? {} : { outcome: measured }) }
}
function experiment(arms: LabExperiment['arms']): LabExperiment {
  return { forkId: 'fork-1', parentLane: 'feature', checkpointId: 'ckpt-1', arms }
}

describe('experimentSpend — a total never includes an unmeasured run as zero (prd53 S4)', () => {
  it('sums only the runs that were measured AND have a cost, and says what it left out', () => {
    const spend = experimentSpend(
      experiment([
        {
          arm: 1,
          treatment: { model: 'opus', promptDigest: null },
          runs: [
            run('a', 1, outcome({ verified: 'pass', costUsd: 2.5 })),
            run('b', 2, outcome({ verified: 'fail', costUsd: 1.5 })),
            run('c', 3, outcome({ verified: 'pass', costUsd: null })),
            run('d', 4),
            run('e', 5, outcome({ verified: 'not-run', costUsd: null })),
          ],
        },
      ]),
    )
    expect(spend.bookedUsd).toBe(4)
    expect(spend.bookedRuns).toBe(2)
    expect(spend.unbookedRuns).toBe(1)
    expect(spend.unmeasuredRuns).toBe(2)
    expect(spend.basis).toBe("booked from each arm lane's own recorded spend, over 2 measured runs")
    expect(spend.exclusionNote).toBe('2 runs not measured and 1 measured run with no cost booked — excluded from the total, never counted as zero')
  })

  it('an experiment with nothing booked has a null total, not $0', () => {
    const spend = experimentSpend(experiment([{ arm: 1, treatment: { model: null, promptDigest: null }, runs: [run('a', 1)] }]))
    expect(spend.bookedUsd).toBeNull()
    expect(spend.exclusionNote).toMatch(/1 run not measured/)
  })
})

describe("armFloor — core's floor, read per arm", () => {
  it('refuses below the floor with the counts, and allows a summary at it', () => {
    const runs = (measured: number) => Array.from({ length: 4 }, (_unused, i) => run(`r${i}`, i + 1, i < measured ? outcome({ verified: 'pass' }) : undefined))
    const short = armFloor({ arm: 1, treatment: { model: null, promptDigest: null }, runs: runs(2) })
    expect(short.canSummarise).toBe(false)
    expect(short.refusal).toBe(`refuses to summarise — 2 of 4 measured, needs ${MIN_COMPLETED_RUNS_TO_SUMMARISE}`)
    const enough = armFloor({ arm: 1, treatment: { model: null, promptDigest: null }, runs: runs(3) })
    expect(enough.canSummarise).toBe(true)
    expect(enough.refusal).toBeNull()
  })
})

describe('provenanceRows — every run, with who judged it, and no number where no verdict exists', () => {
  it('a measured pass carries its cost and provenance; an unmeasured run and a not-run verdict carry null cost', () => {
    const rows = provenanceRows(
      experiment([
        {
          arm: 1,
          treatment: { model: 'opus', promptDigest: null },
          runs: [run('a', 1, outcome({ verified: 'pass', costUsd: 3 })), run('b', 2), run('c', 3, outcome({ verified: 'not-run', costUsd: 9 }))],
        },
      ]),
    )
    expect(rows.map((row) => [row.run, row.verified, row.costUsd])).toEqual([
      [1, 'pass', 3],
      [2, 'not measured', null],
      [3, 'not-run', null],
    ])
    expect(rows[0]).toMatchObject({ source: 'measure-route', verifyCommand: 'npm test', measuredAt: 2000 })
    expect(rows[1]).toMatchObject({ source: null, verifyCommand: null, measuredAt: null })
  })
})

describe('dispatchedLine — the partial-launch sentence (ruling 7)', () => {
  it('names how many of the asked-for arms dispatched, and whose spend the total is', () => {
    const two = experiment([
      { arm: 1, treatment: { model: null, promptDigest: null }, runs: [] },
      { arm: 2, treatment: { model: null, promptDigest: null }, runs: [] },
    ])
    expect(dispatchedLine(two, 1)).toBe('2 of 3 arms dispatched — the spend is the spend of the 2')
    expect(dispatchedLine(two, 0)).toBeNull()
  })
})
