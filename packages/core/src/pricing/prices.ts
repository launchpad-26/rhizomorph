import { z } from 'zod'
import type { TokenUsagePayload } from '../events/index.js'
import raw from './default-model-prices.json'

/**
 * prd9 ruling 7 — the pricing rip. Langfuse's vendored `default-model-prices.json`
 * (MIT, pinned to a commit SHA — see `PROVENANCE.md`) turned into a lookup a
 * selector can call on read: given a model id and the four token tiers we
 * already record, either a priced estimate or an honest "no match", never a
 * guess.
 *
 * Two traps the research (`research/2026-08-03-trace-era-captures.md` §3)
 * found in this exact file, both handled here and nowhere else:
 *
 * 1. `matchPattern` is prefixed `(?i)` for case-insensitivity — a Python/PCRE
 *    inline flag that is a syntax error in JS `RegExp`. We strip the prefix
 *    and pass the `i` flag instead.
 * 2. The table carries an alias key, `cache_creation_input_tokens`, equal to
 *    the 5-minute cache-write price. Pricing an aggregate cache-creation count
 *    with it silently assumes every write was the cheap 5m tier. We never
 *    read that key — only the split `input_cache_creation_5m` /
 *    `input_cache_creation_1h`.
 *
 * A third, structural fact this loader bakes in rather than discovers at call
 * time: {@link TokenUsagePayload.cacheCreation} is a single number — prd1's
 * shape never split 5m from 1h cache-creation tokens. Since 5m is the CHEAPER
 * of the two tiers (1.25x input vs 1h's 2x), pricing the whole aggregate at
 * the 5m rate is a **floor**, not a midpoint or a ceiling: the true cost is
 * this estimate or higher, never lower. `estimateSource` names the table and
 * pin so this assumption travels with every number it produces.
 */

const PRICE_SOURCE_SHA = 'cfac485'
export const PRICE_SOURCE_NAME = `langfuse-prices@${PRICE_SOURCE_SHA}`

const pricingTierSchema = z.object({
  isDefault: z.boolean(),
  // `input`/`output` are absent on the table's modality-priced entries (audio,
  // realtime) — real shapes we do not use, not a parse failure. Those entries
  // are dropped in `parsePriceTable` rather than treated as zero-cost.
  prices: z.object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    input_cache_read: z.number().nonnegative().optional(),
    input_cache_creation_5m: z.number().nonnegative().optional(),
    input_cache_creation_1h: z.number().nonnegative().optional(),
  }),
})

const priceEntrySchema = z.object({
  id: z.string(),
  modelName: z.string(),
  matchPattern: z.string(),
  pricingTiers: z.array(pricingTierSchema).min(1),
})

const priceTableSchema = z.array(priceEntrySchema)

/** Per-token USD prices for the four tiers our {@link TokenUsagePayload} carries. */
export interface ModelRate {
  modelName: string
  pattern: RegExp
  input: number
  output: number
  cacheRead: number
  /** The 5m cache-write rate — see the module doc for why this is a floor. */
  cacheCreation5m: number
}

/**
 * `(?i)^...$` → a JS `RegExp` with the `i` flag. Every entry in the vendored
 * table is prefixed this way (verified at vendoring time); a pattern that
 * somehow isn't is left un-stripped rather than thrown away, since the regex
 * still compiles — just case-sensitively.
 */
export function compilePattern(matchPattern: string): RegExp {
  const body = matchPattern.startsWith('(?i)') ? matchPattern.slice('(?i)'.length) : matchPattern
  return new RegExp(body, 'i')
}

function defaultTier(tiers: z.infer<typeof pricingTierSchema>[]): z.infer<typeof pricingTierSchema> {
  return tiers.find((tier) => tier.isDefault) ?? tiers[0]!
}

/**
 * Parses a raw table (the vendored JSON's shape) into lookup-ready rates.
 * Exported so the loader tests can exercise the `(?i)` strip and the
 * alias-key refusal against hand-built fixtures, not just the real table.
 *
 * Entries whose default tier prices by modality (audio/realtime — no plain
 * `input`/`output` per-token rate) are dropped: a shape we do not use, not
 * one we approximate at zero.
 */
export function parsePriceTable(value: unknown): ModelRate[] {
  const parsed = priceTableSchema.parse(value)
  const rates: ModelRate[] = []
  for (const entry of parsed) {
    const tier = defaultTier(entry.pricingTiers)
    if (tier.prices.input === undefined || tier.prices.output === undefined) continue
    rates.push({
      modelName: entry.modelName,
      pattern: compilePattern(entry.matchPattern),
      input: tier.prices.input,
      output: tier.prices.output,
      cacheRead: tier.prices.input_cache_read ?? 0,
      cacheCreation5m: tier.prices.input_cache_creation_5m ?? 0,
    })
  }
  return rates
}

/** First entry (table order) whose `matchPattern` matches, or null — an honest gap. */
export function findRate(rates: readonly ModelRate[], model: string): ModelRate | null {
  for (const rate of rates) {
    if (rate.pattern.test(model)) return rate
  }
  return null
}

/** Prices one request's tokens against a single already-resolved rate. */
export function priceTokens(rate: ModelRate, tokens: TokenUsagePayload): number {
  return (
    tokens.input * rate.input +
    tokens.output * rate.output +
    tokens.cacheRead * rate.cacheRead +
    tokens.cacheCreation * rate.cacheCreation5m
  )
}

let rates: ModelRate[] | null = null

function vendoredRates(): ModelRate[] {
  if (rates === null) rates = parsePriceTable(raw)
  return rates
}

export interface CostEstimate {
  costUsd: number
  /** Names the table and pin, e.g. `langfuse-prices@cfac485` — never a bare number. */
  source: string
}

/**
 * The selector-side estimate: null when no vendored pattern matches this model
 * id — an honest gap (the canonical case: a live `[1m]`-suffixed model id the
 * table's patterns do not cover), never a guessed price.
 */
export function estimateCostUsd(model: string, tokens: TokenUsagePayload): CostEstimate | null {
  const rate = findRate(vendoredRates(), model)
  if (rate === null) return null
  return { costUsd: priceTokens(rate, tokens), source: PRICE_SOURCE_NAME }
}
