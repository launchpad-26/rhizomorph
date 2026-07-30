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

/** Null renders as an explicit "not yet known", never a misleading `0.00×`. */
export function formatOverheadRatio(ratio: number | null): string {
  if (ratio === null) return 'unknown — no conductor telemetry yet'
  return `${ratio.toFixed(2)}×`
}
