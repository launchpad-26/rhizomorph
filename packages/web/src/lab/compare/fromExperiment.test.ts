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

  it('cost, duration and commits read their own field; a passed run with nothing booked under a measure is pending with that said', () => {
    const passed = run('a', outcome({ verified: 'pass', costUsd: 1.25, durationMs: 900, commits: 2 }))
    expect(runForMeasure(passed, 'cost')).toEqual({ id: 'a', status: 'complete', value: 1.25 })
    expect(runForMeasure(passed, 'duration')).toEqual({ id: 'a', status: 'complete', value: 900 })
    expect(runForMeasure(passed, 'commits')).toEqual({ id: 'a', status: 'complete', value: 2 })
    const unbooked = run('b', outcome({ verified: 'pass', costUsd: null }))
    const read = runForMeasure(unbooked, 'cost')
    expect(read.status).toBe('pending')
    if (read.status === 'pending') expect(read.note).toMatch(/verified, but no cost is booked/)
  })

  it('a failed verdict is a failed run under every numeric measure, carrying its detail; under "verified" a pass is 1 and a fail is failed', () => {
    const failed = run('a', outcome({ verified: 'fail', verifiedDetail: '2 tests failed' }))
    expect(runForMeasure(failed, 'cost')).toEqual({ id: 'a', status: 'failed', error: '2 tests failed' })
    expect(runForMeasure(failed, 'verified')).toEqual({ id: 'a', status: 'failed', error: '2 tests failed' })
    expect(runForMeasure(run('b', outcome({ verified: 'pass' })), 'verified')).toEqual({ id: 'b', status: 'complete', value: 1 })
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
})

describe('median — an observed value, never an average of two', () => {
  it('is the middle of an odd count and the lower middle of an even one; null for nothing', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2)
    expect(median([])).toBeNull()
  })
})
