import { describe, expect, it } from 'vitest'
import {
  PRICE_SOURCE_NAME,
  compilePattern,
  estimateCostUsd,
  findRate,
  parsePriceTable,
  priceTokens,
} from './prices.js'

const tokens = (input: number, output: number, cacheRead = 0, cacheCreation = 0) => ({
  input,
  output,
  cacheRead,
  cacheCreation,
})

describe('compilePattern — the (?i) trap', () => {
  it('strips the (?i) prefix and applies the i flag instead, so it still compiles', () => {
    // `new RegExp('(?i)^x$')` throws in JS — this must not.
    expect(() => compilePattern('(?i)^claude-opus-5$')).not.toThrow()
  })

  it('matches case-insensitively after the strip', () => {
    const pattern = compilePattern('(?i)^claude-opus-5$')
    expect(pattern.test('claude-opus-5')).toBe(true)
    expect(pattern.test('CLAUDE-OPUS-5')).toBe(true)
    expect(pattern.test('Claude-Opus-5')).toBe(true)
  })

  it('leaves a pattern with no (?i) prefix alone, still case-insensitive via the flag', () => {
    const pattern = compilePattern('^plain-model$')
    expect(pattern.test('PLAIN-MODEL')).toBe(true)
  })
})

describe('parsePriceTable — the alias-key trap', () => {
  const fixture = (prices: Record<string, number>) => [
    {
      id: 'fixture-1',
      modelName: 'fixture-model',
      matchPattern: '(?i)^fixture-model$',
      pricingTiers: [{ isDefault: true, prices: { input: 1, output: 2, ...prices } }],
    },
  ]

  it('prices cacheCreation at the split 5m rate, never the alias', () => {
    // The alias `cache_creation_input_tokens` is deliberately way off from the
    // split 5m rate here — if the loader ever read it, this price would change.
    const rates = parsePriceTable(
      fixture({
        cache_creation_input_tokens: 999,
        input_cache_creation_5m: 3,
        input_cache_creation_1h: 5,
      }),
    )
    const rate = findRate(rates, 'fixture-model')
    expect(rate).not.toBeNull()
    expect(priceTokens(rate!, tokens(0, 0, 0, 10))).toBeCloseTo(30, 10)
  })

  it('never reaches for input_cache_creation (the unsplit alias) either', () => {
    const rates = parsePriceTable(
      fixture({
        input_cache_creation: 999,
        input_cache_creation_5m: 4,
      }),
    )
    const rate = findRate(rates, 'fixture-model')
    expect(priceTokens(rate!, tokens(0, 0, 0, 1))).toBeCloseTo(4, 10)
  })

  it('treats a missing cache price as zero rather than failing to parse', () => {
    const rates = parsePriceTable(fixture({}))
    const rate = findRate(rates, 'fixture-model')
    expect(rate).not.toBeNull()
    expect(priceTokens(rate!, tokens(1, 1, 100, 100))).toBeCloseTo(1 + 2, 10)
  })

  it('prices input and output at their own table rates', () => {
    const rates = parsePriceTable(fixture({ input_cache_read: 0.5 }))
    const rate = findRate(rates, 'fixture-model')!
    expect(priceTokens(rate, tokens(10, 5, 2, 0))).toBeCloseTo(10 * 1 + 5 * 2 + 2 * 0.5, 10)
  })

  it('picks the isDefault tier when a model carries more than one', () => {
    const rates = parsePriceTable([
      {
        id: 'fixture-2',
        modelName: 'multi-tier',
        matchPattern: '(?i)^multi-tier$',
        pricingTiers: [
          { isDefault: false, prices: { input: 999, output: 999 } },
          { isDefault: true, prices: { input: 1, output: 1 } },
        ],
      },
    ])
    const rate = findRate(rates, 'multi-tier')!
    expect(rate.input).toBe(1)
    expect(rate.output).toBe(1)
  })
})

describe('estimateCostUsd — against the real vendored table', () => {
  it('prices a known Claude model using its real, pinned rates', () => {
    // claude-opus-5 in the pinned table: input 5e-6, output 2.5e-5,
    // cache_read 5e-7, cache_creation_5m 6.25e-6 (per token, USD).
    const estimate = estimateCostUsd('claude-opus-5', tokens(1_000, 1_000, 1_000, 1_000))
    expect(estimate).not.toBeNull()
    expect(estimate!.costUsd).toBeCloseTo(
      1_000 * 5e-6 + 1_000 * 2.5e-5 + 1_000 * 5e-7 + 1_000 * 6.25e-6,
      10,
    )
    expect(estimate!.source).toBe(PRICE_SOURCE_NAME)
    expect(estimate!.source).toBe('langfuse-prices@cfac485')
  })

  it('matches case-insensitively against the real table too', () => {
    const lower = estimateCostUsd('claude-opus-5', tokens(0, 100))
    const upper = estimateCostUsd('CLAUDE-OPUS-5', tokens(0, 100))
    expect(upper).not.toBeNull()
    expect(upper!.costUsd).toBeCloseTo(lower!.costUsd, 10)
  })

  it('returns null for the canonical live miss — a [1m]-suffixed model id', () => {
    // research/2026-08-03-trace-era-captures.md §3: Langfuse's own catalog
    // failed on `claude-opus-5[1m]` — the vendored table's anchored patterns
    // (`^...$`) have the same hole, and that is the honest-gap case this
    // loader must preserve, not paper over.
    expect(estimateCostUsd('claude-opus-5[1m]', tokens(0, 100))).toBeNull()
  })

  it('returns null for a model no pattern in the table covers at all', () => {
    expect(estimateCostUsd('some-made-up-model-nobody-ships', tokens(0, 100))).toBeNull()
  })
})
