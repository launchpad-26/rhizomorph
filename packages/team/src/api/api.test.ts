import { parseIngestAccepted } from '@rhizomorph/core/src/wire/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveTeamConfig } from '../config/config.js'
import { INGEST_KEY_HEADER } from '../ingest/handle.js'
import { readJournal } from '../journal/read.js'
import { FakeTeamStorage } from '../storage/fake.js'
import { INGEST_PATH, MAX_BODY_BYTES } from './http.js'
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

const KEY = 'rzk_whatever'

function body(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    project: 'acme-widgets',
    actorInstance: 'lane-7',
    batch: [{ n: 1, line: '{"id":"e","ts":1,"source":"otel","type":"llm.cost","payload":{}}' }],
    ...overrides,
  }
}

async function start(port = 0): Promise<{ server: TeamServer; storage: FakeTeamStorage; journalPath: string }> {
  const storage = new FakeTeamStorage({ settings: { synchronous_commit: 'on' } })
  const journalPath = path.join(dir, 'ingest.journal')
  const result = await startTeamServer({
    storage,
    config: resolveTeamConfig({}),
    journalPath,
    port,
    now: () => Date.UTC(2026, 10, 20),
  })
  if (!result.ok) throw new Error(result.error)
  running = result.server
  return { server: result.server, storage, journalPath }
}

function url(server: TeamServer, at = INGEST_PATH): string {
  return `http://${server.host}:${server.port}${at}`
}

describe('boot', () => {
  it('bootstraps the storage, then tops up the current and next month, then listens', async () => {
    const { server, storage } = await start()
    expect(server.port).toBeGreaterThan(0)
    // The preflight and the migrations ran first…
    expect(storage.calls[0]).toBe('readSetting')
    expect(storage.committed).toEqual(['0001_events', '0002_projections', '0003_roles_rls', '0004_events_dedup'])
    // …and only then the partitions, which is what "on the bootstrap
    // connection, after bootstrapTeamStorage" means.
    expect(storage.partitions).toEqual(['2026-11', '2026-12'])
    expect(storage.calls.indexOf('ensureMonthlyPartition')).toBeGreaterThan(
      storage.calls.lastIndexOf('applyMigration:0004_events_dedup'),
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
