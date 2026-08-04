import { z } from 'zod'
import { nonEmptyString, timestampSchema } from './common.js'

/**
 * prd11 ruling 6b, phase 1 — the semantic judge's structural organ (research
 * `docs/research/2026-08-04-semantic-judge-spike.md`, verdict §1): symbol-name
 * overlap across two lanes' diffs, or a speculative `git merge-tree` conflict
 * between them. Deterministic, free, and pure selector logic over read-only
 * git plumbing — no model call, no operator ruling, and no summons. This
 * phase is the ladder's first rung ONLY (research §3): every finding is
 * logged, never surfaced.
 */

export const judgeFindingKindSchema = z.enum(['symbol-overlap', 'speculative-conflict'])
export type JudgeFindingKind = z.infer<typeof judgeFindingKindSchema>

/**
 * Evidence a finding must carry, verbatim and inspectable — the spike's
 * "never a bare claim" rule (research §4), enforced at the schema boundary
 * rather than left to a careful caller. Which slot is populated matches
 * {@link JudgeFindingKind}: symbol names for a `symbol-overlap` finding, the
 * files `git merge-tree` reported conflicting for a `speculative-conflict`
 * one — see {@link judgeFindingPayloadSchema}'s refinement below.
 */
export const judgeEvidenceSchema = z.object({
  symbols: z.array(nonEmptyString).optional(),
  conflictingFiles: z.array(nonEmptyString).optional(),
})
export type JudgeEvidence = z.infer<typeof judgeEvidenceSchema>

/**
 * Two distinct branch names in ascending order — the same canonical-pair rule
 * `selectCollisionPairs` already applies (core's `selectors/collisions.ts`
 * sorts a pair's branches), so two findings about the same pair of lanes are
 * always structurally identical regardless of which lane the organ happened
 * to compare first.
 */
const judgeLanesSchema = z
  .tuple([nonEmptyString, nonEmptyString])
  .refine(([a, b]) => a !== b && a < b, {
    message: 'lanes must be two distinct branch names in ascending order',
  })
export type JudgeLanes = z.infer<typeof judgeLanesSchema>

/**
 * `severity` is locked to `'log'` — the alert ladder's silent first rung
 * (research §3, rung 1) — on purpose: this phase never summons. Rungs 2-4
 * (NOTICE, NEEDS-YOU, the coalescing budget) are future work, gated on the
 * spike's §6 replay experiment; the schema itself is what stops a future
 * caller from skipping the rung by accident rather than a convention someone
 * has to remember.
 */
export const judgeFindingPayloadSchema = z
  .object({
    kind: judgeFindingKindSchema,
    lanes: judgeLanesSchema,
    evidence: judgeEvidenceSchema,
    severity: z.literal('log'),
    /** When the organ decided this — its own clock, not necessarily the envelope's `ts`. */
    detectedAt: timestampSchema,
  })
  .refine(
    (payload) =>
      payload.kind === 'symbol-overlap'
        ? (payload.evidence.symbols?.length ?? 0) > 0
        : (payload.evidence.conflictingFiles?.length ?? 0) > 0,
    { message: 'evidence must carry at least one item matching its kind — never a bare claim' },
  )
export type JudgeFindingPayload = z.infer<typeof judgeFindingPayloadSchema>

/**
 * Hand-built rather than via `envelope()`: that helper's `source` generic is
 * bound to `EventSource` (`events/common.ts`), and this issue's fence
 * (#152) doesn't extend to that file. `'judge'` is a genuinely new collector
 * source — unlike `'lab'` (`events/lab.ts`), the judge organ IS a polled
 * collector, so leaving it out of `eventSourceSchema` is a fence-scoped
 * stand-in rather than a design choice. `index.ts`'s `EVENT_SOURCE_BY_TYPE`
 * widens its `satisfies` clause by exactly this one literal, the same way it
 * already does for `'lab'`; folding `'judge'` into `eventSourceSchema` itself
 * is left to whichever lane's fence covers `events/common.ts` next.
 */
export const judgeFindingEventSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: z.literal('judge'),
  type: z.literal('judge.finding'),
  payload: judgeFindingPayloadSchema,
})

export const judgeEventSchemas = [judgeFindingEventSchema] as const
