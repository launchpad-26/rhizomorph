import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  isHeldBack,
  RD_HELD_BACK_REFUSAL,
  RD_MULTI_DIMENSION_REFUSAL,
  RD_PATTERN_FLOOR,
  RD_WRONG_DIMENSION_REFUSAL,
  type RdArmTreatment,
  rdDimensionsOf,
  rdDimensionsVariedCount,
  rdRefusalReason,
  rdVariesOnlyDeclaredDimension,
} from './rd.js'

const NONE: RdArmTreatment = { model: null, brief: null, checkpoint: null, gate: null }

describe('isHeldBack (prd55 ruling 3: a single occurrence is not yet a pattern)', () => {
  it('holds back fewer than two source items, and only that many', () => {
    expect(RD_PATTERN_FLOOR).toBe(2)
    expect([0, 1].map(isHeldBack)).toEqual([true, true])
    expect([2, 3, 10].map(isHeldBack)).toEqual([false, false, false])
  })

  it('a fractional or NaN count is never at the floor — counts are integers', () => {
    expect(isHeldBack(1.5)).toBe(false)
    expect(isHeldBack(Number.NaN)).toBe(false)
  })

  /**
   * THE MUTATION, EXECUTED: `count < RD_PATTERN_FLOOR` inverted to `count >
   * RD_PATTERN_FLOOR` in `rd.ts`, then `npx vitest run` over this file and
   * `events/lab.test.ts` — 4 tests went red (this file's two `isHeldBack`
   * tests, plus `rdPatternSchema`'s "refuses heldBack disagreeing with
   * count", which reads `isHeldBack` through the schema's own `.refine`).
   * Restored to `<` immediately after; the source above is the restored form.
   */
  it('the mutation this law must catch is recorded, not just claimed', () => {
    expect(isHeldBack(1)).toBe(true) // would read false under `count > RD_PATTERN_FLOOR`
  })
})

describe('rdDimensionsOf / rdDimensionsVariedCount', () => {
  const model = (m: string): RdArmTreatment => ({ ...NONE, model: m })

  it('reads which of the four dimensions vary across arms, order-free', () => {
    expect(rdDimensionsOf([model('opus'), model('sonnet')])).toEqual({
      model: true,
      brief: false,
      checkpoint: false,
      gate: false,
    })
    expect(rdDimensionsOf([NONE, NONE])).toEqual({ model: false, brief: false, checkpoint: false, gate: false })
    expect(rdDimensionsOf([])).toEqual({ model: false, brief: false, checkpoint: false, gate: false })
  })

  it('counts however many of the four vary at once — a confound is visible as a count above one', () => {
    const twoDimensions: RdArmTreatment[] = [
      { model: 'opus', brief: 'a'.repeat(64), checkpoint: null, gate: null },
      { model: 'sonnet', brief: 'b'.repeat(64), checkpoint: null, gate: null },
    ]
    expect(rdDimensionsVariedCount(rdDimensionsOf(twoDimensions))).toBe(2)
    expect(rdDimensionsVariedCount(rdDimensionsOf([model('opus'), model('sonnet')]))).toBe(1)
    expect(rdDimensionsVariedCount(rdDimensionsOf([NONE, NONE]))).toBe(0)
  })

  it('a control arm (nothing varied) counts as its own value on every dimension — null is a value, not a wildcard', () => {
    const control: RdArmTreatment = { model: null, brief: null, checkpoint: 'ckpt-1', gate: null }
    expect(rdDimensionsOf([model('opus'), control])).toEqual({
      model: true,
      brief: false,
      checkpoint: true,
      gate: false,
    })
  })
})

