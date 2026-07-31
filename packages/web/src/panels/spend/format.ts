import type { LaneSpend, ObservatoryEvent, RoleSpend } from '@observatory/core'

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

export type CostFields = Pick<RoleSpend, 'costUsd' | 'costEventCount' | 'costIsAuthoritative'>

export interface CostOverhead {
  /**
   * False when the conductor has never sent a `llm.cost` event. A conductor's
   * *tokens* can still show up in this state — `sessionlog --extra-sessions`
   * tags a whole directory `role: conductor` with no dollars attached — so
   * this is checked from `costEventCount`, never from token totals, or that
   * token-only contamination would masquerade as a real ratio.
   */
  conductorInstrumented: boolean
  /** Conductor `costUsd` ÷ worker `costUsd`. Null when either side has no cost. */
  ratio: number | null
  /** True when either side's dollars include a pricing-table estimate. */
  mixedProvenance: boolean
}

/**
 * prd1's headline overhead metric — on cost, never tokens. See
 * `docs/architecture.md`'s Decisions log for why a token-derived ratio was
 * rejected: an un-instrumented conductor must render as a visible gap, not a
 * number computed from whatever happened to be lying around.
 */
export function selectCostOverhead(worker: CostFields, conductor: CostFields): CostOverhead {
  const conductorInstrumented = conductor.costEventCount > 0
  const mixedProvenance = worker.costIsAuthoritative === false || conductor.costIsAuthoritative === false
  if (!conductorInstrumented || worker.costUsd <= 0) {
    return { conductorInstrumented, ratio: null, mixedProvenance }
  }
  return { conductorInstrumented, ratio: conductor.costUsd / worker.costUsd, mixedProvenance }
}

/** An un-instrumented conductor renders as an actionable gap, never `0.00×`. */
export function formatCostOverhead(overhead: CostOverhead): string {
  if (!overhead.conductorInstrumented) {
    return 'conductor not instrumented — see docs/telemetry.md'
  }
  if (overhead.ratio === null) return 'unknown — no worker cost yet'
  const suffix = overhead.mixedProvenance ? ' (incl. estimate)' : ''
  return `overhead ${overhead.ratio.toFixed(2)}×${suffix}`
}

/**
 * A single role's or lane's own dollar figure. `costEventCount === 0` means no
 * `llm.cost` event has ever named it — the same gap `formatCostOverhead` guards
 * against, just at the row level instead of the headline. Without this check a
 * conductor row would print the real zero `formatUsd(0)` gives, sitting right
 * next to a headline that just said "not instrumented" — the two would
 * contradict each other in the same panel.
 */
export function formatCostOrGap(cost: Pick<CostFields, 'costUsd' | 'costEventCount'>): string {
  return cost.costEventCount === 0 ? 'no cost data' : formatUsd(cost.costUsd)
}

/**
 * The root working tree is `unattributed` (#62) until the operator claims it
 * — never silently filed as worker spend. `null` (no `unattributed` lane at
 * all, or one that has recorded nothing) means there is no gap to report;
 * a real one always names the exact fix, never just a number.
 */
export function formatUnattributedGap(
  lane: Pick<LaneSpend, 'tokens' | 'requestCount' | 'toolCallCount'> | null,
): string | null {
  if (lane === null) return null
  const hasSpend = lane.tokens.total > 0 || lane.requestCount > 0 || lane.toolCallCount > 0
  if (!hasSpend) return null
  return (
    `${formatTokens(lane.tokens.total)} tokens unattributed — claim with ` +
    `--extra-sessions <dir>:<lane> or observatory env`
  )
}

/**
 * Every export this Observatory has refused (#60) since it started, summed
 * from the raw event log rather than a selector — `telemetry.refused` is a
 * setup gap the reducer deliberately leaves out of every spend total.
 */
export function selectRefusedCount(events: readonly ObservatoryEvent[]): number {
  return events.reduce(
    (sum, event) => (event.type === 'telemetry.refused' ? sum + event.payload.count : sum),
    0,
  )
}

/** `null` when nothing has ever been refused — there is nothing to warn about. */
export function formatRefusalGap(refusedCount: number): string | null {
  if (refusedCount <= 0) return null
  return `${refusedCount} post${refusedCount === 1 ? '' : 's'} refused from unknown instance`
}
