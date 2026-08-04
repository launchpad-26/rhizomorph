import { describe, expect, it } from 'vitest'
import { createEvent, rhizomorphEventSchema } from './index.js'
import { judgeFindingEventSchema, judgeFindingPayloadSchema } from './judge.js'

const SYMBOL_OVERLAP = {
  kind: 'symbol-overlap' as const,
  lanes: ['2-core', '3-git'] as [string, string],
  evidence: { symbols: ['formatDuration'] },
  severity: 'log' as const,
  detectedAt: 1000,
}

const SPECULATIVE_CONFLICT = {
  kind: 'speculative-conflict' as const,
  lanes: ['2-core', '3-git'] as [string, string],
  evidence: { conflictingFiles: ['packages/core/src/index.ts'] },
  severity: 'log' as const,
  detectedAt: 1000,
}

describe('judge.finding', () => {
  it('parses a valid symbol-overlap finding', () => {
    expect(judgeFindingPayloadSchema.safeParse(SYMBOL_OVERLAP).success).toBe(true)
  })

  it('parses a valid speculative-conflict finding', () => {
    expect(judgeFindingPayloadSchema.safeParse(SPECULATIVE_CONFLICT).success).toBe(true)
  })

  it('round-trips through createEvent with source "judge"', () => {
    const event = createEvent('judge.finding', SYMBOL_OVERLAP, { id: 'evt-1', ts: 1000 })
    expect(event.source).toBe('judge')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('rejects lanes that are not ordered', () => {
    const result = judgeFindingPayloadSchema.safeParse({
      ...SYMBOL_OVERLAP,
      lanes: ['3-git', '2-core'],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a pair naming the same lane twice', () => {
    const result = judgeFindingPayloadSchema.safeParse({
      ...SYMBOL_OVERLAP,
      lanes: ['2-core', '2-core'],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a symbol-overlap finding with no symbols in evidence', () => {
    const result = judgeFindingPayloadSchema.safeParse({
      ...SYMBOL_OVERLAP,
      evidence: {},
    })
    expect(result.success).toBe(false)
  })

  it('rejects a speculative-conflict finding with no conflicting files in evidence', () => {
    const result = judgeFindingPayloadSchema.safeParse({
      ...SPECULATIVE_CONFLICT,
      evidence: {},
    })
    expect(result.success).toBe(false)
  })

  it('rejects a bare-claim evidence — empty arrays are still no evidence', () => {
    const result = judgeFindingPayloadSchema.safeParse({
      ...SYMBOL_OVERLAP,
      evidence: { symbols: [] },
    })
    expect(result.success).toBe(false)
  })

  it('rejects any severity other than the silent "log" rung', () => {
    const result = judgeFindingPayloadSchema.safeParse({
      ...SYMBOL_OVERLAP,
      severity: 'notice',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a source other than "judge"', () => {
    const result = judgeFindingEventSchema.safeParse({
      id: 'evt-1',
      ts: 1000,
      source: 'git',
      type: 'judge.finding',
      payload: SYMBOL_OVERLAP,
    })
    expect(result.success).toBe(false)
  })
})
