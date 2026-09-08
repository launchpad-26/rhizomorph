import type { DisclosureContent } from '../disclosure/index.js'
import { totalTokens, type TokenUsagePayload } from '@rhizomorph/core'
import { formatSpan } from '../fleet/index.js'
import { formatTokenBreakdown, formatTokens } from '../lib/format.js'

/**
 * Every figure in the trace surfaces goes through the app's one formatting
 * module rather than a second copy of it. `formatSpan` is the app's only
 * duration formatter (ages, elapsed time, wait time) and is what "ttft" reads
 * through too — there is no dedicated sub-second formatter anywhere else in
 * the dashboard, and inventing one here would be exactly the second visual
 * language the brief rules out.
 */
export { formatSpan }

/** The output-led headline a root row and an `llm_request` row both show. */
export function tokenHeadline(tokens: TokenUsagePayload): string {
  return formatTokens(tokens.output)
}

/**
 * The four-tier breakdown behind an interaction's token headline (#220 — this
 * was the `title=` tooltip). `TokenUsagePayload` (what a span carries) has no
 * `total` field — selectors never compute one, per prd9 ruling 4 — so it is
 * added here, for display only, from the same `totalTokens` helper the money
 * layer already uses.
 *
 * `elapsedMs: 0` because a recorded interaction's token counts do not age at
 * the reading position: they are what the span carries, re-read whenever the
 * tree renders. Core's `selectors/condition.ts` states the same rule for its
 * own continuously-true facts.
 */
export function tokenDisclosure(tokens: TokenUsagePayload): DisclosureContent {
  return {
    label: 'tokens',
    why: {
      reason: 'the four-tier breakdown behind this interaction\'s headline figure',
      evidence: { fact: formatTokenBreakdown({ ...tokens, total: totalTokens(tokens) }), elapsedMs: 0 },
    },
    remedy: { kind: 'none', because: 'a token breakdown is a reading, not a condition' },
  }
}
