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

/** `1536` → `"1.5KB"`; drops to `MB` past a thousand `KB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${trimTrailingZero(kb.toFixed(1))}KB`
  return `${trimTrailingZero((kb / 1024).toFixed(1))}MB`
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}
