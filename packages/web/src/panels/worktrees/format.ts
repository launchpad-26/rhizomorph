/** Compact dollar formatting for the cost column — 4 decimals only under a cent. */
export function formatUsd(amount: number): string {
  const abs = Math.abs(amount)
  if (abs > 0 && abs < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

/** Compact token count — the fallback when a lane has no authoritative dollars yet. */
export function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`
  return `${total}`
}
