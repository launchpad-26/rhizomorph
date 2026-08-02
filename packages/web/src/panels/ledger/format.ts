import type { AgentThread, SpendTotals } from '@rhizomorph/core'
import { formatTokenBreakdown, formatTokens, formatUsd } from '../../lib/format.js'

/** `null` reads as "still going" or "never happened" depending on the caller — never `0m`. */
export function formatElapsed(ms: number | null): string {
  if (ms === null) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
}

export function formatRelativeTime(ts: number | null, now: number): string {
  if (ts === null) return '—'
  const deltaMs = Math.max(0, now - ts)
  if (deltaMs < 45_000) return 'just now'
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/**
 * Dollars whenever any telemetry has priced this row, output tokens alone
 * when none ever has — the null case in {@link SpendTotals.costIsAuthoritative}
 * is "we do not know", not "it was free", so it must never render as `$0.00`.
 * The fallback is output-led, never the unlabelled all-tier `.total` (prd2's
 * ruling), and labelled `out` so it cannot be mistaken for one. Shared by
 * branch rows and their thread sub-rows: both are a {@link SpendTotals}.
 */
export function costCellText(row: SpendTotals): string {
  if (row.costIsAuthoritative === null) return `${formatTokens(row.tokens.output)} out`
  return formatUsd(row.costUsd)
}

export function costCellTitle(row: SpendTotals): string {
  if (row.costIsAuthoritative === null) {
    return `output tokens shown — no cost telemetry yet (${formatTokenBreakdown(row.tokens)})`
  }
  if (row.costIsAuthoritative === false) {
    return `includes an estimate, not fully authoritative (total ${formatUsd(row.costUsd)})`
  }
  return 'authoritative dollar cost (OTel)'
}

/** The TOKENS column's own tooltip: the full four-tier breakdown behind its output-led figure. */
export function tokensCellTitle(row: SpendTotals): string {
  return formatTokenBreakdown(row.tokens)
}

/** `null` is the source-didn't-say bucket — rendered as its own label, never folded into `main`. */
export function threadLabel(thread: AgentThread | null): string {
  return thread ?? 'unknown'
}
