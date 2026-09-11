import { describe, expect, it } from 'vitest'
import { ComparisonArtifactError, parseComparisonArtifact, serialiseComparison, serialiseComparisonV2 } from './artifact.js'
import type { ComparisonInput } from './types.js'

const INPUT: ComparisonInput = {
  arms: [
    {
      id: 'a',
      model: 'opus',
      brief: 'brief-x',
      runs: [
        { id: 'r1', status: 'complete', verdict: 'pass', value: 4 },
        { id: 'r2', status: 'pending', note: 'not measured yet — no outcome is invented in its place' },
        { id: 'r3', status: 'complete', verdict: 'fail', value: 2, detail: 'timed out' },
        { id: 'r4', status: 'complete', verdict: 'pass', value: null, note: 'judged, but no cost is booked to its lane yet' },
        { id: 'r5', status: 'pending' },
      ],
    },
  ],
}

describe('serialiseComparison / parseComparisonArtifact', () => {
  it('round-trips a comparison exactly — a finished comparison reopens as itself', () => {
    const raw = serialiseComparison(INPUT, '2026-08-06T00:00:00.000Z')
    const artifact = parseComparisonArtifact(raw)

    expect(artifact.version).toBe(1)
    expect(artifact.savedAt).toBe('2026-08-06T00:00:00.000Z')
    expect(artifact.input).toEqual(INPUT)
  })

  it('serialises as plain, stable JSON text', () => {
    const raw = serialiseComparison(INPUT, '2026-08-06T00:00:00.000Z')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('rejects non-JSON text', () => {
    expect(() => parseComparisonArtifact('not json')).toThrow(ComparisonArtifactError)
  })

  it('rejects an unsupported version rather than silently reinterpreting it', () => {
    const raw = JSON.stringify({ version: 3, savedAt: 'x', input: { arms: [] } })
    expect(() => parseComparisonArtifact(raw)).toThrow(ComparisonArtifactError)
  })

  it('rejects an arm missing required fields', () => {
    const raw = JSON.stringify({ version: 1, savedAt: 'x', input: { arms: [{ id: 'a' }] } })
    expect(() => parseComparisonArtifact(raw)).toThrow(ComparisonArtifactError)
  })

  it('rejects a complete run with no verdict, and one whose value is neither a number nor null', () => {
    const noVerdict = JSON.stringify({
      version: 1,
      savedAt: 'x',
      input: { arms: [{ id: 'a', model: 'opus', brief: 'b', runs: [{ id: 'r1', status: 'complete', value: 1 }] }] },
    })
    expect(() => parseComparisonArtifact(noVerdict)).toThrow(/missing its verdict/)
    const badValue = JSON.stringify({
      version: 1,
      savedAt: 'x',
      input: { arms: [{ id: 'a', model: 'opus', brief: 'b', runs: [{ id: 'r1', status: 'complete', verdict: 'pass', value: '4' }] }] },
    })
    expect(() => parseComparisonArtifact(badValue)).toThrow(/neither a number nor null/)
  })

  it('rejects a complete run whose value is not finite — `1e400` is a legal JSON literal that parses to `Infinity` (still `typeof "number"`), the hole the write check used to admit', () => {
    const raw =
      '{"version":1,"savedAt":"x","input":{"arms":[{"id":"a","model":"opus","brief":"b","runs":[' +
      '{"id":"r1","status":"complete","verdict":"pass","value":1e400}]}]}}'
    expect(() => parseComparisonArtifact(raw)).toThrow(/has a value that is not finite/)
  })

  it('refuses the retired "failed" run status by name — a failed gate is a completed run since prd53 ruling 2 was amended', () => {
    const raw = JSON.stringify({
      version: 1,
      savedAt: 'x',
      input: { arms: [{ id: 'a', model: 'opus', brief: 'b', runs: [{ id: 'r1', status: 'failed', error: 'timed out' }] }] },
    })
    expect(() => parseComparisonArtifact(raw)).toThrow(/retired status "failed"/)
  })

  it('rejects an unknown run status', () => {
    const raw = JSON.stringify({
      version: 1,
      savedAt: 'x',
      input: { arms: [{ id: 'a', model: 'opus', brief: 'b', runs: [{ id: 'r1', status: 'running' }] }] },
    })
    expect(() => parseComparisonArtifact(raw)).toThrow(ComparisonArtifactError)
  })
})

const INPUT_V2 = {
  arms: [
    {
      id: 'a',
      model: 'opus',
      brief: 'brief-x',
      runs: [
        { id: 'r1', status: 'complete' as const, verdict: 'pass' as const, cost: 4, duration: 900, commits: 2 },
        { id: 'r2', status: 'complete' as const, verdict: 'fail' as const, detail: 'timed out', cost: 2, duration: 800, commits: 1 },
        { id: 'r3', status: 'pending' as const },
      ],
    },
  ],
}

const PROVENANCE = { verifyCommand: 'npm test', source: 'compare-cli' as const, measuredAt: 1000 }

describe('serialiseComparisonV2 / parseComparisonArtifact (prd14 ruling 6)', () => {
  it('round-trips a v2 comparison exactly, measure and provenance included', () => {
    const raw = serialiseComparisonV2(INPUT_V2, 'cost', PROVENANCE, '2026-09-11T00:00:00.000Z')
    const artifact = parseComparisonArtifact(raw)

    expect(artifact.version).toBe(2)
    expect(artifact.savedAt).toBe('2026-09-11T00:00:00.000Z')
    if (artifact.version !== 2) throw new Error('expected version 2')
    expect(artifact.measure).toBe('cost')
    expect(artifact.provenance).toEqual(PROVENANCE)
    expect(artifact.input).toEqual(INPUT_V2)
  })

  it('a v1 artifact still READS under the v2-aware parser — no upcast, no refusal (the measure is unrecoverable)', () => {
    const v1Input: ComparisonInput = { arms: [{ id: 'a', model: 'opus', brief: 'b', runs: [{ id: 'r1', status: 'complete', verdict: 'pass', value: 4 }] }] }
    const raw = serialiseComparison(v1Input, '2026-08-06T00:00:00.000Z')
    const artifact = parseComparisonArtifact(raw)
    expect(artifact.version).toBe(1)
    if (artifact.version !== 1) throw new Error('expected version 1')
    expect(artifact.input).toEqual(v1Input)
  })

  it('a v2 artifact with its measure dropped still reads — the parser never refuses on a missing measure, only the surface reopening it falls back', () => {
    const raw = serialiseComparisonV2(INPUT_V2, undefined, undefined, 'x')
    const artifact = parseComparisonArtifact(raw)
    expect(artifact.version).toBe(2)
    if (artifact.version !== 2) throw new Error('expected version 2')
    expect(artifact.measure).toBeUndefined()
    expect(artifact.provenance).toBeUndefined()
  })

  it('rejects a v2 artifact whose measure is unrecognised, by name', () => {
    const raw = JSON.stringify({ version: 2, savedAt: 'x', measure: 'scoring', input: { arms: [] } })
    expect(() => parseComparisonArtifact(raw)).toThrow('comparison artifact has an unrecognised measure: scoring')
  })

  it('rejects a v2 complete run whose cost is neither a number nor null, and one whose cost is not finite', () => {
    const badCost = JSON.stringify({
      version: 2,
      savedAt: 'x',
      input: { arms: [{ id: 'a', model: 'opus', brief: 'b', runs: [{ id: 'r1', status: 'complete', verdict: 'pass', cost: '4', duration: 1, commits: 1 }] }] },
    })
    expect(() => parseComparisonArtifact(badCost)).toThrow(/cost field that is neither a number nor null/)

    const infiniteCost =
      '{"version":2,"savedAt":"x","input":{"arms":[{"id":"a","model":"opus","brief":"b","runs":[' +
      '{"id":"r1","status":"complete","verdict":"pass","cost":1e400,"duration":1,"commits":1}]}]}}'
    expect(() => parseComparisonArtifact(infiniteCost)).toThrow(/cost field that is not finite/)
  })
})
