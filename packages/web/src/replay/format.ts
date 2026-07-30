import type { SpendTotals } from '@observatory/core'

/** Compact dollar formatting — 4 decimals only under a cent. */
export function formatUsd(amount: number): string {
  const abs = Math.abs(amount)
  if (abs > 0 && abs < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

/** Compact token count — the fallback when there is no cost telemetry at all. */
export function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`
  return `${total}`
}

/**
 * Dollars whenever any cost event exists — authoritative or estimated, both are
 * real facts about the log. Tokens only when `costIsAuthoritative` is null,
 * meaning no cost telemetry arrived at all: never a fabricated $0.
 */
export function formatSpend(totals: SpendTotals): string {
  if (totals.costIsAuthoritative !== null) return formatUsd(totals.costUsd)
  return `${formatTokens(totals.tokens.total)} tok`
}
