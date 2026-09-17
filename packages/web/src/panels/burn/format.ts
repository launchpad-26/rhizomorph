import type { TokenTotals } from '@rhizomorph/core'
import type { DisclosureContent } from '../../disclosure/index.js'
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

/**
 * The dollars cell's disclosure when there is no feed at all (#220).
 *
 * The remedy carries {@link COST_FEED_COMMAND} in `remedy.command` rather than
 * folded into the prose, which is what `DisclosureLines` keeps apart so a card
 * that can offer a copy affordance has something to copy — the same reason
 * #117 split the gap line into its two halves in the first place. A caveat an
 * operator has to re-type by hand is a caveat that gets ignored.
 */
export function dollarsGapDisclosure(): DisclosureContent {
  return {
    label: '$',
    why: {
      reason: 'no authoritative cost feed — dollars are unavailable, not zero',
      evidence: { fact: 'no OTel cost event has arrived this session', elapsedMs: 0 },
    },
    remedy: {
      kind: 'action',
      action: 'export the agent CLI\'s OTel settings into the lane, then restart it',
      command: COST_FEED_COMMAND,
    },
  }
}

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
export function outputHoverDisclosure(tokens: TokenTotals): DisclosureContent {
  return {
    label: 'out',
    why: {
      reason: 'output tokens this session has produced',
      evidence: {
        fact: `${exactCount(tokens.output)} exactly · ${formatTokenBreakdown(tokens)}`,
        // Zero, in core's own register for a continuously-true fact
        // (`selectors/condition.ts`): the burn strip re-reads the fold on every
        // tick, so the figure was confirmed just now. It is not a claim that
        // nothing has happened since.
        elapsedMs: 0,
      },
    },
    remedy: { kind: 'none', because: 'a token count is a reading, not a condition' },
  }
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

export function dollarsHoverDisclosure(burn: Pick<Burn, 'costUsd' | 'costIsAuthoritative'>): DisclosureContent {
  const exact = `$${burn.costUsd.toFixed(6)} exactly`
  const estimated = burn.costIsAuthoritative === false
  return {
    label: '$',
    why: {
      reason: estimated ? 'includes an estimate — not fully authoritative' : 'authoritative dollar cost',
      evidence: {
        fact: estimated ? `${exact}, priced partly from a vendored table` : `${exact}, reported by the agent CLI itself (OTel)`,
        elapsedMs: 0,
      },
    },
    remedy: estimated
      ? { kind: 'none', because: 'an estimate is the best figure this session has — the strip says so rather than rounding it into a fact' }
      : { kind: 'none', because: 'the figure comes from the CLI itself; there is nothing better to reach for' },
  }
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

export function burnRateHoverDisclosure(
  burn: Pick<Burn, 'costIsAuthoritative' | 'costUsdPerHour' | 'outputPerMin'>,
): DisclosureContent {
  const rate = `${exactCount(burn.outputPerMin)} out-tok/min exactly`
  return {
    label: 'rate',
    why: {
      reason: 'how fast this session is producing',
      evidence: {
        fact:
          burn.costIsAuthoritative === true
            ? `${rate} · $${burn.costUsdPerHour.toFixed(4)}/hr exactly`
            : rate,
        elapsedMs: 0,
      },
    },
    remedy: { kind: 'none', because: 'a rate is a reading, not a condition' },
  }
}

/**
 * Conductor OUTPUT ÷ worker OUTPUT (direction's own wording) — `burn.overheadRatio`
 * is already computed that way by `selectRoleSpend` (`packages/core/src/selectors/
 * spend.ts`); this only formats it and never recomputes the division. Gated on
 * `conductorInstrumented` (cost-event based, not token based) rather than on
 * `overheadRatio === null` alone: a conductor's tokens can appear via
 * a discovered conductor session with no cost telemetry behind it at all
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

export function overheadHoverDisclosure(
  burn: Pick<Burn, 'conductorInstrumented' | 'overheadRatio'>,
): DisclosureContent {
  if (!burn.conductorInstrumented) {
    return {
      label: 'overhead',
      why: {
        reason: CONDUCTOR_NOT_INSTRUMENTED_GAP,
        evidence: { fact: 'no cost telemetry has arrived for the conductor at all', elapsedMs: 0 },
      },
      remedy: {
        kind: 'action',
        action: "instrument the conductor, and this reads a ratio instead of a gap — its burn is unknown, not zero",
      },
    }
  }
  if (burn.overheadRatio === null) {
    return {
      label: 'overhead',
      why: {
        reason: 'no worker output yet, so there is nothing to divide',
        evidence: { fact: 'conductor output tokens ÷ worker output tokens', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'this resolves itself as soon as a worker produces its first output token' },
    }
  }
  return {
    label: 'overhead',
    why: {
      reason: 'what the conductor costs against what the workers produce',
      evidence: {
        fact: `${burn.overheadRatio.toFixed(4)}× exactly — conductor ÷ worker output tokens`,
        elapsedMs: 0,
      },
    },
    remedy: { kind: 'none', because: 'a ratio is a reading, not a condition' },
  }
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

export function errorsHoverDisclosure(
  burn: Pick<Burn, 'errorCount' | 'errorBlockedCount' | 'errorParkedCount' | 'errorOffFenceCount'>,
): DisclosureContent {
  const total = errorCount(burn)
  return {
    label: 'errors',
    why: {
      reason: total === 0 ? 'nothing in the fleet is erring' : 'lanes the fleet is counting as erring',
      evidence: {
        fact:
          `${total} exactly — ${burn.errorBlockedCount ?? 0} blocked, ` +
          `${burn.errorParkedCount ?? 0} parked, ${burn.errorOffFenceCount ?? 0} off-fence`,
        elapsedMs: 0,
      },
    },
    remedy:
      total === 0
        ? { kind: 'none', because: 'a calm count is still a claim, and this is its evidence — nothing to act on' }
        : { kind: 'action', action: 'open the lanes counted above; the fleet table names which they are' },
  }
}
