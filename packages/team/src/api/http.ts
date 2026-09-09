import type { IncomingMessage, ServerResponse } from 'node:http'
import { INGEST_KEY_HEADER, type IngestDeps, handleIngest } from '../ingest/handle.js'

/**
 * THE HTTP ADAPTER — one route, and nothing else (prd-51 ruling 14).
 *
 * ~50 lines that read a body, call one pure function and write its result. Every
 * decision about what a request means lives in `../ingest/handle.ts`; this file
 * decides only what a *socket* means — which path, which method, how big a body
 * may be, and what a decode failure is.
 *
 * ## Why `node:http` and not Fastify
 *
 * Fastify is the repo's convention for `packages/server` routes, and it loses
 * here on manifest arithmetic and only on that. `packages/team/package.json`
 * declares exactly two dependencies, `@rhizomorph/core` and `postgres`;
 * `fastify` is a **root** dependency and a `packages/server` one, not this
 * package's. Using it means either declaring it — a dependency change this
 * issue's fence forbids, plus a `package-lock.json` edit outside that fence —
 * or importing an undeclared package through workspace hoisting, which is a
 * latent defect rather than a saving: the day this package is built or
 * published on its own, the import is simply not there.
 *
 * Deliberately not an ADR. `docs/adr/README.md`'s own test — if reversing it is
 * a weekend, it probably is not one — puts a 50-line adapter under a pure
 * handler below the line, and the *contract* the route implements is already
 * ADR-0033's. The journal's on-disk format, which outlives both, is the piece
 * of this issue that did get one (ADR-0046).
 *
 * ## The mutation guard is not here, and that is not an omission
 *
 * ADR-0008/0012's localhost-single-origin token guard is the *local* server's
 * rule for routes that mutate the watched repo. This is a different process on
 * a different machine writing to its own database; ruling 14 keeps the two
 * apart. Authentication here is `x-rz-ingest-key`, whose value verification is
 * wave 4's and is loudly unimplemented — see `handleIngest`.
 */

export const INGEST_PATH = '/v1/rhizomorph/ingest'

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

/** The one route, as a `node:http` request listener. */
export function createIngestListener(deps: IngestDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = request.url ?? ''
    const path = url.split('?')[0] ?? ''

    if (path !== INGEST_PATH) {
      send(response, 404, { error: `no route ${JSON.stringify(path)}; this server serves ${INGEST_PATH} only` })
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      send(response, 405, { error: `${request.method ?? 'that method'} is not allowed on ${INGEST_PATH}; a batch is POSTed` })
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

    const header = request.headers[INGEST_KEY_HEADER]
    const key = Array.isArray(header) ? header[0] : header
    const result = handleIngest(deps, value, key)
    send(response, result.status, result.body)
  }
}
