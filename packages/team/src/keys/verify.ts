import type { IngestKeyRow, TeamStorage } from '../storage/contract.js'
import { hashIngestKey } from './hash.js'
import { INGEST_KEY_PREFIX, MIN_INGEST_KEY_BODY, isWellFormedIngestKey } from './shape.js'

/**
 * THE REFUSAL, AND THE ONE ROW READ IT RESTS ON (prd-51 ruling 8).
 *
 * Ruling 8: *"revoked by a row flag checked **once per batch** — which bounds
 * revocation lag to one batch interval. Refusal text names the key prefix and
 * the exact reason."*
 *
 * ## Why the check is resolved here and CALLED somewhere else
 *
 * {@link TeamStorage} is asynchronous and `../ingest/handle.ts` is not. So the
 * split is: {@link resolveIngestKeyCheck} does the one asynchronous row read,
 * per request, before the pure handler runs, and hands back a SYNCHRONOUS thunk
 * that the handler calls exactly once inside `validate`. `../api/http.ts`'s
 * ingest route is where that `await` happens, one row of its route table — and
 * since #550 that route calls the thunk once itself as well, ahead of the body,
 * so a key refusal precedes `readBody` and the decode. The **read** is still
 * one: the extra call is a call, not a lookup.
 *
 * That split is what makes "once per batch" literal rather than aspirational.
 * The thunk closes over one row read; it holds no cache, and nothing holds the
 * thunk between requests. Once per event would be waste; cached across batches
 * would unbound the revocation lag the ruling bounds.
 *
 * ## Four reasons, four strings, and never the key
 *
 * `packages/server/src/shipper/no-key-in-output-law.test.ts` is the precedent on
 * the other side of the wire: a shipper laundering a key out of a server's error
 * body into a log line is a leak, and the shipper redacts. A server that PUT the
 * key in that body would be the same leak one step earlier, so every refusal
 * here names the PREFIX — the shared literal `rzk_`, not a truncation of the
 * presented value, because a prefix of a secret is still a piece of one — and
 * the reason, and nothing else that came off the wire except the project the
 * request itself declared.
 */

/** Why a key was refused. Four reasons, and they are four different strings. */
export type IngestKeyRefusal = 'malformed' | 'unknown' | 'revoked' | 'wrong-project'

/**
 * What the once-per-batch check answers.
 *
 * `wrong-project` is not reachable here on purpose: scope is a fact about the
 * key AND the request body, and the body is not decoded yet when this is
 * resolved. `handleIngest` compares {@link projectId} against the parsed
 * request and produces that refusal itself.
 */
export type IngestKeyVerdict =
  | { readonly ok: true; readonly projectId: string }
  | { readonly ok: false; readonly reason: Exclude<IngestKeyRefusal, 'wrong-project'> }

/** The verdict a stored row produces. Pure, and the whole of the revocation rule. */
export function verdictFor(row: IngestKeyRow | null): IngestKeyVerdict {
  if (row === null) return { ok: false, reason: 'unknown' }
  if (row.revokedAtMs !== null) return { ok: false, reason: 'revoked' }
  return { ok: true, projectId: row.projectId }
}

/**
 * 401 for *"this is not a key we know"*, 403 for *"a key, but not for this"*.
 *
 * The split is the one HTTP already makes and is worth keeping: a shipper that
 * gets a 401 has the wrong credential and should be re-run through
 * `rhizomorph connect team`; one that gets a 403 has a real credential aimed at
 * the wrong place, or one somebody took away, and re-pasting it will not help.
 */
export function statusForIngestKeyRefusal(reason: IngestKeyRefusal): 401 | 403 {
  return reason === 'malformed' || reason === 'unknown' ? 401 : 403
}

/**
 * The refusal an operator and a shipper both have to act on.
 *
 * Names the prefix and the exact reason, verbatim per ruling 8, and never the
 * presented value — not whole, not truncated. `project` is the one thing here
 * that came off the wire, and it came out of the request's own body.
 */
export function ingestKeyRefusal(reason: IngestKeyRefusal, project?: string): string {
  switch (reason) {
    case 'malformed':
      return (
        `that is not an ingest key: a team ingest key begins "${INGEST_KEY_PREFIX}" and carries at least ` +
        `${MIN_INGEST_KEY_BODY} characters after it, with no whitespace. Refused on shape alone — ` +
        'this server did not look it up.'
      )
    case 'unknown':
      return (
        `that ${INGEST_KEY_PREFIX} key is not one this server holds. Refused: unknown key. ` +
        'A member mints one per project in the team viewer; the value is shown once at mint and this ' +
        'server keeps only its SHA-256, so a lost key is replaced rather than recovered.'
      )
    case 'revoked':
      return (
        `that ${INGEST_KEY_PREFIX} key has been revoked. Refused: revoked key. The flag is read once per ` +
        'batch, so a batch already in flight completes and every batch after it is refused — ship with a ' +
        'replacement key.'
      )
    case 'wrong-project':
      return (
        `that ${INGEST_KEY_PREFIX} key is not scoped to project ${JSON.stringify(project ?? '')}. ` +
        'Refused: wrong project. A key is scoped to exactly one project — ship to the project it was ' +
        'minted for, or have one minted for this project.'
      )
  }
}

/**
 * ONE ROW READ PER BATCH (ruling 8), resolved into a synchronous thunk.
 *
 * Exactly one {@link TeamStorage.findIngestKey} call for a well-formed key, and
 * **none at all** for a value that cannot be one: a string that fails the shape
 * check is refused on shape alone, so a caller presenting rubbish cannot spend
 * this server's database reads.
 *
 * The returned thunk is pure over that one read. Calling it twice cannot change
 * its answer and cannot reach storage again, which is what stops "once per
 * batch" degrading into "once per event" by accident — and since #550 the
 * route's own key gate is what depends on that property: it calls the thunk
 * before the body is read and `../ingest/handle.ts` calls it again, two calls
 * over one read.
 */
export async function resolveIngestKeyCheck(
  storage: Pick<TeamStorage, 'findIngestKey'>,
  presented: string | undefined,
): Promise<() => IngestKeyVerdict> {
  const value = (presented ?? '').trim()

  // REACHED through the route since #550, and its answer discarded. The route
  // calls this thunk before it reads the body, so a headerless request evaluates
  // this branch — but the refusal the caller sees is still `handleIngest`'s
  // missing-header 401, which names the header, because that is the handler's
  // first branch. A thunk has to answer something, and the safe direction to be
  // wrong in is refusal, which is exactly what lets the route lean on it.
  if (value === '') return () => ({ ok: false, reason: 'unknown' })

  if (!isWellFormedIngestKey(value)) return () => ({ ok: false, reason: 'malformed' })

  const row = await storage.findIngestKey(hashIngestKey(value))
  return () => verdictFor(row)
}
