import { describe, expect, it } from 'vitest'
import type { LabExperiment, LabRun, LabRunOutcome } from '../types.js'
import { experimentToComparisonInput, MEASURES, median, runForMeasure } from './fromExperiment.js'

const provenance = { source: 'measure-route' as const, verifyCommand: 'npm test', measuredAt: 2000 }

function outcome(overrides: Partial<LabRunOutcome> & { verified: LabRunOutcome['verified'] }): LabRunOutcome {
  return { verifiedDetail: null, costUsd: 2.5, durationMs: 4000, commits: 3, provenance, ...overrides }
}

function run(id: string, measured?: LabRunOutcome): LabRun {
  return { eventId: id, dispatchedAt: 1000, run: 1, laneHandle: `lane-${id}`, worktreePath: '/tmp/x', ...(measured === undefined ? {} : { outcome: measured }) }
}

describe('runForMeasure — one run, read for one measure (prd53 S2)', () => {
  it('an unmeasured run is pending under EVERY measure, and says why — no number is invented in its place', () => {
    for (const measure of MEASURES) {
      const read = runForMeasure(run('a'), measure)
      expect(read.status).toBe('pending')
      if (read.status === 'pending') expect(read.note).toBe('not measured yet — no outcome is invented in its place')
    }
  })

  it('a not-run verdict reads the same as unmeasured — the gate did not judge the run', () => {
    const read = runForMeasure(run('a', outcome({ verified: 'not-run', verifiedDetail: 'npm: not found' })), 'cost')
    expect(read).toEqual({ id: 'a', status: 'pending', note: 'not measured yet — no outcome is invented in its place' })
  })

  it('cost, duration and commits read their own field; a judged run with nothing booked under a measure is complete with a null value, and says so', () => {
    const passed = run('a', outcome({ verified: 'pass', costUsd: 1.25, durationMs: 900, commits: 2 }))
    expect(runForMeasure(passed, 'cost')).toEqual({ id: 'a', status: 'complete', verdict: 'pass', value: 1.25, cost: 1.25, duration: 900, commits: 2 })
    expect(runForMeasure(passed, 'duration')).toEqual({ id: 'a', status: 'complete', verdict: 'pass', value: 900, cost: 1.25, duration: 900, commits: 2 })
    expect(runForMeasure(passed, 'commits')).toEqual({ id: 'a', status: 'complete', verdict: 'pass', value: 2, cost: 1.25, duration: 900, commits: 2 })
    const unbooked = runForMeasure(run('b', outcome({ verified: 'pass', costUsd: null })), 'cost')
    expect(unbooked).toEqual({
      id: 'b',
      status: 'complete',
      verdict: 'pass',
      value: null,
      note: 'judged, but no cost is booked to its lane yet',
      cost: null,
      duration: 4000,
      commits: 3,
    })
  })

  it('a failed gate is a COMPLETED run under every measure — it counts toward the floor, carries its cost, and keeps the gate’s words (ruling 2, amendment 2026-09-08)', () => {
    const failed = run('a', outcome({ verified: 'fail', verifiedDetail: '2 tests failed', costUsd: 3 }))
    expect(runForMeasure(failed, 'cost')).toEqual({ id: 'a', status: 'complete', verdict: 'fail', value: 3, detail: '2 tests failed', cost: 3, duration: 4000, commits: 3 })
    expect(runForMeasure(failed, 'verified')).toEqual({ id: 'a', status: 'complete', verdict: 'fail', value: 0, detail: '2 tests failed', cost: 3, duration: 4000, commits: 3 })
    expect(runForMeasure(run('b', outcome({ verified: 'pass' })), 'verified')).toEqual({ id: 'b', status: 'complete', verdict: 'pass', value: 1, cost: 2.5, duration: 4000, commits: 3 })
    expect(runForMeasure(run('c', outcome({ verified: 'fail' })), 'commits')).toEqual({ id: 'c', status: 'complete', verdict: 'fail', value: 3, cost: 2.5, duration: 4000, commits: 3 })
  })

  /**
   * The whole point of carrying `cost`/`duration`/`commits` on every complete
   * run (prd14 ruling 6): a save downstream of `runForMeasure` never has to
   * re-read the experiment for the two measures the caller did not ask for.
   */
  it('carries all three raw facts on a complete run, whichever measure was asked for', () => {
    const passed = run('a', outcome({ verified: 'pass', costUsd: 1.25, durationMs: 900, commits: 2 }))
    for (const measure of MEASURES) {
      const read = runForMeasure(passed, measure)
      expect(read.status).toBe('complete')
      if (read.status === 'complete') expect({ cost: read.cost, duration: read.duration, commits: read.commits }).toEqual({ cost: 1.25, duration: 900, commits: 2 })
    }
  })

  it('whether a run is complete never depends on the measure — the same run answers the same under all four', () => {
    for (const measured of [run('u'), run('n', outcome({ verified: 'not-run' })), run('p', outcome({ verified: 'pass', costUsd: null })), run('f', outcome({ verified: 'fail' }))]) {
      const answers = new Set(MEASURES.map((measure) => runForMeasure(measured, measure).status))
      expect(answers.size, measured.eventId).toBe(1)
    }
  })
})

