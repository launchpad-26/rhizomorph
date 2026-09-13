import { createServer } from 'node:http'
import path from 'node:path'
import { bootstrapTeamStorage } from '../bootstrap.js'
import type { TeamConfig } from '../config/config.js'
import { INGEST_KEY_HEADER } from '../ingest/handle.js'
import { type Journal, openJournal } from '../journal/journal.js'
import { type IngestKeyVerdict, resolveIngestKeyCheck } from '../keys/verify.js'
import type { TeamStorage } from '../storage/contract.js'
import { INGEST_PATH, createIngestListener } from './http.js'

/**
 * THE TEAM SERVER'S ENTRYPOINT (prd-51 ruling 14).
 *
 * One function. It bootstraps the storage, tops the partition window up, opens
 * the journal, and binds one route. It is not a CLI, it has no `bin`, and it
 * calls `process.exit` nowhere — ruling 14 keeps this package separate from the
 * local server, and the shipper lane owns whatever eventually invokes it.
 *
 * ## Boot tops the partitions up, and the fold never does
 *
 * `migrations/0003_roles_rls.sql` gives `rz_ingest` INSERT on `events` and no
 * CREATE at all, and `CREATE TABLE … PARTITION OF` takes an ACCESS EXCLUSIVE
 * lock on the parent. Both say the same thing: partition creation is a boot-time
 * act on the bootstrap connection, never something the hot path does. The
 * current and next month are topped up here, after `bootstrapTeamStorage`;
 * scheduling a recurring top-up is a later wave's, and until it exists a
 * long-running server needs a restart before a month it has not created. A row
 * outside the window fails its insert loudly rather than being dropped.
 *
 * ## The ingest key is resolved here, once per batch, and never cached
 *
 * Ruling 8's key check is *"a row flag checked once per batch"*, and the row
 * lives behind an asynchronous {@link TeamStorage} while `handleIngest` is
 * synchronous — `./http.ts` calls it with no `await`, and turning that adapter
 * into something that could is wave 7's single restructuring of it. So the one
 * row read happens in the wrapper below, per request, and the verdict reaches
 * the pure handler as the synchronous `checkKey` thunk on its deps.
 *
 * Three properties of that wrapper are load-bearing rather than incidental:
 *
 * - **Nothing is memoised.** A fresh `resolveIngestKeyCheck` per request is what
 *   bounds revocation lag to one batch interval; a verdict held between requests
 *   would unbound it, and every test would still pass.
 * - **A non-ingest request buys no database read.** The route match is
 *   duplicated from `./http.ts` for exactly that, so a `GET /` cannot spend a
 *   key lookup. Wave 7's router absorbs both this wrapper and the duplication.
 * - **It fails CLOSED.** A storage that cannot answer *"is this key revoked?"*
 *   gets a 503 and no journal write. The tempting shape — one `try` around the
 *   whole listener — accepts the batch and refuses the ack, which is the wrong
 *   way round: the key was never checked. And the storage's own error goes to
 *   `onError`, never onto the wire: the caller a 503 answers has presented a
 *   key nobody has verified.
 */

/** The current month and the next, as `YYYY-MM`. Exported because a month roll is worth a test. */
export function monthsToTopUp(nowMs: number): string[] {
  const at = new Date(nowMs)
  const year = at.getUTCFullYear()
  const month = at.getUTCMonth() + 1
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return [
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`,
  ]
}

export interface StartTeamServerOptions {
  readonly storage: TeamStorage
  readonly config: TeamConfig
  /** Where the durable journal lives. Its containing directory must already exist. */
  readonly journalPath: string
  readonly host?: string | undefined
  /** `0` asks the OS for a free port; the bound one is on the result. */
  readonly port: number
  /** Wakes the fold worker. Defaults to doing nothing, which is correct for a server with no worker attached. */
  readonly onBatch?: ((seq: number) => void) | undefined
  /**
   * Where a server-side failure goes when the wire must not carry it. Today that
   * is one case: the storage read behind the ingest key check throwing. The
   * caller at that moment has presented a key nobody has verified, so the
   * database's own sentence — a host and port, a role name, a relation — is
   * not theirs to read; it is the operator's. `deploy/serve.ts` wires this to
   * `console.error`; defaults to doing nothing, the same shape as `onBatch`.
   */
  readonly onError?: ((message: string) => void) | undefined
  readonly now?: (() => number) | undefined
}

export interface TeamServer {
  readonly port: number
  readonly host: string
  readonly journal: Journal
  close(): Promise<void>
}

export type StartTeamServerResult = { ok: true; server: TeamServer } | { ok: false; error: string }

export async function startTeamServer(options: StartTeamServerOptions): Promise<StartTeamServerResult> {
  const now = options.now ?? Date.now
  const host = options.host ?? '127.0.0.1'

  const bootstrapped = await bootstrapTeamStorage(options.storage, options.config)
  if (!bootstrapped.ok) return { ok: false, error: bootstrapped.error }

  for (const month of monthsToTopUp(now())) {
    await options.storage.ensureMonthlyPartition(month)
  }

  const opened = openJournal({ path: path.resolve(options.journalPath) })
  if (!opened.ok) return { ok: false, error: opened.error }
  const journal = opened.journal

  const server = createServer(async (request, response) => {
    const wantsIngest =
      request.method === 'POST' && ((request.url ?? '').split('?')[0] ?? '') === INGEST_PATH

    // Refusal is the safe direction for a request that never reaches the route:
    // `handleIngest` is the only caller and it is only reached on the route.
    let checkKey: () => IngestKeyVerdict = () => ({ ok: false, reason: 'unknown' })

    if (wantsIngest) {
      const header = request.headers[INGEST_KEY_HEADER]
      const presented = Array.isArray(header) ? header[0] : header
      try {
        checkKey = await resolveIngestKeyCheck(options.storage, presented)
      } catch (cause) {
        // The cause is the operator's, not the caller's: at this point the key
        // has NOT been verified, so whoever is on the wire is unauthenticated,
        // and a database error names things (host, port, role, relation) an
        // unauthenticated caller has no business learning. `onError` carries
        // it; the wire carries the fact and the remedy only.
        options.onError?.(
          `the ingest key could not be checked — the batch was refused with a 503 and nothing was journalled: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        response.end(
          JSON.stringify({
            error:
              'the ingest key could not be checked, so this batch was refused rather than accepted. Nothing was journalled; retry, and the fold dedups anything that arrives twice.',
          }),
        )
        return
      }
    }

    await createIngestListener({
      journal,
      notify: options.onBatch ?? (() => undefined),
      now,
      checkKey,
    })(request, response)
  })

  const bound = await new Promise<{ ok: true; port: number } | { ok: false; error: string }>((resolve) => {
    server.once('error', (cause) => resolve({ ok: false, error: `could not listen on ${host}:${options.port}: ${cause.message}` }))
    server.listen(options.port, host, () => {
      const address = server.address()
      resolve(
        typeof address === 'object' && address !== null
          ? { ok: true, port: address.port }
          : { ok: false, error: 'the server bound to a pipe rather than a port' },
      )
    })
  })

  if (!bound.ok) {
    journal.close()
    return { ok: false, error: bound.error }
  }

  return {
    ok: true,
    server: {
      port: bound.port,
      host,
      journal,
      async close(): Promise<void> {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
        journal.close()
      },
    },
  }
}
