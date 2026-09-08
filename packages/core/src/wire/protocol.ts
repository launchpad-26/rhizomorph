import { z } from 'zod'
import { nonEmptyString } from '../events/common.js'

/**
 * THE WIRE — protocol v1's request and response envelopes (ADR-0033, prd-51
 * ruling 3).
 *
 * ```
 * POST /v1/rhizomorph/ingest            x-rz-ingest-key: rzk_…
 * { protocolVersion: 1, project, actorInstance, batch: [ { n, line } … ] }
 * 202 { accepted, journalSeq }          only after the journal write is durable
 * ```
 *
 * Two things this module is deliberately NOT: it is not a client, and it is
 * not a server. It is the shape both sides agree on, in `packages/core` so
 * neither can own it. There is no `node:*` here, no `Buffer`, and no
 * dependency beyond zod (ADR-0003) — ruling 3's word "Buffer" means raw bytes,
 * and in core that is `Uint8Array` (see `split.ts`).
 *
 * **The key is `(project, actorInstance, n)` and `n` is a ledger position.**
 * The briefed design keyed the wire on the event id; executed against a real
 * ledger that silently discarded 74.5 % of it, because event ids restart on
 * session resume (`docs/research/2026-08-28-shared-record-s2-shipper.md`,
 * §schema defect). Nothing in this module reads or exposes an event id, and
 * `no-event-id-key-law.test.ts` holds that as a grep law over these sources.
 */

/** The only protocol version this build speaks. A request naming another is refused by name. */
export const PROTOCOL_VERSION = 1

/** A line's 1-based position in the source ledger. Never an event id, never an array index. */
export const ledgerPositionSchema = z.number().int().positive()

/**
 * What dedup and ordering key on, server-side. The lossless invariant is *no
 * gaps and no duplicates in `n`* for one `(project, actorInstance)` pair;
 * arrival order is not an invariant, because a legitimate gap repair violates
 * it (ADR-0033).
 */
export const ledgerKeySchema = z.object({
  project: nonEmptyString,
  actorInstance: nonEmptyString,
  n: ledgerPositionSchema,
})
export type LedgerKey = z.infer<typeof ledgerKeySchema>

/** One line of one actor's ledger, at its position. `line` is what `buildRecord` would serialize — see `reserialize.ts`. */
export const ingestBatchEntrySchema = z.object({
  n: ledgerPositionSchema,
  line: nonEmptyString,
})
export type IngestBatchEntry = z.infer<typeof ingestBatchEntrySchema>

export const ingestRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  project: nonEmptyString,
  actorInstance: nonEmptyString,
  batch: z.array(ingestBatchEntrySchema).min(1),
})
export type IngestRequest = z.infer<typeof ingestRequestSchema>

/** The 202. It means the batch is in a durable journal — anything less is a lie about durability (ADR-0033). */
export const ingestAcceptedSchema = z.object({
  accepted: z.number().int().nonnegative(),
  journalSeq: z.number().int().nonnegative(),
})
export type IngestAccepted = z.infer<typeof ingestAcceptedSchema>

export type ParseIngestRequestResult =
  | { ok: true; request: IngestRequest }
  | { ok: false; error: string }

export type ParseIngestAcceptedResult =
  | { ok: true; response: IngestAccepted }
  | { ok: false; error: string }

/**
 * Parses an untrusted value (a decoded request body) into an
 * {@link IngestRequest}. Never throws — the result shape follows `parseRecord`
 * and `parseEvent`: a named payload field, and an error string a human can act
 * on.
 *
 * **The order of the checks is part of the contract, and it is a test case.**
 * The version is answered BEFORE the body's shape, so a future request whose
 * body also differs still gets told which version this build speaks rather
 * than a field complaint about a field it was never going to send.
 *
 * 1. Not an object → say what arrived.
 * 2. No `protocolVersion` → name the version this build speaks.
 * 3. A `protocolVersion` other than {@link PROTOCOL_VERSION} → name both, and
 *    state the remedy. Ruling 3 says a server refuses a version it does not
 *    speak *by name, with the remedy stated*.
 * 4. The shape.
 * 5. A repeated `n` inside one batch.
 *
 * Step 5 is this module's own decision rather than something ADR-0033 wrote,
 * so the reason is here: ruling 4 dedups *across* batches with
 * `ON CONFLICT DO NOTHING`, which makes a replayed batch free. A duplicate
 * *inside* one batch is a different thing — it makes the `accepted` count in
 * the 202 ambiguous (does 500 mean 500 positions or 500 entries?), and it can
 * only be a shipper defect. Refusing it is cheap and it never fires against a
 * correct shipper. Ordering within a batch is deliberately NOT constrained.
 */
export function parseIngestRequest(value: unknown): ParseIngestRequestResult {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: `not an ingest request: expected an object, got ${typeof value}` }
  }

  const saw = (value as { protocolVersion?: unknown }).protocolVersion
  if (typeof saw !== 'number') {
    return {
      ok: false,
      error: `no protocolVersion on the request; this build speaks protocol version ${PROTOCOL_VERSION}. Send { protocolVersion: ${PROTOCOL_VERSION}, … }.`,
    }
  }
  if (saw !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `protocol version ${saw} is not spoken by this build, which speaks version ${PROTOCOL_VERSION}. Upgrade whichever side is older — a shipper and a team server must speak the same protocol version.`,
    }
  }

  const result = ingestRequestSchema.safeParse(value)
  if (!result.success) {
    return { ok: false, error: result.error.message }
  }

  const seen = new Set<number>()
  for (const entry of result.data.batch) {
    if (seen.has(entry.n)) {
      return { ok: false, error: `batch repeats n=${entry.n}; every n in a batch must be distinct` }
    }
    seen.add(entry.n)
  }

  return { ok: true, request: result.data }
}

/** Parses a server's 202 body. Never throws. The shipper reads this to decide whether the batch is durable. */
export function parseIngestAccepted(value: unknown): ParseIngestAcceptedResult {
  const result = ingestAcceptedSchema.safeParse(value)
  if (!result.success) {
    return { ok: false, error: result.error.message }
  }
  return { ok: true, response: result.data }
}
