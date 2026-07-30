import type { BranchSpend } from '@observatory/core'

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

export function formatUsd(amountUsd: number): string {
  if (amountUsd > 0 && amountUsd < 0.01) return '<$0.01'
  return `$${amountUsd.toFixed(2)}`
}

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
 * Dollars whenever any telemetry has priced this branch, tokens alone when
 * none ever has — the null case in {@link BranchSpend.costIsAuthoritative} is
 * "we do not know", not "it was free", so it must never render as `$0.00`.
 */
export function costCellText(row: BranchSpend): string {
  if (row.costIsAuthoritative === null) return formatTokens(row.tokens.total)
  return formatUsd(row.costUsd)
}

export function costCellTitle(row: BranchSpend): string {
  if (row.costIsAuthoritative === null) return 'tokens shown — no cost telemetry yet'
  if (row.costIsAuthoritative === false) {
    return `includes an estimate, not fully authoritative (total ${formatUsd(row.costUsd)})`
  }
  return 'authoritative dollar cost (OTel)'
}
