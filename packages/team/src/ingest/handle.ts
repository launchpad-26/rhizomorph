import { parseIngestRequest } from '@rhizomorph/core/src/wire/index.js'
import type { Journal } from '../journal/journal.js'
import type { IngestFaults } from './faults.js'

/**
 * ORDERING 1, THE ACK (prd-51 ruling 4).
 *
 * ```
 * validate -> build the journal record -> writeSync -> fsyncSync
 *          -> THEN notify the fold queue -> THEN send 202
 * ```
 *
 * A 4xx never touches the journal. A write or an fsync that throws never sends
 * a 202. Both clauses are tested with a fault injected at that exact point
 * (`faults.ts`), and the strongest assertion is the whole ordering as one
 * array: an exact-array `toEqual` on the trace tape fails under **any**
 * reordering, including the reversal whose executed mutation loses exactly one
 * batch per process death.
 *
 * This function is pure of transport. It takes a decoded body and returns a
 * status and a body; `../api/http.ts` is the ~50 lines that turn that into an
 * HTTP response. That split is what lets the fault-point harness assert "no 202
 * was produced" without standing up a socket.
 *
 * **Protocol v1 is consumed, not re-declared.** `parseIngestRequest` lives in
 * `packages/core/src/wire/protocol.ts` and its refusal messages are returned
 * verbatim, so a second envelope schema written here would be visible as a
 * changed error string rather than as a silent fork.
 */

/** The header the shipper authenticates with. Its VALUE is not verified here — see {@link handleIngest}. */
export const INGEST_KEY_HEADER = 'x-rz-ingest-key'

export interface IngestDeps {
  readonly journal: Journal
  /** Wakes the fold worker. Called AFTER the fsync and BEFORE the 202, and exactly once per accepted batch. */
  readonly notify: (seq: number) => void
  readonly faults?: IngestFaults | undefined
  readonly trace?: ((step: string) => void) | undefined
  readonly now?: (() => number) | undefined
}

export interface IngestResponse {
  readonly status: number
  readonly body: unknown
}

/**
 * One ingest request, as a status and a body.
 *
 * `ingestKey` is the request's `x-rz-ingest-key` header. A missing or empty one
 * is a 401 naming the header. **The value is deliberately not verified**: key
 * issuance and membership are wave 4's, and a build that pretended to check
 * would be worse than one that says it does not. The gap is loud — a test
 * asserts that an arbitrary non-empty key is accepted — rather than latent.
 */
export function handleIngest(deps: IngestDeps, body: unknown, ingestKey: string | undefined): IngestResponse {
  deps.trace?.('validate')

  if (ingestKey === undefined || ingestKey.trim() === '') {
    return {
      status: 401,
      body: {
        error: `no ${INGEST_KEY_HEADER} header on the request; a shipper authenticates every batch with one. The key's VALUE is not verified by this build — membership and key issuance arrive in prd-51 wave 4.`,
      },
    }
  }

  const parsed = parseIngestRequest(body)
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error } }
  }

  try {
    const appended = deps.journal.append({
      project: parsed.request.project,
      actorInstance: parsed.request.actorInstance,
      batch: parsed.request.batch,
      receivedAtMs: (deps.now ?? Date.now)(),
    })

    deps.notify(appended.seq)
    deps.trace?.('notify')
    deps.faults?.afterNotifyBeforeRespond?.()

    deps.trace?.('respond:202')
    return { status: 202, body: { accepted: parsed.request.batch.length, journalSeq: appended.seq } }
  } catch (cause) {
    // Everything from `append` onwards. A failure BEFORE the fsync means the
    // batch is not durable and the shipper must retry; a failure AFTER it means
    // the batch IS durable and the retry will dedup. The server cannot tell the
    // shipper which, and must not guess — both are a 500 and both are safe,
    // because ruling 4's dedup makes a redundant retry cost time, not rows.
    return {
      status: 500,
      body: { error: `ingest failed before it could acknowledge: ${cause instanceof Error ? cause.message : String(cause)}` },
    }
  }
}