describe('rdRefusalReason (prd55 ruling 3 — the schema refuses a held-back proposal and a multi-dimension one)', () => {
  const cleanArms: RdArmTreatment[] = [{ ...NONE, model: 'opus' }, { ...NONE, model: 'sonnet' }]
  const dirtyArms: RdArmTreatment[] = [
    { model: 'opus', brief: 'a'.repeat(64), checkpoint: null, gate: null },
    { model: 'sonnet', brief: 'b'.repeat(64), checkpoint: null, gate: null },
  ]

  it('is null for a clean, single-dimension proposal against a live pattern', () => {
    expect(rdRefusalReason({ patternHeldBack: false, varies: 'model', arms: cleanArms })).toBeNull()
  })

  it('refuses a proposal against a held-back pattern, even with otherwise-clean arms', () => {
    expect(rdRefusalReason({ patternHeldBack: true, varies: 'model', arms: cleanArms })).toBe(RD_HELD_BACK_REFUSAL)
  })

  it('refuses a proposal whose arms vary more than one dimension', () => {
    expect(rdRefusalReason({ patternHeldBack: false, varies: 'model', arms: dirtyArms })).toBe(RD_MULTI_DIMENSION_REFUSAL)
  })

  it('held-back is checked first — a held-back pattern with dirty arms still reads the held-back reason', () => {
    expect(rdRefusalReason({ patternHeldBack: true, varies: 'model', arms: dirtyArms })).toBe(RD_HELD_BACK_REFUSAL)
  })

  /**
   * THE MUTATION, EXECUTED: dropping the `if (input.patternHeldBack) return
   * …` arm entirely (so held-back falls through to the dimension check) took
   * "refuses a proposal against a held-back pattern" and "held-back is
   * checked first" both red (`null`/the dimension reason instead of
   * `RD_HELD_BACK_REFUSAL`) — 3 tests in this file failed. Restored, then
   * dropping the `> 1` dimension arm instead took "refuses a proposal whose
   * arms vary more than one dimension" red (`null` instead of
   * `RD_MULTI_DIMENSION_REFUSAL`) — 2 tests failed. Both restored; the source
   * above is the restored form.
   */
  it('both refusal arms are load-bearing, restated as the two prior tests together', () => {
    expect(rdRefusalReason({ patternHeldBack: true, varies: 'model', arms: cleanArms })).not.toBeNull()
    expect(rdRefusalReason({ patternHeldBack: false, varies: 'model', arms: dirtyArms })).not.toBeNull()
  })

  it('the two refusal sentences are fixed and distinct — a surface can print either verbatim', () => {
    expect(RD_HELD_BACK_REFUSAL).not.toBe(RD_MULTI_DIMENSION_REFUSAL)
    expect(RD_WRONG_DIMENSION_REFUSAL).not.toBe(RD_MULTI_DIMENSION_REFUSAL)
    expect(RD_WRONG_DIMENSION_REFUSAL).not.toBe(RD_HELD_BACK_REFUSAL)
    expect(RD_WRONG_DIMENSION_REFUSAL).toContain('does not declare')
    expect(RD_HELD_BACK_REFUSAL).toContain('held back')
    expect(RD_MULTI_DIMENSION_REFUSAL).toContain('more than one dimension')
  })
})

describe('rdVariesOnlyDeclaredDimension (prd55 ruling 3 — the arms differ in THAT dimension only)', () => {
  const NONE_T: RdArmTreatment = { model: null, brief: null, checkpoint: null, gate: null }
  const modelArms: RdArmTreatment[] = [
    { ...NONE_T, model: 'opus' },
    { ...NONE_T, model: 'sonnet' },
  ]
  const gateArms: RdArmTreatment[] = [
    { ...NONE_T, gate: 'npm test' },
    { ...NONE_T, gate: 'npm run lint' },
  ]

  it('accepts arms that vary the declared dimension', () => {
    expect(rdVariesOnlyDeclaredDimension('model', modelArms)).toBe(true)
    expect(rdVariesOnlyDeclaredDimension('gate', gateArms)).toBe(true)
  })

  it('refuses arms that vary exactly one dimension — the wrong one', () => {
    expect(rdVariesOnlyDeclaredDimension('model', gateArms)).toBe(false)
    expect(rdVariesOnlyDeclaredDimension('gate', modelArms)).toBe(false)
  })

  it('accepts arms that vary nothing at all — a replication is not a misattribution', () => {
    expect(rdVariesOnlyDeclaredDimension('model', [NONE_T, NONE_T])).toBe(true)
  })

  /**
   * THE MUTATION THIS LAW EXISTS FOR, and the one the count could not see:
   * `rdDimensionsVariedCount(...) > 1` is satisfied by `gateArms` under
   * `varies: 'model'` — exactly ONE dimension varies, so the count-based
   * check passes and the difference is booked against the model. Stated as a
   * count assertion beside the law so the two cannot be confused.
   */
  it('the count-based check cannot catch this — exactly one dimension varies, and it is the wrong one', () => {
    expect(rdDimensionsVariedCount(rdDimensionsOf(gateArms))).toBe(1)
    expect(rdVariesOnlyDeclaredDimension('model', gateArms)).toBe(false)
    expect(rdRefusalReason({ patternHeldBack: false, varies: 'model', arms: gateArms })).toBe(RD_WRONG_DIMENSION_REFUSAL)
  })

  it('the count refusal still wins when both causes apply — the reader sees the more fundamental one', () => {
    const twoDimensions: RdArmTreatment[] = [
      { model: 'opus', brief: 'a'.repeat(64), checkpoint: null, gate: null },
      { model: 'sonnet', brief: 'b'.repeat(64), checkpoint: null, gate: null },
    ]
    expect(rdRefusalReason({ patternHeldBack: false, varies: 'checkpoint', arms: twoDimensions })).toBe(RD_MULTI_DIMENSION_REFUSAL)
  })

  it('held-back still outranks both', () => {
    expect(rdRefusalReason({ patternHeldBack: true, varies: 'model', arms: gateArms })).toBe(RD_HELD_BACK_REFUSAL)
  })
})

describe('ADR-0003 — this module is browser-safe, like lab/laws.ts beside it', () => {
  it('imports nothing from node:* and nothing outside itself', () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'rd.ts'), 'utf8')
    expect(source).not.toMatch(/from ['"]node:/)
    expect(source).not.toMatch(/^import /m)
  })
})
