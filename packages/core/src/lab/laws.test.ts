import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CONFOUND_VOICE,
  COUNTERFACTUAL_CLAUSE,
  canRankArms,
  canSummariseArm,
  confoundVoice,
  dimensionsOf,
  isCleanlyControlled,
  isCompletedVerdict,
  MIN_ARMS_TO_RANK,
  MIN_COMPLETED_RUNS_TO_SUMMARISE,
} from './laws.js'

describe('the floors (prd53 ruling 2, extending prd12 ruling 4 — never loosening it)', () => {
  it('a summary needs three completed runs of the arm — two is observations, three is a distribution', () => {
    expect(MIN_COMPLETED_RUNS_TO_SUMMARISE).toBe(3)
    expect([0, 1, 2].map(canSummariseArm)).toEqual([false, false, false])
    expect([3, 4, 10].map(canSummariseArm)).toEqual([true, true, true])
  })

  it('a cross-arm claim needs three arms — prd12 ruling 4, restated not relaxed', () => {
    expect(MIN_ARMS_TO_RANK).toBe(3)
    expect([0, 1, 2].map(canRankArms)).toEqual([false, false, false])
    expect([3, 5].map(canRankArms)).toEqual([true, true])
  })

  it('a fractional or negative count is never at the floor — counts are integers', () => {
    expect(canSummariseArm(2.5)).toBe(false)
    expect(canSummariseArm(Number.NaN)).toBe(false)
    expect(canRankArms(-3)).toBe(false)
  })

  it('the counterfactual clause is one fixed sentence, so every surface says the same thing below the floor', () => {
    expect(COUNTERFACTUAL_CLAUSE).toBe('what actually happened is one observation, not a distribution')
  })

  it('a run is completed when a gate judged it — pass or fail; not-run and unjudged are not (ruling 2, amendment 2026-09-08)', () => {
    expect((['pass', 'fail', 'not-run', undefined] as const).map(isCompletedVerdict)).toEqual([true, true, false, false])
  })
})

describe('the confound clause', () => {
  const opusA = { model: 'opus', promptDigest: 'a'.repeat(64) }
  const sonnetA = { model: 'sonnet', promptDigest: 'a'.repeat(64) }
  const opusB = { model: 'opus', promptDigest: 'b'.repeat(64) }
  const control = { model: null, promptDigest: null }

  it('reads which dimensions vary across arms, order-free', () => {
    expect(dimensionsOf([opusA, sonnetA])).toEqual({ modelVaries: true, promptVaries: false })
    expect(dimensionsOf([opusA, opusB])).toEqual({ modelVaries: false, promptVaries: true })
    expect(dimensionsOf([opusA, sonnetA, opusB])).toEqual({ modelVaries: true, promptVaries: true })
    expect(dimensionsOf([opusA, opusA])).toEqual({ modelVaries: false, promptVaries: false })
    expect(dimensionsOf([])).toEqual({ modelVaries: false, promptVaries: false })
  })

  it('a control arm (neither varied) counts as its own model and brief — null is a value, not a wildcard', () => {
    expect(dimensionsOf([opusA, control])).toEqual({ modelVaries: true, promptVaries: true })
  })

  it('exactly one varying dimension is cleanly controlled; zero is a replication; two is a confound', () => {
    expect(isCleanlyControlled({ modelVaries: true, promptVaries: false })).toBe(true)
    expect(isCleanlyControlled({ modelVaries: false, promptVaries: true })).toBe(true)
    expect(isCleanlyControlled({ modelVaries: false, promptVaries: false })).toBe(false)
    expect(isCleanlyControlled({ modelVaries: true, promptVaries: true })).toBe(false)
  })

  it('speaks only when both dimensions vary, and then in the one fixed sentence', () => {
    expect(confoundVoice({ modelVaries: true, promptVaries: true })).toBe(CONFOUND_VOICE)
    expect(confoundVoice({ modelVaries: true, promptVaries: false })).toBeNull()
    expect(confoundVoice({ modelVaries: false, promptVaries: false })).toBeNull()
    expect(CONFOUND_VOICE).toContain('cannot be attributed to either')
  })
})

describe('ADR-0003 — this module is browser-safe', () => {
  it('imports nothing from node:* and nothing outside itself', () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'laws.ts'), 'utf8')
    expect(source).not.toMatch(/from ['"]node:/)
    expect(source).not.toMatch(/^import /m)
  })
})