describe('experimentToComparisonInput', () => {
  const experiment: LabExperiment = {
    forkId: 'fork-1',
    parentLane: 'feature',
    checkpointId: 'ckpt-1',
    arms: [
      { arm: 1, treatment: { model: 'opus', promptDigest: null }, runs: [run('a', outcome({ verified: 'pass', costUsd: 9 }))] },
      { arm: 2, treatment: { model: null, promptDigest: 'b'.repeat(64) }, runs: [run('b', outcome({ verified: 'pass', costUsd: 1 }))] },
      { arm: 3, treatment: { model: 'sonnet', promptDigest: null }, runs: [run('c', outcome({ verified: 'pass', costUsd: 5 }))] },
    ],
  }

  it('keeps ARM ORDER regardless of value — the mutation that sorts by cost goes red here', () => {
    const input = experimentToComparisonInput(experiment, 'cost')
    expect(input.arms.map((arm) => arm.id)).toEqual(['arm-1', 'arm-2', 'arm-3'])
    expect(input.arms.map((arm) => (arm.runs[0]?.status === 'complete' ? arm.runs[0].value : null))).toEqual([9, 1, 5])
  })

  it('reads the treatment honestly — a null model is "default", a brief is its first eight digest characters', () => {
    const input = experimentToComparisonInput(experiment, 'cost')
    expect(input.arms[1]).toMatchObject({ model: 'default', brief: 'bbbbbbbb' })
    expect(input.arms[0]).toMatchObject({ model: 'opus', brief: 'no-brief' })
  })

  it('carries the measure it was read for, and the most recently judged run\'s provenance, at the top level (prd14 ruling 6)', () => {
    const input = experimentToComparisonInput(experiment, 'duration')
    expect(input.measure).toBe('duration')
    expect(input.provenance).toEqual(provenance)
  })

  it('provenance is null, never invented, when nothing has been judged yet', () => {
    const unjudged: LabExperiment = { forkId: 'f', parentLane: 'x', checkpointId: 'c', arms: [{ arm: 1, treatment: { model: 'opus', promptDigest: null }, runs: [run('a')] }] }
    expect(experimentToComparisonInput(unjudged, 'cost').provenance).toBeNull()
  })

  it("picks the LATEST-measured run's provenance when runs disagree, not the first or the last in arm order", () => {
    const early = { ...provenance, measuredAt: 1000 }
    const late = { ...provenance, measuredAt: 5000, verifyCommand: 'npm run gate' }
    const mixed: LabExperiment = {
      forkId: 'f',
      parentLane: 'x',
      checkpointId: 'c',
      arms: [
        { arm: 1, treatment: { model: 'opus', promptDigest: null }, runs: [run('a', outcome({ verified: 'pass', provenance: early }))] },
        { arm: 2, treatment: { model: 'sonnet', promptDigest: null }, runs: [run('b', outcome({ verified: 'pass', provenance: late }))] },
      ],
    }
    expect(experimentToComparisonInput(mixed, 'cost').provenance).toEqual(late)
  })
})

describe('median — an observed value, never an average of two', () => {
  it('is the middle of an odd count and the lower middle of an even one; null for nothing', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2)
    expect(median([])).toBeNull()
  })
})
