import type { RoleSpend } from '@observatory/core'

const TOKEN_UNITS: readonly [threshold: number, suffix: string][] = [
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K'],
]

/** `1184279` → `"1.2M"`; small counts print exactly. */
export function formatTokens(count: number): string {
  for (const [threshold, suffix] of TOKEN_UNITS) {
    if (count >= threshold) return `${trimTrailingZero((count / threshold).toFixed(1))}${suffix}`
  }
  return String(count)
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}

/**
 * `0` reads as `$0.00` — that is a real zero, distinct from "unknown" (which
 * callers must check via `costIsAuthoritative` before reaching for this).
 * Anything under a cent still shows as non-zero rather than rounding away the
 * one real auxiliary-call cost the fixtures carry.
 */
export function formatUsd(amountUsd: number): string {
  if (amountUsd > 0 && amountUsd < 0.01) return '<$0.01'
  return `$${amountUsd.toFixed(2)}`
}

export function formatUsdPerHour(rate: number): string {
  return `${formatUsd(rate)}/hr`
}

type CostFields = Pick<RoleSpend, 'costUsd' | 'costEventCount' | 'costIsAuthoritative'>

export interface CostOverhead {
  /**
   * False when the conductor has never sent a `llm.cost` event. A conductor's
   * *tokens* can still show up in this state — `sessionlog --extra-sessions`
   * tags a whole directory `role: conductor` with no dollars attached — so
   * this is checked from `costEventCount`, never from token totals, or that
   * token-only contamination would masquerade as a real ratio.
   */
  conductorInstrumented: boolean
  /** Conductor `costUsd` ÷ worker `costUsd`. Null when either side has no cost. */
  ratio: number | null
  /** True when either side's dollars include a pricing-table estimate. */
  mixedProvenance: boolean
}

/**
 * prd1's headline overhead metric — on cost, never tokens. See
 * `docs/architecture.md`'s Decisions log for why a token-derived ratio was
 * rejected: an un-instrumented conductor must render as a visible gap, not a
 * number computed from whatever happened to be lying around.
 */
export function selectCostOverhead(worker: CostFields, conductor: CostFields): CostOverhead {
  const conductorInstrumented = conductor.costEventCount > 0
  const mixedProvenance = worker.costIsAuthoritative === false || conductor.costIsAuthoritative === false
  if (!conductorInstrumented || worker.costUsd <= 0) {
    return { conductorInstrumented, ratio: null, mixedProvenance }
  }
  return { conductorInstrumented, ratio: conductor.costUsd / worker.costUsd, mixedProvenance }
}

/** An un-instrumented conductor renders as an actionable gap, never `0.00×`. */
export function formatCostOverhead(overhead: CostOverhead): string {
  if (!overhead.conductorInstrumented) {
    return 'conductor not instrumented — see docs/telemetry.md'
  }
  if (overhead.ratio === null) return 'unknown — no worker cost yet'
  const suffix = overhead.mixedProvenance ? ' (incl. estimate)' : ''
  return `overhead ${overhead.ratio.toFixed(2)}×${suffix}`
}
