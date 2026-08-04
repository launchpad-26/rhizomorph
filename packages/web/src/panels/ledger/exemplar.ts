import { totalTokens, type SessionState } from '@rhizomorph/core'

/**
 * #159 — THE EXEMPLAR JUMP (Grafana's exemplars, our data already joins):
 * per-lane spend and OTel trace spans already both exist in `state.traces`;
 * this is the bridge, not a new source. `llm_request` is the only span kind
 * that carries tokens at all (prd9 ruling 4), so "heaviest" is unambiguous —
 * the request that moved the most tokens, all four tiers, in this lane's
 * whole trace history.
 *
 * One pass over `state.traces.spans`, keyed by lane, rather than a per-row
 * scan: the ledger has one row per branch and this is read once for the
 * whole table, the same shape `buildFleet.ts`'s own `latestSpanTsByLane`
 * takes over the same array.
 */
export interface ExemplarSpan {
  traceId: string
  spanId: string
  /** Sum of all four token tiers — what "heaviest" is measured by. */
  tokens: number
  startTs: number
}

/**
 * Every lane's own heaviest `llm_request` span, keyed by `span.lane` (the
 * telemetry handle the trace layer attributes spans to — the same identity
 * `drawer/index.tsx`'s own `TraceSection` reads a lane by). A lane absent
 * from the map has no `llm_request` span at all: the honest gap that keeps
 * the ledger's exemplar affordance from rendering for a row with nothing
 * behind it.
 */
export function heaviestLlmRequestSpanByLane(state: SessionState): Map<string, ExemplarSpan> {
  const byLane = new Map<string, ExemplarSpan>()
  for (const span of state.traces.spans) {
    if (span.kind !== 'llm_request' || span.tokens === null) continue
    const tokens = totalTokens(span.tokens)
    const current = byLane.get(span.lane)
    if (current === undefined || tokens > current.tokens) {
      byLane.set(span.lane, { traceId: span.traceId, spanId: span.spanId, tokens, startTs: span.startTs })
    }
  }
  return byLane
}

/**
 * A branch row's own exemplar, tried under every key `state.traces.spans`
 * might have filed it under: the branch name itself, then each telemetry
 * identity `BranchSpend.lanes` names — the same id → branch → every-handle
 * fallback order `buildFleet.ts`'s own `spanTsByHandle` lookups already use,
 * because a span's `lane` field is the raw telemetry handle and a branch can
 * be fed by a handle that never matches its own name.
 */
export function exemplarForBranch(
  byLane: ReadonlyMap<string, ExemplarSpan>,
  branch: string,
  lanes: readonly string[],
): ExemplarSpan | null {
  const direct = byLane.get(branch)
  if (direct !== undefined) return direct
  for (const lane of lanes) {
    const found = byLane.get(lane)
    if (found !== undefined) return found
  }
  return null
}
