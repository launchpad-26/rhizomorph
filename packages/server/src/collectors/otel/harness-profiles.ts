import type { TokenUsagePayload } from '@rhizomorph/core'
import { attrString, type OtlpKeyValue } from './types.js'

/**
 * ADR-0025: a harness that exports OTLP natively gets a mapping profile, not
 * a collector. One row per harness `parse-metrics.ts` understands, keyed on
 * the `service.name` resource attribute every capture so far carries —
 * everything else about the receiver (routes, transport, attribution) is
 * shared and untouched by this table.
 */
export interface HarnessMetricProfile {
  /** The `service.name` resource attribute value this row matches. */
  serviceName: string
  /** `POST /v1/metrics` metric name carrying token usage. */
  tokenUsageMetric: string
  /** Metric name carrying an authoritative dollar cost, or `null` when the capture shows the harness reports none — never derive one (prd-15 ruling 3). */
  costUsageMetric: string | null
  /** Metric name carrying cumulative active seconds, or `null` when no capture shows an equivalent. */
  activeTimeMetric: string | null
  /** `tokenUsageMetric` datapoint `type` attribute value -> the core tier it fills. */
  tokenTypeToTier: Readonly<Record<string, keyof TokenUsagePayload>>
  /**
   * `type` values this harness is known (by capture) to send that name a real
   * quantity with no tier in `TokenUsagePayload` — a declared capability gap,
   * not malformed data. Surfaced as a counted, visible `collector.error`
   * (never silently folded into a tier, never a per-datapoint error) —
   * widening `TokenUsagePayload` itself is a separate additive core PR
   * (ruling 4), out of this receiver's fence.
   */
  declaredGapTokenTypes: readonly string[]
}

/** claude's row is exactly the three constants this table replaces — unchanged by construction. */
export const CLAUDE_METRIC_PROFILE: HarnessMetricProfile = {
  serviceName: 'claude-code',
  tokenUsageMetric: 'claude_code.token.usage',
  costUsageMetric: 'claude_code.cost.usage',
  activeTimeMetric: 'claude_code.active_time.total',
  tokenTypeToTier: {
    input: 'input',
    output: 'output',
    cacheRead: 'cacheRead',
    cacheCreation: 'cacheCreation',
  },
  declaredGapTokenTypes: [],
}

/**
 * gemini-cli 0.55.1, captured for #323 (`fixtures/CAPTURE.md`). Its
 * `gemini_cli.token.usage` sum metric carries five `type` values per turn —
 * `input`/`output`/`cache` cover three of core's four tiers (gemini doesn't
 * distinguish a cache-write tier the way claude's `cacheCreation` does, so
 * `cache` maps to `cacheRead`); `thought` and `tool` name real per-turn
 * quantities (thinking tokens, tool-definition tokens) `TokenUsagePayload`
 * has no tier for. No cost/price/currency field appears anywhere in the
 * capture, so `costUsageMetric` is `null` (prd-15 ruling 3: never derive
 * one). No metric in the capture answers `claude_code.active_time.total`'s
 * cumulative-active-seconds question either.
 */
export const GEMINI_METRIC_PROFILE: HarnessMetricProfile = {
  serviceName: 'gemini-cli',
  tokenUsageMetric: 'gemini_cli.token.usage',
  costUsageMetric: null,
  activeTimeMetric: null,
  tokenTypeToTier: {
    input: 'input',
    output: 'output',
    cache: 'cacheRead',
  },
  declaredGapTokenTypes: ['thought', 'tool'],
}

/**
 * The live dispatch table. EXPORTED so its own law can iterate it rather than
 * a hand-written copy of it.
 *
 * The verify pass on #323 found the law hard-coded `[CLAUDE_METRIC_PROFILE,
 * GEMINI_METRIC_PROFILE]` while this table was private: a third row added here
 * and wired into dispatch passed every test, so "recognised by name implies
 * fixture-backed" held by someone remembering to extend a list. All four review
 * seats found it independently — the only unanimous finding of that review.
 * ADR-0025's done-when asks for it by construction, which means iterating this.
 */
export const METRIC_PROFILES: Readonly<Record<string, HarnessMetricProfile>> = {
  [CLAUDE_METRIC_PROFILE.serviceName]: CLAUDE_METRIC_PROFILE,
  [GEMINI_METRIC_PROFILE.serviceName]: GEMINI_METRIC_PROFILE,
}

export interface ResolvedMetricProfile {
  profile: HarnessMetricProfile
  /**
   * True when `service.name` named a row in the table above. `false` still
   * carries claude's profile (the default every pre-existing body without a
   * `service.name` already relied on) but means this export did not actually
   * claim to be claude — the difference between an entirely unknown harness
   * (stays quiet, ADR-0025) and a known one sending a record this profile
   * doesn't read yet (counted and visible).
   */
  recognized: boolean
}

/**
 * Resolves which harness's vocabulary a `resourceMetrics` block speaks, from
 * its `service.name` resource attribute. Absent or unrecognised defaults to
 * claude's row, not as a guess that the export is claude, but because that is
 * what keeps every body lacking `service.name` — claude's own early captures,
 * every hand-written test body in `parse-metrics.test.ts` — parsing exactly
 * as it always has.
 */
export function resolveMetricProfile(resourceAttrs: OtlpKeyValue[] | undefined): ResolvedMetricProfile {
  const serviceName = attrString(resourceAttrs, 'service.name')
  const matched = serviceName ? METRIC_PROFILES[serviceName] : undefined
  return matched ? { profile: matched, recognized: true } : { profile: CLAUDE_METRIC_PROFILE, recognized: false }
}
