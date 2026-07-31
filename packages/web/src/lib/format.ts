import type { TokenTotals } from '@observatory/core'

/**
 * The dashboard's one formatting module. prd2's ruling: output tokens are the
 * headline everywhere a single token figure is shown, all four cache tiers
 * stay visible (never hidden behind the headline), and nothing renders an
 * unlabelled all-tier `.total` — see `docs/prd2.md` and `docs/telemetry.md`.
 * Every panel in the fence imports from here instead of keeping its own copy.
 */

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
 * `0` reads as `$0.00` — a real zero, distinct from "unknown" (callers check
 * that separately, e.g. via `costEventCount`/`costIsAuthoritative`). Anything
 * under a cent still shows as non-zero rather than rounding away a real cost.
 */
export function formatUsd(amountUsd: number): string {
  if (amountUsd > 0 && amountUsd < 0.01) return '<$0.01'
  return `$${amountUsd.toFixed(2)}`
}

export function formatUsdPerHour(rate: number): string {
  return `${formatUsd(rate)}/hr`
}

/** Tier order for every breakdown display: output first (the headline), cache tiers last. */
export const TOKEN_TIERS = [
  { key: 'output', label: 'output' },
  { key: 'input', label: 'input' },
  { key: 'cacheRead', label: 'cache read' },
  { key: 'cacheCreation', label: 'cache write' },
] as const satisfies readonly { key: keyof Omit<TokenTotals, 'total'>; label: string }[]

/**
 * The four-tier breakdown string, for the `title=` tooltip idiom the ledger
 * and worktree panels already use on their cost cells. prd2's ruling is that
 * a reader must always be able to reach the full breakdown from an
 * output-led figure — never just the all-tier sum with no way to see the
 * tiers that make it up.
 */
export function formatTokenBreakdown(tokens: TokenTotals): string {
  return TOKEN_TIERS.map(({ key, label }) => `${label} ${formatTokens(tokens[key])}`).join(' · ')
}
