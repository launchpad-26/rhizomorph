import { describe, expect, it } from 'vitest'
import {
  ComparisonArtifactError,
  type ComparisonInput,
  parseComparisonArtifact,
  parseComparisonInput,
  serialiseComparison,
} from './artifact.js'

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
    const raw = JSON.stringify({ version: 2, savedAt: 'x', input: { arms: [] } })
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

  it('the version refusal is by name — the exact string, not merely the error class', () => {
    const raw = JSON.stringify({ version: 2, savedAt: 'x', input: { arms: [] } })
    expect(() => parseComparisonArtifact(raw)).toThrow('unsupported comparison artifact version: 2')
  })

  it('parseComparisonInput accepts a bare input and rejects a malformed one', () => {
    expect(parseComparisonInput(INPUT)).toEqual(INPUT)
    expect(() => parseComparisonInput({})).toThrow('comparison artifact is missing its arms array')
    expect(() => parseComparisonInput(null)).toThrow('comparison artifact is missing its arms array')
  })
})
