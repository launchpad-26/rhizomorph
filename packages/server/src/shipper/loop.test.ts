import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent, eventToLine } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEAM_CONFIG_VERSION, writeTeamConfig } from './config.js'
import { writeIngestKey } from './key.js'
import type { FetchLike } from './post.js'
import {
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  resolveIntervalMs,
  runShipperLoop,
  shipperStatus,
} from './loop.js'
import type { ShipPassResult } from './ship.js'

const FIXTURE_KEY = 'rzk_LOOPFIXTUREVALUE0123456789'

let sessionDir: string

function acceptingFetch(): FetchLike {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { batch: unknown[] }
    return new Response(JSON.stringify({ accepted: body.batch.length, journalSeq: 1 }), { status: 202 })
  }) as FetchLike
}

async function enable(): Promise<void> {
  await writeIngestKey(sessionDir, FIXTURE_KEY)
  await writeTeamConfig(sessionDir, {
    version: TEAM_CONFIG_VERSION,
    url: 'https://team.example',
    project: 'acme-widgets',
    enabledAt: 1,
  })
}

async function seed(): Promise<void> {
  await writeFile(
    path.join(sessionDir, 'session-1785900000000.jsonl'),
    `${eventToLine(createEvent('pane.activity', { paneId: '%1', contentHash: 'h1', previousHash: null }, { id: 'e1', ts: 1785900000000 }))}\n`,
  )
}

beforeEach(async () => {
  sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-shipper-loop-'))
})

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true })
})

describe('the batch timer — foreground, bounded, and stoppable on the tick boundary', () => {
  it('--once runs exactly one pass and waits for nothing', async () => {
    await enable()
    await seed()
    const passes: ShipPassResult[] = []

    const result = await runShipperLoop({
      sessionDir,
      once: true,
      fetch: acceptingFetch(),
      log: { pass: (pass) => passes.push(pass) },
      delay: async () => {
        throw new Error('--once must not wait')
      },
    })

    expect(result.passes).toBe(1)
    expect(result.waits).toEqual([])
    expect(passes).toHaveLength(1)
    expect(passes[0]?.enabled).toBe(true)
  })

  it('runs three passes at exactly the configured spacing, then stops when the signal fires', async () => {
    await enable()
    await seed()
    const controller = new AbortController()
    let ticks = 0

    const result = await runShipperLoop({
      sessionDir,
      intervalMs: 7_000,
      signal: controller.signal,
      fetch: acceptingFetch(),
      delay: async () => {
        ticks += 1
        if (ticks === 3) controller.abort()
      },
    })

    expect(result.passes).toBe(3)
    expect(result.waits).toEqual([7_000, 7_000, 7_000])
    expect(result.intervalMs).toBe(7_000)
    expect(result.clamped).toBe(false)
  })

  it('a pass that throws is reported and the loop keeps going — the next tick still runs', async () => {
    await enable()
    await seed()
    const controller = new AbortController()
    const errors: string[] = []
    let ticks = 0

    // A `fetch` is never reached: the enable record itself is what throws, and
    // it throws on every pass, so surviving it is the whole assertion.
    await writeFile(path.join(sessionDir, 'shipper', 'team.json'), '{ not json')

    const result = await runShipperLoop({
      sessionDir,
      intervalMs: MIN_INTERVAL_MS,
      signal: controller.signal,
      log: { error: (message) => errors.push(message) },
      delay: async () => {
        ticks += 1
        if (ticks === 2) controller.abort()
      },
    })

    expect(result.passes).toBe(2)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('team.json')
  })

  it('an already-aborted signal ends it before the first pass', async () => {
    await enable()
    await seed()
    const controller = new AbortController()
    controller.abort()

    const result = await runShipperLoop({ sessionDir, signal: controller.signal, fetch: acceptingFetch() })
    expect(result.passes).toBe(0)
  })

  it('an abort raised mid-wait ends the loop rather than surfacing as a failure', async () => {
    await enable()
    await seed()
    const controller = new AbortController()

    const result = await runShipperLoop({
      sessionDir,
      signal: controller.signal,
      fetch: acceptingFetch(),
      delay: async () => {
        controller.abort()
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      },
    })

    expect(result.passes).toBe(1)
    expect(result.waits).toEqual([DEFAULT_INTERVAL_MS])
  })

  it('clamps an interval below the floor and says so', () => {
    expect(resolveIntervalMs(undefined)).toEqual({ intervalMs: DEFAULT_INTERVAL_MS, clamped: false })
    expect(resolveIntervalMs(1_000)).toEqual({ intervalMs: MIN_INTERVAL_MS, clamped: true })
    expect(resolveIntervalMs(MIN_INTERVAL_MS)).toEqual({ intervalMs: MIN_INTERVAL_MS, clamped: false })
    expect(resolveIntervalMs(60_000)).toEqual({ intervalMs: 60_000, clamped: false })
  })

  it('reports the clamp on the result the CLI prints, not only in the resolver', async () => {
    await enable()
    await seed()
    const result = await runShipperLoop({ sessionDir, intervalMs: 900, once: true, fetch: acceptingFetch() })
    expect(result.clamped).toBe(true)
    expect(result.intervalMs).toBe(MIN_INTERVAL_MS)
  })

  it('the default wait really is node:timers/promises, honouring an abort rather than sleeping through it', async () => {
    await enable()
    await seed()
    const controller = new AbortController()
    // No injected delay: this exercises the real one, with a 30 s interval that
    // would hang the suite if the signal were not passed through.
    const started = Date.now()
    setTimeout(() => controller.abort(), 5)
    const result = await runShipperLoop({ sessionDir, signal: controller.signal, fetch: acceptingFetch() })
    expect(result.passes).toBe(1)
    expect(Date.now() - started).toBeLessThan(DEFAULT_INTERVAL_MS)
  })
})

describe('the read-only report', () => {
  it('says off, with nothing else to say, when there is no enable record', async () => {
    expect(await shipperStatus(sessionDir)).toEqual({
      enabled: false,
      url: null,
      project: null,
      enabledAt: null,
      keyPresent: false,
      keyMode: null,
      actors: [],
      cursorReset: null,
    })
  })

  it('reports the destination, the project, the credential\'s presence and how far each session has shipped — never a value', async () => {
    await enable()
    await seed()
    await runShipperLoop({ sessionDir, once: true, fetch: acceptingFetch() })

    const status = await shipperStatus(sessionDir)
    expect(status.enabled).toBe(true)
    expect(status.url).toBe('https://team.example')
    expect(status.project).toBe('acme-widgets')
    expect(status.keyPresent).toBe(true)
    expect(status.actors).toEqual([
      expect.objectContaining({ actorInstance: '1785900000000', n: 1, skippedCount: 0 }),
    ])
    expect(JSON.stringify(status)).not.toContain(FIXTURE_KEY)
  })

  it('surfaces a cursor reset so a cold start is never silent', async () => {
    await enable()
    await writeFile(path.join(sessionDir, 'shipper', 'cursor.json'), '{ not json')
    const status = await shipperStatus(sessionDir)
    expect(status.cursorReset).toContain('not valid JSON')
  })
})
