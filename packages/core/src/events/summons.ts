import { z } from 'zod'
import { envelope, nonEmptyString, timestampSchema } from './common.js'

/**
 * prd17 ruling 1 — the summons pair. The record's missing alarm: without it,
 * summons precision, time-in-alarm, flood and chattering (the exact vocabulary
 * ISA-18.2 audits an alarm system on) are uncomputable, because the record
 * never says an alarm condition existed at all.
 *
 * `lane` and `kind` together are the alarm point — the same pair a raise and
 * its clear share is how a later fold (not this issue's scope) will match
 * them up. Neither schema references the other: a raise and a clear are each
 * independently valid, on purpose (see the sibling-case note on
 * `summonsClearedPayloadSchema` below). `kind` is an open string rather than a
 * closed enum — this issue defines the family, not its final vocabulary of
 * alarm conditions, and a closed enum would have to be exhaustive on day one
 * to avoid becoming the next thing that can't change shape.
 */

export const summonsRaisedPayloadSchema = z.object({
  /** The lane or session this summons concerns. */
  lane: nonEmptyString,
  /** The alarm condition, e.g. `'awaiting-reply'`, `'stalled'` — open vocabulary. */
  kind: nonEmptyString,
  /** When the underlying condition began, which may predate the envelope `ts` if detection coalesces. */
  raisedAt: timestampSchema,
  detail: z.string().optional(),
})
export type SummonsRaisedPayload = z.infer<typeof summonsRaisedPayloadSchema>

/**
 * The other half of the pair. Deliberately carries no reference to the raise
 * it clears, and validates with no knowledge of whether one ever happened:
 * a clear with no preceding raise is a real state of the world — a session
 * can end mid-alarm — and a schema that assumed pairing would lie the first
 * time that happened. Matching a clear to its raise, if anything ever needs
 * to, is a fold-time question over `(lane, kind)`, not a schema-time one.
 */
export const summonsClearedPayloadSchema = z.object({
  lane: nonEmptyString,
  kind: nonEmptyString,
  clearedAt: timestampSchema,
})
export type SummonsClearedPayload = z.infer<typeof summonsClearedPayloadSchema>

export const summonsRaisedEventSchema = envelope('gate', 'summons.raised', summonsRaisedPayloadSchema)
export const summonsClearedEventSchema = envelope('gate', 'summons.cleared', summonsClearedPayloadSchema)

export const summonsEventSchemas = [summonsRaisedEventSchema, summonsClearedEventSchema] as const
