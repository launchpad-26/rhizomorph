import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Fetch } from '../auth/github-app.js'
import { type CallbackRequest, type SignInResponse, handleGithubCallback, handleSignInStart } from '../auth/signin.js'
import type { TeamConfig } from '../config/config.js'
import { type Question, handleQuestion } from '../view/questions.js'
import { INGEST_KEY_HEADER, handleIngest } from '../ingest/handle.js'
import type { Journal } from '../journal/journal.js'
import { type IngestKeyVerdict, resolveIngestKeyCheck } from '../keys/verify.js'
import type { TeamStorage } from '../storage/contract.js'
import { type RouteDeclaration, matchRoute, methodNotAllowedBody, notFoundBody } from './router.js'

/**
 * THE HTTP ADAPTER — a table of routes, and nothing else (prd-51 ruling 14).
 *
 * This file reads a socket and writes a socket. Every decision about what a
 * request *means* lives in a pure handler per route — `../ingest/handle.ts` for
 * a batch, `../auth/signin.ts` for the two halves of a sign-in — and this file
 * decides only what a *socket* means: which path, which method, how big a body
 * may be, and what a decode failure is.
 *
 * **Adding a route is adding a row.** {@link TABLE} is the whole route set;
 * `./router.ts` matches `(method, path)` against it exactly and derives both the
 * 404 and the 405 from it, so a row added and forgotten in the prose is not a
 * thing that can happen. This replaced a negated conditional — `if (path !==
 * INGEST_PATH) 404` — that had exactly one route in it while four separate
 * pieces of work wanted to add to it.
 *
 * ## The ingest key's value IS verified
 *
 * `../keys/verify.ts` resolves one row read per batch into a synchronous thunk,
 * and `handleIngest` calls it exactly once inside `validate` (#462, ruling 8).
 * The read happens inside the ingest route below, so a `GET /` or a 404 still
 * buys no database read — that is now a property of the table rather than of a
 * condition duplicated into `./main.ts`, and `api.test.ts` pins it.
 *
 * ## …and it is verified BEFORE the body is read (#550)
 *
 * `serveIngest` asks the thunk for its verdict and, when it refuses, hands the
 * **unread** request to `handleIngest`. The refusal therefore precedes both
 * `readBody` and the decode. Until #550 it did not: this adapter read and
 * decoded first, so the key refusal never ran for a body that would not parse.
 * Measured against a live host on 2026-09-15 (host redacted): no key + valid
 * JSON was 401, no key + invalid JSON was 400, and a bogus `rzk_` key + invalid
 * JSON was 400. The handler's documented order was right; this file inverted it.
 *
 * **Ruling 1 of #550 — the cap keeps its position and becomes unreachable for an
 * unverified caller.** `readBody` still sits immediately above the decode, and a
 * verified caller that exceeds `MAX_BODY_BYTES` has its **socket destroyed at the
 * cap**: `readBody` calls `request.destroy()` before it resolves, so the 413 the
 * adapter then writes never reaches the wire. EXECUTED 2026-09-15 on this
 * platform — `fetch` throws a socket error (undici's UND_ERR_SOCKET, "other side
 * closed") having read zero bytes back, and a raw `node:http` client sees an
 * ECONNRESET and no status line at all. The existing
 * `api.test.ts` case 'a body over the cap is 413' records that reset as a refusal
 * through its `catch`, which is why the suite reads as though a 413 is delivered.
 * That undeliverability is pre-existing and untouched here; whether the cap
 * should write-then-close instead is its own ruling and its own issue.
 *
 * What changed is that nobody unverified reaches the cap at all: no buffering, no
 * 16 MiB string, no parse for a caller this server is about to refuse on a
 * header. And the cap's refusal is the less useful answer to a caller whose key
 * is the problem — shrinking the body would not help, where 401/403 names the
 * fault and is actionable, and unlike the cap's refusal it is actually delivered.
 * The alternative, gating between `readBody` and the decode, was considered and
 * rejected: it keeps the 16 MiB read for an anonymous caller for no benefit, and
 * what that caller then gets is not a 413 but nothing — measured under mutation
 * M-2 on this commit, 16,778,610 bytes written and zero read back. The choice is
 * a delivered 401 against a silent reset, not one status against another.
 *
 * **The refusal words and the status stay `handleIngest`'s.** No 401 or 403
 * literal is written here and neither refusal helper is imported: a second copy
 * of ruling 8's strings in this file would be exactly the fork the
 * handler/adapter split exists to prevent. This adapter chooses only *when* the
 * handler is asked, never *what* it answers.
 *
 * **The thunk is called twice, the row is read once.** `checkKey` runs here and
 * again inside `handleIngest`; `../keys/verify.ts` states it is pure over one
 * read and cannot reach storage again, so ruling 8's bound is on the read and
 * the bound is unchanged. `api.test.ts`'s `keyLookups` assertions are the pin,
 * and no memo cell is added here for the same reason ruling 8 forbids one.
 *
 * ## The two identity planes never meet (ruling 8)
 *
 * No GitHub token is ever accepted on the ingest route, no `rzk_` key is ever
 * derived from one, and the ingest hot path never calls GitHub. The sign-in
 * routes are the human plane and reach `../auth/`; the ingest route is the
 * machine plane and reaches `../keys/`. Nothing below crosses them.
 *
 * ## Why `node:http` and not Fastify
 *
 * Fastify is the repo's convention for `packages/server` routes, and it loses
 * here on manifest arithmetic and only on that. `packages/team/package.json`
 * declares exactly two dependencies, `@rhizomorph/core` and `postgres`;
 * `fastify` is a **root** dependency and a `packages/server` one, not this
 * package's. Using it means either declaring it — a dependency change this
 * package's issues have repeatedly forbidden, plus a `package-lock.json` edit
 * outside every fence — or importing an undeclared package through workspace
 * hoisting, which is a latent defect rather than a saving: the day this package
 * is built or published on its own, the import is simply not there. This commit
 * adds no dependency, so that arithmetic is unchanged.
 *
 * Deliberately not an ADR. `docs/adr/README.md`'s own test — if reversing it is
 * a weekend, it probably is not one — puts an adapter under a pure handler below
 * the line, and the *contract* the ingest route implements is already ADR-0033's.
 * The journal's on-disk format, which outlives both, is the piece of this that
 * did get one (ADR-0046).
 *
 * ## The mutation guard is not here, and that is not an omission
 *
 * ADR-0008/0012's localhost-single-origin token guard is the *local* server's
 * rule for routes that mutate the watched repo. This is a different process on a
 * different machine writing to its own database; ruling 14 keeps the two apart.
 */

