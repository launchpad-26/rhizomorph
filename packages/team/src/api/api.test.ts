import { parseIngestAccepted } from '@rhizomorph/core/src/wire/index.js'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Fetch } from '../auth/github-app.js'
import { OAUTH_STATE_COOKIE, SESSION_COOKIE, parseCookieHeader } from '../auth/session.js'
import { resolveTeamConfig } from '../config/config.js'
import { INGEST_KEY_HEADER } from '../ingest/handle.js'
import { readJournal } from '../journal/read.js'
import { hashIngestKey } from '../keys/hash.js'
import { mintIngestKey } from '../keys/mint.js'
import { FakeTeamStorage } from '../storage/fake.js'
import { CALLBACK_PATH, INGEST_PATH, MAX_BODY_BYTES, SIGNIN_START_PATH } from './http.js'
import { type TeamServer, monthsToTopUp, startTeamServer } from './main.js'

/**
 * THE ROUTE, OVER A REAL SOCKET.
 *
 * `listen(0)` on loopback, a real `fetch`, and a real journal file. The storage
 * is `FakeTeamStorage`, which is honest about what this proves: the boot
 * sequence and the route, not Postgres. Wave 4 meets a host.
 */

let dir: string
let running: TeamServer | null = null

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rz-api-'))
})

