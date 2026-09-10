import { describe, expect, it } from 'vitest'
import { dispatchedLine } from '../metrics/spend.js'
import { RAIL_CHECKPOINT, RAIL_DEGRADED_CHECKPOINT, RAIL_EXPERIMENT, RAIL_FAILED_ARMS, RAIL_PARTIAL_EXPERIMENT } from './fixtures.js'
import { checkpointRowFacts, experimentRowFacts, POSITION_UNKNOWN } from './rows.js'

describe('checkpointRowFacts (prd-55 ruling 8)', () => {
  it('places the row by the axis’s own function — the row and the track put one byte at one place', () => {
    expect(checkpointRowFacts(RAIL_CHECKPOINT)).toEqual({
      checkpointId: 'ckpt-1',
      lane: 'feature',
      position: '46 % of session',
      capturedBy: 'operator',
    })
  })

  it('a checkpoint whose session file moved carries its reason where a position would be, never a blank or a guess', () => {
    expect(checkpointRowFacts(RAIL_DEGRADED_CHECKPOINT).position).toBe(POSITION_UNKNOWN)
  })
})

describe('experimentRowFacts (prd-55 ruling 8) — arms · runs · verdict counts', () => {
  it('counts the arms and runs on the record, and every run’s verdict, with none invented', () => {
    expect(experimentRowFacts(RAIL_EXPERIMENT)).toEqual({
      forkId: 'fork-a1d1',
      shape: '2 arms · 6 runs',
      verdicts: '3 passed · 1 failed · 2 unmeasured',
      partial: null,
    })
  })

  it('a run nobody judged and a run whose gate never ran are one bucket — neither has a verdict to count', () => {
    // fork-a1d1's arm 2 holds one unmeasured run and one `not-run`; both land
    // in `unmeasured`, and neither is counted as a failure.
    expect(experimentRowFacts(RAIL_EXPERIMENT).verdicts).toContain('2 unmeasured')
    expect(experimentRowFacts(RAIL_EXPERIMENT).verdicts).toContain('1 failed')
  })

  it('singular where the record is singular — one arm of one run does not say "1 arms"', () => {
    const one = { ...RAIL_EXPERIMENT, arms: [{ ...RAIL_EXPERIMENT.arms[0]!, runs: [RAIL_EXPERIMENT.arms[0]!.runs[0]!] }] }
    expect(experimentRowFacts(one).shape).toBe('1 arm · 1 run')
  })

  it('a partial launch’s row carries *2 of 3 arms* — the count the launch asked for, not the count that came back', () => {
    expect(experimentRowFacts(RAIL_PARTIAL_EXPERIMENT, RAIL_FAILED_ARMS).partial).toBe('2 of 3 arms')
  })

  it('and says nothing at all when every arm the launch asked for dispatched', () => {
    expect(experimentRowFacts(RAIL_PARTIAL_EXPERIMENT, []).partial).toBeNull()
  })

  it("agrees with Metrics' own dispatched line — one denominator for the gap, or the rail and the numbers below it disagree about how many arms were asked for", () => {
    const row = experimentRowFacts(RAIL_PARTIAL_EXPERIMENT, RAIL_FAILED_ARMS)
    expect(dispatchedLine(RAIL_PARTIAL_EXPERIMENT, RAIL_FAILED_ARMS.length)).toContain(row.partial as string)
  })
})
