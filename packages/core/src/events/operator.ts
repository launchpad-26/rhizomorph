import { z } from 'zod'
import { envelope, nonEmptyString } from './common.js'

/**
 * prd17 ruling 1 — the operator's own hand. Today the only "decision" the
 * record carries anywhere is a span field on `trace.ts:174`, and that is a
 * tool-blocked-on-user signal, not an operator act. These three are what make
 * "a human clicked approve" reconstructible: who decided, when, and — the
 * requirement the issue's Definition of done states verbatim — SEEING WHAT.
 *
 * `source: 'operator'` is a new member of `eventSourceSchema` (`common.ts`):
 * the operator is a real, distinct actor the record needs to name, the same
 * way `'gate'` names the landing instrument in `gate.ts`'s doc comment.
 */

/**
 * Fields every operator act shares. `sessionId` and `offset` together are the
 * load-bearing pair: they say what the operator was looking at, not merely
 * that they decided and when.
 *
 * **`offset` is a LINE index into the record, not a fold count, and that
 * distinction was ruled after review (operator, 2026-09-04).** The first draft
 * defined it as `SessionState.eventCount`, which cannot locate anything for two
 * independent reasons. `reduce()` swaps in a fresh state when `opensNewSession`
 * fires (`../reduce.ts`), so the count restarts mid-stream and two acts in one
 * log can carry the same offset. And `eventCount` counts events the reducer
 * FOLDED — `record/read.ts` and `eras/fold.ts` drop era-gap lines — so a log
 * containing one line a reader does not understand yields a different count in
 * this era than in the next, and the act drifts. A line index has neither
 * property: it counts what is written, which is the one thing that does not
 * change when the reader does.
 *
 * `sessionId` is required rather than optional because a line index is only
 * unique within one record. `session.closed` (`./system.ts`) — the one family
 * from this same ruling that already landed — carries `eventCount` AND
 * `sessionId` for exactly this reason, and is the in-repo precedent.
 */
const operatorActBaseSchema = z.object({
  /** The session whose record {@link offset} indexes. Required: a line index is unique only within one record. */
  sessionId: nonEmptyString,
  /** Zero-based LINE index into that session's record — the line the operator had read up to. Not a fold count; see above. */
  offset: z.number().int().nonnegative(),
  /** What the decision concerns — a lane handle, an issue number as a string, a PR handle. */
  subject: nonEmptyString,
  /** The operator's own identity, when the emitter knows it. */
  by: nonEmptyString.optional(),
})

export const operatorAckPayloadSchema = operatorActBaseSchema
export type OperatorAckPayload = z.infer<typeof operatorAckPayloadSchema>

/**
 * `verdict` is an open string, not a closed enum: this issue defines the act
 * ("the operator decided"), not the final vocabulary of decisions, and this
 * family's shape can never change once shipped (issue DoD: additive only) — a
 * closed enum would have to guess every future outcome right today.
 */
export const operatorVerdictPayloadSchema = operatorActBaseSchema.extend({
  verdict: nonEmptyString,
})
export type OperatorVerdictPayload = z.infer<typeof operatorVerdictPayloadSchema>

/**
 * Unlike `dispatch.brief` and `gate.verdict` (`gate.ts`), a note is NOT
 * sidecar'd: the operator's own words here are the whole point of the event,
 * not a large or reused artifact something else already owns a copy of.
 */
export const operatorNotePayloadSchema = operatorActBaseSchema.extend({
  text: nonEmptyString,
})
export type OperatorNotePayload = z.infer<typeof operatorNotePayloadSchema>

export const operatorAckEventSchema = envelope('operator', 'operator.ack', operatorAckPayloadSchema)
export const operatorVerdictEventSchema = envelope(
  'operator',
  'operator.verdict',
  operatorVerdictPayloadSchema,
)
export const operatorNoteEventSchema = envelope('operator', 'operator.note', operatorNotePayloadSchema)

export const operatorEventSchemas = [
  operatorAckEventSchema,
  operatorVerdictEventSchema,
  operatorNoteEventSchema,
] as const