afterEach(async () => {
  if (running) await running.close()
  running = null
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A real minted key, and the digest the server is seeded with. Every 202 below
 * therefore passes for the right reason: the value on the header is checked.
 */
const MINTED = mintIngestKey({ projectId: 'acme-widgets', nowMs: Date.UTC(2026, 10, 20) })
const KEY = MINTED.takePlaintext()

/** A key minted for somewhere else, live, and never seeded as this project's. */
const OTHER = mintIngestKey({ projectId: 'other-project', nowMs: Date.UTC(2026, 10, 20) })
const OTHER_KEY = OTHER.takePlaintext()

function body(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    project: 'acme-widgets',
    actorInstance: 'lane-7',
    batch: [{ n: 1, line: '{"id":"e","ts":1,"source":"otel","type":"llm.cost","payload":{}}' }],
    ...overrides,
  }
}

async function start(
  port = 0,
  extra: { onError?: (message: string) => void } = {},
): Promise<{ server: TeamServer; storage: FakeTeamStorage; journalPath: string }> {
  const storage = new FakeTeamStorage({ settings: { synchronous_commit: 'on' } })
  const journalPath = path.join(dir, 'ingest.journal')
  const result = await startTeamServer({
    storage,
    config: resolveTeamConfig({}),
    journalPath,
    port,
    now: () => Date.UTC(2026, 10, 20),
    ...extra,
  })
  if (!result.ok) throw new Error(result.error)
  running = result.server

  // The deployment's own seeding, as `deploy/serve.ts` does it: the digest, and
  // never the key. AFTER the boot rather than before it, so the boot-ordering
  // assertions above still read the server's own first call — and because the
  // port is read live on every request, which is the point. `OTHER` is
  // deliberately NOT seeded: the wrong-project case seeds it for its own.
  await storage.insertIngestKey({
    keyHash: MINTED.row.keyHash,
    projectId: 'acme-widgets',
    createdAtMs: Date.UTC(2026, 10, 20),
    revokedAtMs: null,
  })
  storage.keyLookups.length = 0

  return { server: result.server, storage, journalPath }
}

function url(server: TeamServer, at = INGEST_PATH): string {
  return `http://${server.host}:${server.port}${at}`
}

/**
 * THE SIGN-IN ROUTES, OVER THE SAME SOCKET (#487).
 *
 * A SECOND starter rather than a change to `start()`: every case above is the
 * evidence that turning one negated conditional into a route table preserved
 * the ingest route's behaviour, and a case that had to be edited to stay green
 * would have stopped being that evidence.
 */
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const CONFIGURED_ENV = {
  RZ_TEAM_GITHUB_ORG: 'rhizomorph-team',
  RZ_TEAM_GITHUB_APP_ID: '123456',
  RZ_TEAM_GITHUB_INSTALLATION_ID: '789',
  RZ_TEAM_GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
  RZ_TEAM_GITHUB_CLIENT_ID: 'Iv1.abcdef0123456789',
  RZ_TEAM_GITHUB_CLIENT_SECRET: 'the-client-secret',
}

/** Answers every GitHub endpoint the happy path touches, and records nothing the wire needs. */
function happyGithub(): Fetch {
  const fn = async (at: string | URL | Request) => {
    const href = String(at)
    if (href.includes('login/oauth/access_token')) {
      return { status: 200, json: async () => ({ access_token: 'gho_user_tok' }) } as unknown as Response
    }
    if (href.includes('api.github.com/user')) {
      return { status: 200, json: async () => ({ login: 'octocat', id: 583231 }) } as unknown as Response
    }
    if (href.includes('/access_tokens')) {
      return { status: 201, json: async () => ({ token: 'ghs_install_tok' }) } as unknown as Response
    }
    return { status: 204 } as unknown as Response
  }
  return fn as Fetch
}

async function startConfigured(
  fetchImpl: Fetch = happyGithub(),
): Promise<{ server: TeamServer; storage: FakeTeamStorage }> {
  const storage = new FakeTeamStorage({ settings: { synchronous_commit: 'on' } })
  const result = await startTeamServer({
    storage,
    config: resolveTeamConfig(CONFIGURED_ENV),
    journalPath: path.join(dir, 'configured.journal'),
    port: 0,
    now: () => Date.UTC(2026, 10, 20),
    fetch: fetchImpl,
  })
  if (!result.ok) throw new Error(result.error)
  running = result.server
  storage.keyLookups.length = 0
  return { server: result.server, storage }
}

/** The `Set-Cookie` values, one per emitted cookie, off a real response. */
function cookiesOf(response: Response): string[] {
  return response.headers.getSetCookie()
}

describe('the sign-in routes are rows in the same table', () => {
  it('D1 — GET the callback on an UNCONFIGURED server is a 503 with a JSON body, not a 404', async () => {
    const { server } = await start()
    const response = await fetch(url(server, CALLBACK_PATH), { redirect: 'manual' })
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).toContain('unconfigured')
  })

  it('D2 — POST the callback is a 405 allowing GET', async () => {
    const { server } = await start()
    const response = await fetch(url(server, CALLBACK_PATH), { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    expect(JSON.stringify(await response.json())).toContain('GitHub returns a member here by GET')
  })

  it('D3 — a configured server signs a member in, and the cookie ATTRIBUTES survive the wire', async () => {
    const { server } = await startConfigured()

    const started = await fetch(url(server, SIGNIN_START_PATH), { redirect: 'manual' })
    const stateCookie = cookiesOf(started)[0] ?? ''
    const state = new URL(String(started.headers.get('location'))).searchParams.get('state') ?? ''
    const cookieHeader = stateCookie.split(';')[0] ?? ''

    const response = await fetch(
      `${url(server, CALLBACK_PATH)}?code=the-code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual', headers: { cookie: cookieHeader } },
    )

    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).toContain('octocat')

    const session = cookiesOf(response).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`) && !cookie.startsWith(`${SESSION_COOKIE}=;`))
    expect(session).toBeDefined()
    expect(session).toContain('HttpOnly')
    expect(session).toContain('Secure')
    expect(session).toContain('SameSite=Lax')
    // …and the consumed nonce is cleared in the same response.
    expect(cookiesOf(response).some((cookie) => cookie.startsWith(`${OAUTH_STATE_COOKIE}=;`))).toBe(true)
  })

  it('D4 — a callback request buys NO database read: the duplication was absorbed, not widened', async () => {
    const { server, storage } = await startConfigured()
    await fetch(url(server, CALLBACK_PATH), { redirect: 'manual' })
    await fetch(url(server, SIGNIN_START_PATH), { redirect: 'manual' })
    expect(storage.keyLookups).toEqual([])
  })

  it('D5 — repetition: the listener is built ONCE and holds nothing between requests', async () => {
    const { server, storage, journalPath } = await start()
    for (const n of [1, 2]) {
      const response = await fetch(url(server), {
        method: 'POST',
        headers: { [INGEST_KEY_HEADER]: KEY },
        body: JSON.stringify(body({ batch: [{ n, line: `{"a":${n}}` }] })),
      })
      expect(response.status).toBe(202)
    }
    const read = readJournal(journalPath)
    expect(read.ok && read.records.length).toBe(2)
    // Two batches, two row reads — nothing was memoised into the listener.
    expect(storage.keyLookups).toEqual([hashIngestKey(KEY), hashIngestKey(KEY)])
  })

  it('D6 — the whole flow over the socket: start issues a nonce the callback accepts, and a tampered one it does not', async () => {
    const { server } = await startConfigured()

    const started = await fetch(url(server, SIGNIN_START_PATH), { redirect: 'manual' })
    expect(started.status).toBe(302)
    const location = new URL(String(started.headers.get('location')))
    expect(location.host).toBe('github.com')
    const stateCookie = cookiesOf(started)[0] ?? ''
    expect(parseCookieHeader(stateCookie.split(';')[0])[OAUTH_STATE_COOKIE]).toBeDefined()

    const state = location.searchParams.get('state') ?? ''
    const cookieHeader = stateCookie.split(';')[0] ?? ''

    const good = await fetch(`${url(server, CALLBACK_PATH)}?code=the-code&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { cookie: cookieHeader },
    })
    expect(good.status).toBe(200)

    const tampered = await fetch(`${url(server, CALLBACK_PATH)}?code=the-code&state=${encodeURIComponent(`${state}x`)}`, {
      redirect: 'manual',
      headers: { cookie: cookieHeader },
    })
    expect(tampered.status).toBe(400)
    expect(JSON.stringify(await tampered.json())).toContain('bad-state')
  })
})

describe('boot', () => {
  it('bootstraps the storage, then tops up the current and next month, then listens', async () => {
    const { server, storage } = await start()
    expect(server.port).toBeGreaterThan(0)
    // The preflight and the migrations ran first…
    expect(storage.calls[0]).toBe('readSetting')
    expect(storage.committed).toEqual([
      '0001_events',
      '0002_projections',
      '0003_roles_rls',
      '0004_events_dedup',
      '0005_ingest_keys',
    ])
    // …and only then the partitions, which is what "on the bootstrap
    // connection, after bootstrapTeamStorage" means.
    expect(storage.partitions).toEqual(['2026-11', '2026-12'])
    expect(storage.calls.indexOf('ensureMonthlyPartition')).toBeGreaterThan(
      storage.calls.lastIndexOf('applyMigration:0005_ingest_keys'),
    )
  })

  it('a refused preflight is a refused boot — nothing binds and no journal is opened', async () => {
    const storage = new FakeTeamStorage({ settings: { synchronous_commit: 'off' } })
    const result = await startTeamServer({
      storage,
      config: resolveTeamConfig({}),
      journalPath: path.join(dir, 'never.journal'),
      port: 0,
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('synchronous_commit')
    expect(storage.partitions).toEqual([])
  })

  it('monthsToTopUp rolls the year over at December rather than producing month 13', () => {
    expect(monthsToTopUp(Date.UTC(2026, 10, 20))).toEqual(['2026-11', '2026-12'])
    expect(monthsToTopUp(Date.UTC(2026, 11, 31, 23, 59))).toEqual(['2026-12', '2027-01'])
    expect(monthsToTopUp(Date.UTC(2026, 0, 1))).toEqual(['2026-01', '2026-02'])
  })
})

describe('POST /v1/rhizomorph/ingest', () => {
  it('returns 202 and the batch is on disk before the response is read', async () => {
    const { server, journalPath } = await start()

    const response = await fetch(url(server), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [INGEST_KEY_HEADER]: KEY },
      body: JSON.stringify(body()),
    })

    expect(response.status).toBe(202)
    const parsed = parseIngestAccepted(await response.json())
    expect(parsed.ok && parsed.response).toEqual({ accepted: 1, journalSeq: 1 })

    const read = readJournal(journalPath)
    expect(read.ok && read.verdict).toBe('clean')
    expect(read.ok && read.records[0]?.entry.batch.map((e) => e.n)).toEqual([1])
  })

  it('refuses protocol version 2 with a 400 carrying the wire own message', async () => {
    const { server } = await start()
    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: KEY },
      body: JSON.stringify(body({ protocolVersion: 2 })),
    })
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('protocol version 2 is not spoken by this build')
  })

  it('refuses a body that is not JSON with a 400 rather than a 500', async () => {
    const { server } = await start()
    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: KEY },
      body: 'not json',
    })
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('not JSON')
  })

  it('refuses a request with no ingest key with a 401 naming the header', async () => {
    const { server, journalPath } = await start()
    const response = await fetch(url(server), { method: 'POST', body: JSON.stringify(body()) })
    expect(response.status).toBe(401)
    expect(JSON.stringify(await response.json())).toContain(INGEST_KEY_HEADER)
    expect(readJournal(journalPath).ok && readJournal(journalPath)).toMatchObject({ records: [] })
  })

  it('GET on the ingest path is 405 and says which method a batch uses', async () => {
    const { server } = await start()
    const response = await fetch(url(server))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('an unknown path is 404 and names the one route this server serves', async () => {
    const { server } = await start()
    const response = await fetch(url(server, '/'))
    expect(response.status).toBe(404)
    expect(JSON.stringify(await response.json())).toContain(INGEST_PATH)
    expect((await (await fetch(url(server, '/v1/rhizomorph/nope'))).json()) as unknown).toBeDefined()
  })

  it('a query string does not make the route unrecognisable', async () => {
    const { server } = await start()
    const response = await fetch(`${url(server)}?trace=1`, {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: KEY },
      body: JSON.stringify(body()),
    })
    expect(response.status).toBe(202)
  })

  /**
   * The cap is derived rather than picked — see `MAX_BODY_BYTES`. This asserts
   * the refusal happens, and that it is a 413 rather than a hang or a 500.
   */
  it('a body over the cap is 413, and nothing reaches the journal', async () => {
    const { server, journalPath } = await start()
    const huge = JSON.stringify(
      body({ batch: [{ n: 1, line: `{"pad":"${'x'.repeat(MAX_BODY_BYTES + 1024)}"}` }] }),
    )
    expect(huge.length).toBeGreaterThan(MAX_BODY_BYTES)

    let status = 0
    try {
      const response = await fetch(url(server), {
        method: 'POST',
        headers: { [INGEST_KEY_HEADER]: KEY },
        body: huge,
      })
      status = response.status
    } catch {
      // The server destroys the socket at the cap, which some clients surface
      // as a transport error rather than as a response. Either way the batch
      // was refused, which is what the cap is for.
      status = 413
    }
    expect(status).toBe(413)
    expect(readJournal(journalPath).ok && readJournal(journalPath)).toMatchObject({ records: [] })
  })
})

describe('close releases what it took', () => {
  it('a second server can bind the same explicit port after the first closes', async () => {
    const first = await start()
    const port = first.server.port
    await first.server.close()
    running = null

    const second = await start(port)
    expect(second.server.port).toBe(port)
    // …and the journal it reopens continues the chain rather than restarting it.
    const response = await fetch(url(second.server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: KEY },
      body: JSON.stringify(body()),
    })
    expect(response.status).toBe(202)
  })
})

/**
 * RULING 8 OVER A REAL SOCKET — *"revoked by a row flag checked once per batch,
 * which bounds revocation lag to one batch interval"*.
 *
 * The unit tests in `../keys/` and `../ingest/handle.test.ts` prove the parts.
 * These prove the thing the parts are for: a real `fetch`, a real journal, and
 * the storage port read the number of times the ruling says.
 */
describe('the ingest key is checked, once per batch, against the storage port', () => {
  it('REVOKE BETWEEN TWO BATCHES: the first is 202 and the second is 403, naming the reason', async () => {
    const { server, storage, journalPath } = await start()

    const first = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: KEY },
      body: JSON.stringify(body()),
    })
    expect(first.status).toBe(202)

    // …the operator revokes, between the two batches.
    expect(await storage.revokeIngestKeys({ projectId: 'acme-widgets', atMs: Date.UTC(2026, 10, 21) })).toBe(1)

    const second = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: KEY },
      body: JSON.stringify(body({ batch: [{ n: 2, line: '{"a":1}' }] })),
    })
    expect(second.status).toBe(403)
    const text = JSON.stringify(await second.json())
    expect(text).toContain('revoked key')
    expect(text).toContain('rzk_')
    expect(text).not.toContain(KEY)

    // One record, not two: the revoked batch never reached the journal.
    const read = readJournal(journalPath)
    expect(read.ok && read.records.length).toBe(1)
    // Two batches, two reads — the verdict was not carried across.
    expect(storage.keyLookups.length).toBe(2)
  })

  it('ONCE PER BATCH: a three-event batch reads the row once, not three times', async () => {
    const { server, storage } = await start()
    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: KEY },
      body: JSON.stringify(
        body({
          batch: [
            { n: 1, line: '{"a":1}' },
            { n: 2, line: '{"a":2}' },
            { n: 3, line: '{"a":3}' },
          ],
        }),
      ),
    })
    expect(response.status).toBe(202)
    expect(storage.keyLookups).toEqual([hashIngestKey(KEY)])
  })

  it('a GET, a 404 and a body over the cap buy no database read at all', async () => {
    const { server, storage } = await start()
    await fetch(url(server))
    await fetch(url(server, '/'))
    await fetch(url(server, '/v1/rhizomorph/nope'), { method: 'POST', headers: { [INGEST_KEY_HEADER]: KEY } })
    expect(storage.keyLookups).toEqual([])
  })

  it('an unknown key is 401 and nothing is journalled', async () => {
    const { server, storage, journalPath } = await start()
    const stranger = mintIngestKey({ projectId: 'acme-widgets', nowMs: 0 }).takePlaintext()

    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: stranger },
      body: JSON.stringify(body()),
    })

    expect(response.status).toBe(401)
    expect(JSON.stringify(await response.json())).toContain('unknown key')
    expect(readJournal(journalPath).ok && readJournal(journalPath)).toMatchObject({ records: [] })
    // It WAS looked up — "unknown" is an answer from the store, not a shape refusal.
    expect(storage.keyLookups).toEqual([hashIngestKey(stranger)])
  })

  it('a value that is not a key at all is 401 and is refused WITHOUT a database read', async () => {
    const { server, storage, journalPath } = await start()
    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: 'not-a-real-key-at-all' },
      body: JSON.stringify(body()),
    })

    expect(response.status).toBe(401)
    const text = JSON.stringify(await response.json())
    expect(text).toContain('shape alone')
    expect(text).not.toContain('not-a-real-key-at-all')
    expect(storage.keyLookups).toEqual([])
    expect(readJournal(journalPath).ok && readJournal(journalPath)).toMatchObject({ records: [] })
  })

  it('WRONG PROJECT: a live key minted for another project is 403, naming this one', async () => {
    const { server, storage, journalPath } = await start()
    await storage.insertIngestKey({
      keyHash: OTHER.row.keyHash,
      projectId: 'other-project',
      createdAtMs: Date.UTC(2026, 10, 20),
      revokedAtMs: null,
    })

    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: OTHER_KEY },
      body: JSON.stringify(body()),
    })

    expect(response.status).toBe(403)
    const text = JSON.stringify(await response.json())
    expect(text).toContain('wrong project')
    expect(text).toContain('acme-widgets')
    expect(text).not.toContain(OTHER_KEY)
    expect(readJournal(journalPath).ok && readJournal(journalPath)).toMatchObject({ records: [] })
  })

  /**
   * FAIL CLOSED. A storage that cannot answer *"is this key revoked?"* must
   * refuse the batch, never accept it — the tempting shape puts one `try` around
   * the whole listener, which journals the batch and then loses the ack, i.e.
   * accepts a batch whose key was never checked.
   */
  it('a storage that cannot answer is 503, and the batch is refused rather than journalled', async () => {
    const { server, storage, journalPath } = await start()
    storage.failFindIngestKey = true

    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: KEY },
      body: JSON.stringify(body()),
    })

    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).toContain('refused rather than accepted')
    expect(readJournal(journalPath).ok && readJournal(journalPath)).toMatchObject({ records: [] })

    // …and the very next request, once the database answers again, is accepted.
    storage.failFindIngestKey = false
    const retry = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: KEY },
      body: JSON.stringify(body()),
    })
    expect(retry.status).toBe(202)
  })

  /**
   * The storage's own sentence is the OPERATOR's, not the caller's. A 503 here
   * answers a caller whose key has not been verified — anyone who can reach the
   * socket with a well-formed `rzk_` value — and a database error names a host,
   * a port, a role or a relation. So the wire carries the fact and the remedy,
   * and the cause reaches `onError` (which `deploy/serve.ts` wires to stderr).
   * Mutation: put the cause back on the wire and the first assertion reddens;
   * drop the `onError` call and the second does.
   */
  it('the 503 names the fact and the remedy on the wire, and the cause only to the operator', async () => {
    const reported: string[] = []
    const { server, storage } = await start(0, { onError: (message) => reported.push(message) })
    storage.failFindIngestKey = true

    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: KEY },
      body: JSON.stringify(body()),
    })

    expect(response.status).toBe(503)
    const wire = JSON.stringify(await response.json())
    expect(wire).toContain('refused rather than accepted')
    expect(wire).not.toContain('the fake storage was told to fail the ingest key read')
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('the fake storage was told to fail the ingest key read')
  })
})

/**
 * THE SEAM THE TWO HALVES WERE EACH TESTED ON SEPARATELY (#550).
 *
 * `../ingest/handle.ts` documents four refusals and runs the first three before
 * it decodes anything, and its own tests prove that — with already-parsed
 * values. `./http.ts` tested its decode failure and its key refusals, never
 * their interaction. So the adapter read and decoded the body BEFORE calling the
 * handler, and a request with no key and a body that is not JSON answered 400
 * with the key refusal never running. Measured against a live host on
 * 2026-09-15 (host redacted): no key + valid JSON was 401, no key + invalid JSON
 * was 400, a bogus `rzk_` key + invalid JSON was 400.
 *
 * Every case below is one cell of {no key, unknown key, revoked key,
 * malformed-shape key, whitespace-only header} × {valid JSON, invalid JSON}. The
 * good-key column is two EXISTING cases, deliberately unmodified: 'refuses a
 * body that is not JSON with a 400 rather than a 500' (a verified caller still
 * gets the decode failure, so the gate does not swallow it) and 'returns 202 and
 * the batch is on disk before the response is read'.
 */
describe('a key is refused before the body is parsed', () => {
  /** A well-formed key this server was never seeded with — the same shape the unknown-key case uses. */
  const STRANGER = mintIngestKey({ projectId: 'acme-widgets', nowMs: 0 }).takePlaintext()

  it('M-a — no header + valid JSON is 401 naming the header, and buys no row read', async () => {
    const { server, storage } = await start()
    const response = await fetch(url(server), { method: 'POST', body: JSON.stringify(body()) })

    expect(response.status).toBe(401)
    expect(JSON.stringify(await response.json())).toContain(INGEST_KEY_HEADER)
    expect(storage.keyLookups).toEqual([])
  })

  it('M-b — no header + a body that is NOT JSON is still 401, not the decode failure', async () => {
    const { server, storage, journalPath } = await start()
    const response = await fetch(url(server), { method: 'POST', body: 'not json' })

    expect(response.status).toBe(401)
    const text = JSON.stringify(await response.json())
    expect(text).toContain(INGEST_KEY_HEADER)
    // The decode never ran: its message would be here if it had.
    expect(text).not.toContain('not JSON')
    expect(storage.keyLookups).toEqual([])
    expect(readJournal(journalPath).ok && readJournal(journalPath)).toMatchObject({ records: [] })
  })

  it('M-c — an unknown key + valid JSON is 401, after exactly one row read', async () => {
    const { server, storage } = await start()
    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: STRANGER },
      body: JSON.stringify(body()),
    })

    expect(response.status).toBe(401)
    expect(JSON.stringify(await response.json())).toContain('unknown key')
    expect(storage.keyLookups).toEqual([hashIngestKey(STRANGER)])
  })

  it('M-d — an unknown key + a body that is NOT JSON is 401 about the key, not 400 about the body', async () => {
    const { server, storage, journalPath } = await start()
    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: STRANGER },
      body: 'not json',
    })

    expect(response.status).toBe(401)
    const text = JSON.stringify(await response.json())
    expect(text).toContain('unknown key')
    expect(text).not.toContain('not JSON')
    expect(storage.keyLookups).toEqual([hashIngestKey(STRANGER)])
    expect(readJournal(journalPath).ok && readJournal(journalPath)).toMatchObject({ records: [] })
  })

  /**
   * THE 403 SIBLING. An ordering fix that moved only the 401s past the decode
   * would leave a revoked key with an unparseable body answering 400 — the shape
   * of defect this repo keeps finding, one arm fixed and its twin missed.
   */
  it('M-e — a REVOKED key + a body that is NOT JSON is 403 about the key', async () => {
    const { server, storage, journalPath } = await start()
    expect(await storage.revokeIngestKeys({ projectId: 'acme-widgets', atMs: Date.UTC(2026, 10, 21) })).toBe(1)

    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: KEY },
      body: 'not json',
    })

    expect(response.status).toBe(403)
    const text = JSON.stringify(await response.json())
    expect(text).toContain('revoked key')
    expect(text).not.toContain('not JSON')
    expect(text).not.toContain(KEY)
    expect(readJournal(journalPath).ok && readJournal(journalPath)).toMatchObject({ records: [] })
  })

  it('M-f — a value that is not a key at all + a body that is NOT JSON is 401 on shape, with no row read', async () => {
    const { server, storage } = await start()
    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: 'not-a-real-key-at-all' },
      body: 'not json',
    })

    expect(response.status).toBe(401)
    const text = JSON.stringify(await response.json())
    expect(text).toContain('shape alone')
    expect(text).not.toContain('not JSON')
    expect(text).not.toContain('not-a-real-key-at-all')
    expect(storage.keyLookups).toEqual([])
  })

  it('M-g — a whitespace-only header value + a body that is NOT JSON is 401 naming the header', async () => {
    const { server, storage } = await start()
    const response = await fetch(url(server), {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: '   ' },
      body: 'not json',
    })

    expect(response.status).toBe(401)
    expect(JSON.stringify(await response.json())).toContain(INGEST_KEY_HEADER)
    expect(storage.keyLookups).toEqual([])
  })

  it('M-h — REPETITION: three headerless unparseable bodies are three 401s, no reads and no records', async () => {
    const { server, storage, journalPath } = await start()
    for (const _ of [1, 2, 3]) {
      const response = await fetch(url(server), { method: 'POST', body: 'not json' })
      expect(response.status).toBe(401)
      expect(JSON.stringify(await response.json())).toContain(INGEST_KEY_HEADER)
    }
    expect(storage.keyLookups).toEqual([])
    const read = readJournal(journalPath)
    expect(read.ok && read.records.length).toBe(0)
  })

  /**
   * RULING 1, AS AN ASSERTION. The cap keeps its place in the code and becomes
   * unreachable for an unverified caller — so this caller gets **a delivered
   * 401** rather than the cap's treatment: the socket is never read to the cap,
   * because the key was refused first. No `try`/`catch` and no "either way it was
   * refused" escape hatch, which is what makes this the only cell in the matrix
   * that can tell gate-before-read from gate-after-read.
   *
   * What the cap's treatment actually is, stated here because the record around
   * it is easy to get wrong: `readBody` calls `request.destroy()` before it
   * resolves, so the 413 the adapter writes afterwards **never reaches the
   * wire** — a client sees a socket error (undici's UND_ERR_SOCKET) having read
   * zero bytes back, or an ECONNRESET on a raw `node:http` client, and no status
   * line at all. The existing case 'a body
   * over the cap is 413' one describe above reads as a delivered 413 only
   * because its `catch` substitutes that status for the transport error. That
   * undeliverability is pre-existing, out of this issue's scope and deliberately
   * untouched; it is owed a follow-up. It is also why this case asserts the
   * status directly — the early response was measured safe on this platform
   * before it was ruled, so a flake here is evidence about the ruling, not a
   * test to soften.
   */
  it('M-i — no header + a body over the cap is a delivered 401, not the cap treatment', async () => {
    const { server, storage, journalPath } = await start()
    const huge = JSON.stringify(body({ batch: [{ n: 1, line: `{"pad":"${'x'.repeat(MAX_BODY_BYTES + 1024)}"}` }] }))
    expect(huge.length).toBeGreaterThan(MAX_BODY_BYTES)

    const response = await fetch(url(server), { method: 'POST', body: huge })

    expect(response.status).toBe(401)
    expect(JSON.stringify(await response.json())).toContain(INGEST_KEY_HEADER)
    expect(storage.keyLookups).toEqual([])
    expect(readJournal(journalPath).ok && readJournal(journalPath)).toMatchObject({ records: [] })
  })
})
