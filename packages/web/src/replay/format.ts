import type { SpendTotals } from '@rhizomorph/core'
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

/**
 * `mm:ss` since a reference point — the one clock replay's chrome shares, so
 * the scrubber, the mode badge and the banner never print a different shape
 * for the same duration (law 11: mono, and one formatter per kind of figure).
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * The absolute wall-clock moment being viewed — "the timestamp being
 * viewed" the REPLAY banner owns (ruling 16). UTC, not local time: a
 * recording opened on a stranger's machine must print the same digits
 * regardless of that machine's timezone.
 */
export function formatWallClock(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19)
}
