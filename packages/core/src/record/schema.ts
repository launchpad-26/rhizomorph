import { z } from 'zod'
import { nonEmptyString, timestampSchema } from '../events/common.js'
import { HEX_DIGEST_PATTERN } from './hash.js'

/**
 * The portable session record — prd11 ruling 3's federation wire format. One
 * file: a manifest naming who recorded it and when, plus the event log's own
 * lines verbatim, each wrapped in a hash-chain link. Schema-versioned from the
 * first field so a future format change has somewhere honest to land.
 */

export const RECORD_SCHEMA_VERSION = 1

const hexDigestSchema = z.string().regex(HEX_DIGEST_PATTERN, 'must be a 64-character lowercase hex SHA-256 digest')

/**
 * Who recorded this — the instance is the server session id that produced the
 * log (stable, minted once, the same identity `/api/meta` publishes); the
 * handle is a human-declared display name. `declared: false` means nobody
 * said so and this is just the OS username — an honest default, not a claim
 * of identity.
 */
export const actorSchema = z.object({
  instance: nonEmptyString,
  handle: nonEmptyString,
  declared: z.boolean(),
})
export type Actor = z.infer<typeof actorSchema>

export const manifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  repoSlug: nonEmptyString,
  actor: actorSchema,
  startTs: timestampSchema,
  endTs: timestampSchema,
  eventCount: z.number().int().nonnegative(),
  /** Where the body's hash chain closes. See `record/hash.ts` and `record/build.ts`. */
  chainDigest: hexDigestSchema,
  /**
   * Reserved for a future signature over `chainDigest`. Key infrastructure is
   * future work (prd11 ruling 3) — this field exists now so the format never
   * needs a breaking migration to grow one. Always `null` today; a value here
   * a stranger's emitter didn't produce should be a parse-time failure, not a
   * quietly ignored extra field, hence the strict literal rather than
   * `.optional()`.
   */
  signature: z.null(),
})
export type Manifest = z.infer<typeof manifestSchema>

/**
 * One event-log line, wrapped in its hash-chain link. `line` is the exact
 * JSONL text the session log holds for this event — no re-serialization, so a
 * record contains exactly what the log contains (prd11 ruling 7).
 */
export const recordLinkSchema = z.object({
  line: z.string(),
  /** The previous link's `hash`, or the chain's genesis for the first line. */
  prevHash: hexDigestSchema,
  hash: hexDigestSchema,
})
export type RecordLink = z.infer<typeof recordLinkSchema>

export const sessionRecordSchema = z.object({
  manifest: manifestSchema,
  body: z.array(recordLinkSchema),
})
export type SessionRecord = z.infer<typeof sessionRecordSchema>

export type ParseRecordResult =
  | { ok: true; record: SessionRecord }
  | { ok: false; error: string }

/** Parses an untrusted value (e.g. `JSON.parse`d file contents) into a `SessionRecord`. Never throws. */
export function parseRecord(value: unknown): ParseRecordResult {
  const result = sessionRecordSchema.safeParse(value)
  if (!result.success) {
    return { ok: false, error: result.error.message }
  }
  return { ok: true, record: result.data }
}