export const INGEST_PATH = '/v1/rhizomorph/ingest'
/**
 * The three questions (#557). Fixed paths and `?project=`, not a path parameter:
 * `matchRoute` is exact-string and `INGEST_PATH`'s middle segment is the product
 * name rather than a project, so a `:project` segment would be a new grammar for
 * one feature. The project is named the same way ingest names it — explicitly.
 */
export const WHERE_PATH = '/v1/rhizomorph/where'
export const COST_PATH = '/v1/rhizomorph/cost'
export const STUCK_PATH = '/v1/rhizomorph/stuck'
export const SIGNIN_START_PATH = '/auth/github/start'
export const CALLBACK_PATH = '/auth/github/callback'

/**
 * 16 MiB, derived rather than picked.
 *
 * The measured ceiling is ~648 KB per pane-hour and a batch is 500 lines at
 * 280–415 B (`docs/research/2026-08-29-shared-record-s1-corpus-machines-2-3.md`),
 * so a real batch is ~200 KB. Two orders of magnitude of margin: large enough
 * that no honest shipper ever meets it, small enough that a runaway or hostile
 * body cannot exhaust the process before the socket is closed.
 */
export const MAX_BODY_BYTES = 16 * 1024 * 1024

/** Every route this server serves. Adding one is adding a row. */
export const TABLE = [
  { method: 'POST', path: INGEST_PATH, methodHint: 'a batch is POSTed' },
  { method: 'GET', path: SIGNIN_START_PATH, methodHint: 'a member starts sign-in by GET' },
  { method: 'GET', path: CALLBACK_PATH, methodHint: 'GitHub returns a member here by GET' },
  { method: 'GET', path: WHERE_PATH, methodHint: 'a member reads where work is by GET' },
  { method: 'GET', path: COST_PATH, methodHint: 'a member reads what it costs by GET' },
  { method: 'GET', path: STUCK_PATH, methodHint: 'a member reads who is stuck by GET' },
] as const satisfies readonly RouteDeclaration[]

export interface TeamListenerDeps {
  readonly journal: Journal
  /** Wakes the fold worker. Called AFTER the fsync and BEFORE the 202, exactly once per accepted batch. */
  readonly notify: (seq: number) => void
  readonly now: () => number
  readonly storage: Pick<TeamStorage, 'findIngestKey' | 'readSpendByDay' | 'readLaneState' | 'readCollisions'>
  readonly config: TeamConfig
  readonly fetch: Fetch
  readonly onError?: ((message: string) => void) | undefined
}

/**
 * The three questions' writer. HTML, not JSON, so it cannot go through {@link send}.
 *
 * The operator note never reaches the wire, matching `serveIngest`'s discipline: a membership
 * failure's text names a token endpoint and a host, and the caller it refuses is by definition
 * someone this server has not established is a member.
 */
async function writeView(
  deps: TeamListenerDeps,
  response: ServerResponse,
  question: Question,
  request: IncomingMessage,
  query: URLSearchParams,
): Promise<void> {
  const view = await handleQuestion(
    { storage: deps.storage, config: deps.config, fetch: deps.fetch, now: deps.now },
    question,
    { cookieHeader: request.headers.cookie, project: query.get('project') ?? undefined },
  )
  if (view.operatorNote !== undefined) deps.onError?.(view.operatorNote)
  response.writeHead(view.status, view.headers)
  response.end(view.html)
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(text)
}

