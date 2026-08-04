import type { TokenTotals } from '@rhizomorph/core'
import type { Burn } from '../../fleet/index.js'
import { formatTokenBreakdown, formatTokens, formatUsd, formatUsdPerHour } from '../../lib/format.js'

/**
 * The burn strip's two gap-voice lines (ruling 12), pinned to the exact
 * wording #80 was groomed with — never `$0.00` for a missing feed, never a
 * bare "unknown" for an uninstrumented conductor.
 *
 * The cost-feed line is composed from its two halves rather than written as one
 * string, and the halves are exported (#117). Nothing about the *wording*
 * changed — {@link NO_COST_FEED_GAP} is character for character what it was —
 * but the strip needs to set the command apart from the sentence around it, so
 * that a click selects the thing you paste and not the apology in front of it.
 * A caveat an operator has to re-type by hand is a caveat that gets ignored.
 */
export const COST_FEED_COMMAND = 'eval "$(rhizomorph env <lane>)"'
export const NO_COST_FEED_LEAD = 'NO COST FEED (OTel) — dollars unavailable — run: '
export const NO_COST_FEED_GAP = `${NO_COST_FEED_LEAD}${COST_FEED_COMMAND}`
export const CONDUCTOR_NOT_INSTRUMENTED_GAP = 'CONDUCTOR NOT INSTRUMENTED — overhead ratio unknowable'

/** Locale pinned so the exact hover figure is identical on every machine. */
const EXACT_NUMBER = new Intl.NumberFormat('en-US')

function exactCount(value: number): string {
  return EXACT_NUMBER.format(Math.round(value))
}

/**
 * Ruling 11's "full precision on hover" for the output-tokens headline: the
 * exact count (an SI abbreviation like `1.2M` never says whether that was
 * 1,150,000 or 1,249,999) plus the four-tier breakdown the headline itself
 * leads but never hides.
 */
export function outputHoverTitle(tokens: TokenTotals): string {
  return `${exactCount(tokens.output)} output tokens exactly · ${formatTokenBreakdown(tokens)}`
}

/**
 * Dollars only ever render when the cost feed is authoritative (ruling 13) —
 * `null` here is the caller's cue to show {@link NO_COST_FEED_GAP} instead of
 * a number. `costIsAuthoritative === false` (a mixed/estimated read) still
 * renders — the honesty lives in the hover, not in hiding a real figure.
 */
export function formatDollarsOrGap(burn: Pick<Burn, 'costUsd' | 'costIsAuthoritative'>): string {
  if (burn.costIsAuthoritative === null) return NO_COST_FEED_GAP
  return formatUsd(burn.costUsd)
}

export function isDollarsGap(burn: Pick<Burn, 'costIsAuthoritative'>): boolean {
  return burn.costIsAuthoritative === null
}

export function dollarsHoverTitle(burn: Pick<Burn, 'costUsd' | 'costIsAuthoritative'>): string {
  const exact = `$${burn.costUsd.toFixed(6)} exactly`
  return burn.costIsAuthoritative === false
    ? `${exact} — includes an estimate, not fully authoritative`
    : `${exact} — authoritative dollar cost (OTel)`
}

/**
 * Burn rate: out-tok/min by default, $/hr once dollars are authoritative —
 * the direction's own ruling, not a preference for one unit over the other.
 */
export function formatBurnRate(
  burn: Pick<Burn, 'costIsAuthoritative' | 'costUsdPerHour' | 'outputPerMin'>,
): string {
  if (burn.costIsAuthoritative === true) return formatUsdPerHour(burn.costUsdPerHour)
  return `${formatTokens(burn.outputPerMin)} out-tok/min`
}

export function burnRateHoverTitle(
  burn: Pick<Burn, 'costIsAuthoritative' | 'costUsdPerHour' | 'outputPerMin'>,
): string {
  const rate = `${exactCount(burn.outputPerMin)} out-tok/min exactly`
  return burn.costIsAuthoritative === true
    ? `${rate} · $${burn.costUsdPerHour.toFixed(4)}/hr exactly`
    : rate
}

/**
 * Conductor OUTPUT ÷ worker OUTPUT (direction's own wording) — `burn.overheadRatio`
 * is already computed that way by `selectRoleSpend` (`packages/core/src/selectors/
 * spend.ts`); this only formats it and never recomputes the division. Gated on
 * `conductorInstrumented` (cost-event based, not token based) rather than on
 * `overheadRatio === null` alone: a conductor's tokens can appear via
 * `sessionlog --extra-sessions` with no cost telemetry behind them at all
 * (architecture.md's decisions log, issue #47), and that is the exact
 * "worse than absent" shape the gap voice exists to name instead of a number.
 */
export function formatOverheadOrGap(
  burn: Pick<Burn, 'conductorInstrumented' | 'overheadRatio'>,
): string {
  if (!burn.conductorInstrumented) return CONDUCTOR_NOT_INSTRUMENTED_GAP
  if (burn.overheadRatio === null) return 'unknown — no worker output yet'
  return `${burn.overheadRatio.toFixed(2)}×`
}

export function isOverheadGap(burn: Pick<Burn, 'conductorInstrumented'>): boolean {
  return !burn.conductorInstrumented
}

export function overheadHoverTitle(
  burn: Pick<Burn, 'conductorInstrumented' | 'overheadRatio'>,
): string {
  if (!burn.conductorInstrumented || burn.overheadRatio === null) {
    return 'conductor output tokens ÷ worker output tokens'
  }
  return `${burn.overheadRatio.toFixed(4)}× exactly — conductor ÷ worker output tokens`
}

/**
 * #159 — the burn strip's fifth figure (golden signals, operator ruling:
 * errors yes, latency no). `Burn`'s four error fields are optional only for a
 * pre-#159 fixture built outside this change's fence (see the interface's own
 * note); every real `buildFleet` result carries all four, and `?? 0` here is
 * what lets an older hand-built fixture still read as a calm zero rather than
 * throwing on `undefined`.
 */
export function errorCount(burn: Pick<Burn, 'errorCount'>): number {
  return burn.errorCount ?? 0
}

export function errorsHoverTitle(
  burn: Pick<Burn, 'errorCount' | 'errorBlockedCount' | 'errorParkedCount' | 'errorOffFenceCount'>,
): string {
  return (
    `${errorCount(burn)} exactly — ${burn.errorBlockedCount ?? 0} blocked, ` +
    `${burn.errorParkedCount ?? 0} parked, ${burn.errorOffFenceCount ?? 0} off-fence`
  )
}
