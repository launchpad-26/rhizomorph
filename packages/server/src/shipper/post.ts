import {
  ingestRequestSchema,
  parseIngestAccepted,
  PROTOCOL_VERSION,
  type IngestBatchEntry,
} from '@rhizomorph/core/src/wire/index.js'
import type { IngestKey } from './key.js'

/**
 * THE ONE OUTBOUND CALL (ADR-0034 clause 1).
 *
 * A `fetch` client and nothing else. No listener is constructed here and none
 * can be: `hand-law.test.ts`'s clause 1 bans `createServer`, `new …Server(`,
 * `.listen(`, the literal `'fastify'` and `net`/`dgram`/`http2` as module
 * specifiers across every source in this directory, and its own paired
 * negative fixture pins that `fetch` and `new URL(…)` are the shape the hand
 * legitimately is.
 *
 * **The request is validated locally before it is sent**, through the same
 * `ingestRequestSchema` the server will use. A shipper defect then surfaces as
 * a local error naming the field rather than as a 4xx from a machine that
 * cannot say what this build got wrong.
 *
 * **Nothing a server says is passed through unredacted.** A 4xx/5xx body and a
 * rejected `fetch`'s message are both text this process did not author, and a
 * team server that echoes the ingest key back in an error is not a
 * hypothetical — so every one of them goes through {@link IngestKey.redact}
 * before it becomes a `detail`. `no-key-in-output-law.test.ts` runs exactly
 * that server and asserts the value reaches no log, no error and no file but
 * its own.
 */

/** The injected seam, defaulting to the platform function — the shape `cli/rotate.ts` already uses. No new dependency. */
export type FetchLike = typeof globalThis.fetch

/** The header the team server reads the credential from. A header NAME, never a value — the law's own fixture pins that this is not a key prefix. */
export const INGEST_KEY_HEADER = 'x-rz-ingest-key'

/** Appended to the configured base URL. Relative on purpose: `new URL(path, base)` is what makes a base with or without a trailing slash land in the same place. */
export const INGEST_PATH = 'v1/rhizomorph/ingest'

/** At most this much of a server's own error body is carried into a `detail`. Enough to act on, short of pasting a page of HTML into a status line. */
export const MAX_BODY_DETAIL = 200

export type PostFailureReason =
  /** The request this build assembled is not a valid protocol v1 request. A shipper defect; nothing was sent. */
  | 'invalid-request'
  /** 401/403 — the key is wrong, revoked, or for another project. */
  | 'refused'
  /** Any other 4xx — the server understood and declined. */
  | 'rejected'
  /** 5xx, or `fetch` itself rejected. Retry on the next tick. */
  | 'unreachable'
  /** A 2xx whose body is not the acknowledgement ruling 3 requires. Durability was not stated, so nothing may advance. */
  | 'unreadable-response'

export type PostBatchResult =
  | { ok: true; accepted: number; journalSeq: number }
  | { ok: false; reason: PostFailureReason; detail: string }

export interface PostBatchOptions {
  /** The team server's base URL, already validated by `config.ts`. */
  url: string
  project: string
  actorInstance: string
  key: IngestKey
  batch: readonly IngestBatchEntry[]
  fetch?: FetchLike
}

export async function postBatch(options: PostBatchOptions): Promise<PostBatchResult> {
  const body = {
    protocolVersion: PROTOCOL_VERSION,
    project: options.project,
    actorInstance: options.actorInstance,
    batch: options.batch,
  }

  const valid = ingestRequestSchema.safeParse(body)
  if (!valid.success) {
    return { ok: false, reason: 'invalid-request', detail: valid.error.message }
  }

  const target = new URL(INGEST_PATH, options.url)
  const send = options.fetch ?? globalThis.fetch

  let response: Response
  try {
    response = await send(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The one call to `headerValue()` in the codebase, asserted by
        // `hand-law.test.ts`'s clause 2b.
        [INGEST_KEY_HEADER]: options.key.headerValue(),
      },
      body: JSON.stringify(valid.data),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'unreachable', detail: options.key.redact(message) }
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: 'refused',
      detail:
        `the team server refused this credential (${response.status}) — ` +
        're-run `rhizomorph connect team <url> --project <id>` with a fresh value on stdin',
    }
  }

  if (response.status >= 500) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: `the team server answered ${response.status}: ${await excerpt(response, options.key)}`,
    }
  }

  if (response.status >= 400) {
    return {
      ok: false,
      reason: 'rejected',
      detail: `the team server rejected this batch (${response.status}): ${await excerpt(response, options.key)}`,
    }
  }

  let decoded: unknown
  try {
    decoded = await response.json()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      reason: 'unreadable-response',
      detail: `the team server answered ${response.status} with a body that is not JSON: ${options.key.redact(message)}`,
    }
  }

  const accepted = parseIngestAccepted(decoded)
  if (!accepted.ok) {
    return {
      ok: false,
      reason: 'unreadable-response',
      detail:
        `the team server answered ${response.status} without the acknowledgement protocol v1 requires ` +
        `({ accepted, journalSeq }): ${options.key.redact(accepted.error)}`,
    }
  }

  return { ok: true, accepted: accepted.response.accepted, journalSeq: accepted.response.journalSeq }
}

/** At most {@link MAX_BODY_DETAIL} characters of a server's own words, redacted. A body that cannot be read at all is said so rather than guessed at. */
async function excerpt(response: Response, key: IngestKey): Promise<string> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return '(its body could not be read)'
  }
  // Redact BEFORE truncating, never after: a key straddling the cut would
  // survive as a fragment, and a fragment of a secret is still a piece of one.
  return key.redact(text).slice(0, MAX_BODY_DETAIL)
}