/** Reads the whole body, refusing at the cap rather than after it. */
async function readBody(request: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    request.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) {
        settled = true
        request.destroy()
        resolve({ ok: false, error: `request body exceeds the ${MAX_BODY_BYTES}-byte ingest cap` })
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })
    request.on('error', (cause) => {
      if (settled) return
      settled = true
      resolve({ ok: false, error: `request body could not be read: ${cause.message}` })
    })
  })
}

/**
 * ONE ROW READ PER BATCH, AND NEVER MEMOISED (ruling 8).
 *
 * A fresh `resolveIngestKeyCheck` per request is what bounds revocation lag to
 * one batch interval; a verdict held between requests would unbound it and every
 * test would still pass. The read stays **before** `readBody`, where it has
 * always been.
 *
 * **It fails CLOSED.** A storage that cannot answer *"is this key revoked?"*
 * gets a 503 and no journal write. The tempting shape — one `try` around the
 * whole route — accepts the batch and refuses the ack, which is the wrong way
 * round: the key was never checked. And the storage's own error goes to
 * `onError`, never onto the wire: the caller a 503 answers has presented a key
 * nobody has verified, and a database error names a host, a port, a role or a
 * relation.
 */
async function serveIngest(deps: TeamListenerDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const header = request.headers[INGEST_KEY_HEADER]
  const presented = Array.isArray(header) ? header[0] : header

  let checkKey: () => IngestKeyVerdict
  try {
    checkKey = await resolveIngestKeyCheck(deps.storage, presented)
  } catch (cause) {
    deps.onError?.(
      `the ingest key could not be checked — the batch was refused with a 503 and nothing was journalled: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    send(response, 503, {
      error:
        'the ingest key could not be checked, so this batch was refused rather than accepted. Nothing was journalled; retry, and the fold dedups anything that arrives twice.',
    })
    return
  }

  const ingestDeps = { journal: deps.journal, notify: deps.notify, now: deps.now, checkKey }

  // THE KEY GATE, ASKED BEFORE A BYTE OF BODY IS READ (#550).
  //
  // `handleIngest` refuses a missing header, then a refused key, then a body
  // that will not parse — in that order, and it always has. This adapter used
  // to decode first, so a request with no key and a body that is not JSON
  // answered 400 and the key refusal never ran.
  //
  // The refusal is still the handler's own: `checkKey` has already answered
  // not-ok here, so the call below returns from one of its first two branches
  // and `parseIngestRequest` is provably not reached — the unread body it is
  // handed is never looked at, and the journal is unreachable from this call.
  if (!checkKey().ok) {
    const refused = handleIngest(ingestDeps, undefined, presented)
    send(response, refused.status, refused.body)
    return
  }

  const body = await readBody(request)
  if (!body.ok) {
    send(response, 413, { error: body.error })
    return
  }

  let value: unknown
  try {
    value = JSON.parse(body.text)
  } catch (cause) {
    send(response, 400, {
      error: `request body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    })
    return
  }

  const result = handleIngest(ingestDeps, value, presented)
  send(response, result.status, result.body)
}

/** Both sign-in routes write their pure handler's result the same way. `readBody` is not called: both are GETs. */
function writeSignIn(deps: TeamListenerDeps, response: ServerResponse, result: SignInResponse): void {
  if (result.operatorNote !== undefined) deps.onError?.(result.operatorNote)
  for (const [name, value] of Object.entries(result.headers)) {
    response.setHeader(name, value as string | string[])
  }
  send(response, result.status, result.body)
}

/** The routes, as a `node:http` request listener. */
export function createTeamListener(deps: TeamListenerDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // The same parse that shipped before the table — `url.split('?')[0]`, not
    // `new URL(...)`: a query string does not make a route unrecognisable, and a
    // second URL grammar here would be a second thing to be wrong.
    const raw = request.url ?? ''
    const cut = raw.indexOf('?')
    const path = cut === -1 ? raw : raw.slice(0, cut)
    const query = new URLSearchParams(cut === -1 ? '' : raw.slice(cut + 1))

    const match = matchRoute(TABLE, request.method, path)
    if (match.kind === 'not-found') {
      send(response, 404, notFoundBody(path, TABLE))
      return
    }
    if (match.kind === 'method-not-allowed') {
      response.setHeader('allow', match.allow.join(', '))
      send(response, 405, methodNotAllowedBody(request.method, path, match.methodHint))
      return
    }

    const signInDeps = { config: deps.config, fetch: deps.fetch, now: deps.now }

    switch (match.route.path) {
      case INGEST_PATH:
        await serveIngest(deps, request, response)
        return
      case SIGNIN_START_PATH:
        writeSignIn(deps, response, handleSignInStart(signInDeps))
        return
      case WHERE_PATH:
        await writeView(deps, response, 'where', request, query)
        return
      case COST_PATH:
        await writeView(deps, response, 'cost', request, query)
        return
      case STUCK_PATH:
        await writeView(deps, response, 'stuck', request, query)
        return
      case CALLBACK_PATH: {
        const callback: CallbackRequest = {
          code: query.get('code') ?? undefined,
          state: query.get('state') ?? undefined,
          cookieHeader: request.headers.cookie,
        }
        writeSignIn(deps, response, await handleGithubCallback(signInDeps, callback))
        return
      }
    }
  }
}
