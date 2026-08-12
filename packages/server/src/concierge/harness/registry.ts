import { claudeAdapter } from './claude.js'
import { codexAdapter } from './codex.js'
import { declaredAdapters } from './not-implemented.js'
import type { DetectOptions, HarnessAdapter, HarnessDetection, HarnessId } from './types.js'

/**
 * The harness registry — prd-20 ruling 4, "built for N, claude first-class".
 *
 * ## The order is alphabetical, and that is load-bearing
 *
 * ADR-0010 rejected the ranked tier list and superseded its framing: the ladder
 * is **named, not ranked**. "claude is better than codex" is not a fact this
 * code may encode, so the registry sorts by the only property that carries no
 * judgement — the spelling of the id. claude coming first is an accident of the
 * alphabet, not a verdict, and `harness-law.test.ts` asserts both that the
 * order is alphabetical and that no adapter carries a rank, tier, score or
 * preference field for anything to sort on.
 *
 * "claude first-class" in the ruling is a statement about *implementation
 * depth* — it is the harness whose four members are all proven — not a claim
 * that it is the better tool. That distinction is exactly what ADR-0010 says
 * ranking destroys: it encodes "our setup is the real one and yours is
 * degraded" into the type system, which is untrue and unhelpful to an operator
 * with a working setup.
 *
 * A caller that wants to present these makes its own ordering decision
 * explicitly, in the UI, where a human can see it — not by inheriting one from
 * this array and mistaking it for a fact.
 *
 * ## Nothing imports this yet
 *
 * The concierge namespace law's declared-importer set is empty and a test
 * asserts it stays empty. The first route to reach this module is #263's,
 * gated on #234 (prd-20 ruling 2). This registry is built before it is wired,
 * which is what fencing a hand before it exists means.
 */
export const HARNESS_ADAPTERS: readonly HarnessAdapter[] = [claudeAdapter, codexAdapter, ...declaredAdapters].sort(
  (left, right) => left.id.localeCompare(right.id),
)

/** The adapter for an id, or `undefined`. No fallback: guessing which harness was meant is not this seam's business. */
export function harnessById(id: HarnessId): HarnessAdapter | undefined {
  return HARNESS_ADAPTERS.find((adapter) => adapter.id === id)
}

/**
 * Detect every harness at once.
 *
 * Runs the adapters concurrently because they are independent reads, and
 * returns them in {@link HARNESS_ADAPTERS} order — which is to say
 * alphabetically, which is to say in no order at all.
 */
export function detectAll(options: DetectOptions = {}): Promise<HarnessDetection[]> {
  return Promise.all(HARNESS_ADAPTERS.map((adapter) => adapter.detect(options)))
}
