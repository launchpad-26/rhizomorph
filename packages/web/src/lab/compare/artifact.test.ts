import { describe, expect, it } from 'vitest'
import { ComparisonArtifactError, parseComparisonArtifact, serialiseComparison } from './artifact.js'
import type { ComparisonInput } from './types.js'

const INPUT: ComparisonInput = {
  arms: [
    {
      id: 'a',
      model: 'opus',
      brief: 'brief-x',
      runs: [
        { id: 'r1', status: 'complete', value: 4 },
        { id: 'r2', status: 'pending' },
        { id: 'r3', status: 'failed', error: 'timed out' },
        { id: 'r4', status: 'failed' },
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

  it('rejects a complete run with no numeric value', () => {
    const raw = JSON.stringify({
      version: 1,
      savedAt: 'x',
      input: { arms: [{ id: 'a', model: 'opus', brief: 'b', runs: [{ id: 'r1', status: 'complete' }] }] },
    })
    expect(() => parseComparisonArtifact(raw)).toThrow(ComparisonArtifactError)
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
