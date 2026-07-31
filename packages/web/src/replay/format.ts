import type { SpendTotals } from '@observatory/core'
import { formatTokens, formatUsd } from '../lib/format.js'

/**
 * Dollars whenever any cost event exists — authoritative or estimated, both are
 * real facts about the log. Output tokens only when `costIsAuthoritative` is
 * null, meaning no cost telemetry arrived at all: never a fabricated $0, and
 * never the unlabelled all-tier `.total` (prd2's ruling) — `tok out` names
 * exactly which tier this figure is.
 */
export function formatSpend(totals: SpendTotals): string {
  if (totals.costIsAuthoritative !== null) return formatUsd(totals.costUsd)
  return `${formatTokens(totals.tokens.output)} tok out`
}
