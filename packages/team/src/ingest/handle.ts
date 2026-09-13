import { parseIngestRequest } from '@rhizomorph/core/src/wire/index.js'
import {
  type IngestKeyVerdict,
  ingestKeyRefusal,
  statusForIngestKeyRefusal,
} from '../keys/verify.js'
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

/** The header the shipper authenticates with. Its value IS verified — see {@link handleIngest}. */
export const INGEST_KEY_HEADER = 'x-rz-ingest-key'

export interface IngestDeps {
  readonly journal: Journal
  /** Wakes the fold worker. Called AFTER the fsync and BEFORE the 202, and exactly once per accepted batch. */
  readonly notify: (seq: number) => void
  /**
   * RULING 8'S ROW FLAG, READ ONCE PER BATCH.
   *
   * *"revoked by a row flag checked **once per batch** — which bounds revocation
   * lag to one batch interval"*. This thunk is that check, and it is called
   * exactly once by {@link handleIngest}, inside `validate`, before a byte
   * reaches the journal.
   *
   * **It is resolved by the caller, not here.** {@link
   * import('../storage/contract.js').TeamStorage} is asynchronous and this
   * function is not: `../api/http.ts` calls it with no `await`, and turning that
   * ~50-line adapter into something that could is wave 7's single restructuring
   * of it. So `../api/main.ts` does the one row read per request and closes over
   * its result; `../keys/verify.ts`'s `resolveIngestKeyCheck` is the seam.
   *
   * Once per batch is the whole claim. Once per event would be waste; a verdict
   * memoised across batches would unbound the revocation lag the ruling bounds.
   *
   * **REQUIRED, not optional.** A build that can construct these deps without a
   * verifier is the gap this closes, one missing field away.
   */
  readonly checkKey: () => IngestKeyVerdict
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
 * is a 401 naming the header; the value is then **verified** against ruling 8's
 * keys table, through {@link IngestDeps.checkKey}.
 *
 * ## The order of the four refusals, and why the scope check is last
 *
 * Key verification is part of **validate** — a refused key never touches the
 * journal, and the tape for any refusal below ends at `validate`:
 *
 * 1. no header at all -> 401, naming the header.
 * 2. `checkKey()` -> `malformed` 401, `unknown` 401, `revoked` 403. The ONE call.
 * 3. `parseIngestRequest` -> 400, carrying core's own message verbatim.
 * 4. the key's project against the request's -> `wrong-project` 403.
 *
 * Three of the four run BEFORE the body is decoded, because they do not need it
 * and an unknown key should not buy a decode. The fourth cannot: a key is scoped
 * to one project, and which project a batch is for is only knowable once the
 * envelope has been parsed.
 */
export function handleIngest(deps: IngestDeps, body: unknown, ingestKey: string | undefined): IngestResponse {
  deps.trace?.('validate')

  if (ingestKey === undefined || ingestKey.trim() === '') {
    return {
      status: 401,
      body: {
        error: `no ${INGEST_KEY_HEADER} header on the request; a shipper authenticates every batch with one, and its value is checked against the keys this server holds.`,
      },
    }
  }

  // THE ONE CALL (ruling 8). Once per batch, never once per event.
  const verdict = deps.checkKey()
  if (!verdict.ok) {
    return {
      status: statusForIngestKeyRefusal(verdict.reason),
      body: { error: ingestKeyRefusal(verdict.reason) },
    }
  }

  const parsed = parseIngestRequest(body)
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error } }
  }

  if (verdict.projectId !== parsed.request.project) {
    return {
      status: statusForIngestKeyRefusal('wrong-project'),
      body: { error: ingestKeyRefusal('wrong-project', parsed.request.project) },
    }
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
