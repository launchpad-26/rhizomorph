import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EventOf } from '@observatory/core'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { INSTANCE_ATTRIBUTE, REFUSAL_THROTTLE_MS, registerOtelRoutes } from './otel.js'

/**
 * Injected-request integration test for the OTLP/HTTP receiver: real Fastify
 * routes, real body parsing, asserting on what actually lands in the recorder
 * — not just the pure parser (see `collectors/otel/parse-metrics.test.ts` for that).
 *
 * The instance id under test is the recorder's session id (`OUR_INSTANCE`),
 * which is what `/api/meta` publishes and `observatory env` writes into a
 * lane's `OTEL_RESOURCE_ATTRIBUTES`.
 */

const OUR_INSTANCE = '1000'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../collectors/otel/fixtures/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>
}

/**
 * The fixtures predate #60, so they carry lane/role but no instance — exactly
 * what a foreign exporter looks like. This stamps one in, the same way the env
 * block does, so each test says which instance its post claims to belong to.
 */
function declaring(
  body: Record<string, unknown>,
  instance: string | null,
  options: { onlyFirstBlock?: boolean } = {},
): Record<string, unknown> {
  const stamped = structuredClone(body)
  for (const key of ['resourceMetrics', 'resourceLogs']) {
    const blocks = stamped[key]
    if (!Array.isArray(blocks)) continue
    blocks.forEach((block, index) => {
      if (options.onlyFirstBlock && index > 0) return
      if (instance === null) return
      const resource = (block as { resource?: { attributes?: unknown[] } }).resource ?? {}
      const attributes = Array.isArray(resource.attributes) ? resource.attributes : []
      resource.attributes = [
        ...attributes,
        { key: INSTANCE_ATTRIBUTE, value: { stringValue: instance } },
      ]
      ;(block as { resource?: unknown }).resource = resource
    })
  }
  return stamped
}

/** A metrics body whose two resource blocks disagree: ours, then a stranger's. */
function twoResourceBlocks(first: string, second: string): Record<string, unknown> {
  const ours = declaring(fixture('metrics-token-and-cost.json'), first)
  const theirs = declaring(fixture('metrics-token-and-cost.json'), second)
  return {
    resourceMetrics: [
      ...(ours.resourceMetrics as unknown[]),
      ...(theirs.resourceMetrics as unknown[]),
    ],
  }
}

describe('OTLP/HTTP receiver routes', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'observatory-otel-test-'))
    recorder = new SessionRecorder(OUR_INSTANCE, sessionFilePath(dir, OUR_INSTANCE))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeApp() {
    return buildApp({ repoPath: '/repo', repoName: 'repo', sessionDir: dir, recorder })
  }

  function refusals(): Array<EventOf<'telemetry.refused'>> {
    return recorder
      .eventsSoFar()
      .filter((event): event is EventOf<'telemetry.refused'> => event.type === 'telemetry.refused')
  }

  it('POST /v1/metrics declaring our instance records llm.usage / llm.cost events, authoritative and source: otel', async () => {
    const app = makeApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/metrics',
      payload: declaring(fixture('metrics-token-and-cost.json'), OUR_INSTANCE),
    })

    expect(response.statusCode).toBe(200)

    const events = recorder.eventsSoFar()
    const usage = events.filter((e) => e.type === 'llm.usage')
    const costs = events.filter((e) => e.type === 'llm.cost')
    expect(usage.length).toBeGreaterThan(0)
    expect(costs.length).toBeGreaterThan(0)
    for (const event of [...usage, ...costs]) {
      expect(event.source).toBe('otel')
    }
    expect(costs[0]?.payload).toMatchObject({ authoritative: true, costUsd: 0.0588372 })
    expect(refusals()).toHaveLength(0)
  })

  it('POST /v1/metrics with a structurally malformed body responds 400 and records one collector.error, without crashing', async () => {
    const app = makeApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/metrics',
      payload: fixture('metrics-malformed.json'),
    })

    expect(response.statusCode).toBe(400)
    const errors = recorder.eventsSoFar().filter((e) => e.type === 'collector.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.payload).toMatchObject({ collector: 'otel' })
    // A malformed body is a 400 whoever sent it — the fault reported is the
    // real one, not a refusal for the instance it never got as far as declaring.
    expect(refusals()).toHaveLength(0)
  })

  it('POST /v1/metrics with syntactically invalid JSON responds 400 and records a collector.error instead of crashing the server', async () => {
    const app = makeApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/metrics',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not valid json',
    })

    expect(response.statusCode).toBe(400)
    const errors = recorder.eventsSoFar().filter((e) => e.type === 'collector.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.payload).toMatchObject({ collector: 'otel' })

    // the server itself is unharmed — an unrelated route still answers normally
    const meta = await app.inject({ method: 'GET', url: '/api/meta' })
    expect(meta.statusCode).toBe(200)
  })

  it('POST /v1/logs declaring our instance is accepted', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      payload: declaring(fixture('logs-basic.json'), OUR_INSTANCE),
    })
    expect(response.statusCode).toBe(200)
    expect(refusals()).toHaveLength(0)
  })

  it('POST /v1/logs with a malformed body responds 400 and records one collector.error', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'POST', url: '/v1/logs', payload: fixture('logs-malformed.json') })
    expect(response.statusCode).toBe(400)
    const errors = recorder.eventsSoFar().filter((e) => e.type === 'collector.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.payload).toMatchObject({ collector: 'otel' })
  })

  describe('foreign traffic is refused, loudly', () => {
    it('refuses a metrics export that declares no instance: 403, telemetry.refused, and not one token recorded', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/v1/metrics',
        payload: fixture('metrics-token-and-cost.json'),
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: expect.stringContaining('observatory env') })

      expect(refusals()).toHaveLength(1)
      expect(refusals()[0]?.payload).toEqual({
        instance: null,
        expectedInstance: OUR_INSTANCE,
        count: 1,
      })
      expect(refusals()[0]?.source).toBe('otel')
      // The whole point: a refused post adds nothing to this repo's numbers.
      expect(recorder.eventsSoFar().filter((e) => e.type === 'llm.usage')).toHaveLength(0)
      expect(recorder.eventsSoFar().filter((e) => e.type === 'llm.cost')).toHaveLength(0)
    })

    it('refuses a metrics export that declares someone else, and names them in the event', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/v1/metrics',
        payload: declaring(fixture('metrics-token-and-cost.json'), 'factory-observatory-77'),
      })

      expect(response.statusCode).toBe(403)
      expect(refusals()[0]?.payload).toEqual({
        instance: 'factory-observatory-77',
        expectedInstance: OUR_INSTANCE,
        count: 1,
      })
      expect(recorder.eventsSoFar().filter((e) => e.type === 'llm.usage')).toHaveLength(0)
    })

    it('refuses a logs export with no instance the same way', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/v1/logs',
        payload: fixture('logs-basic.json'),
      })

      expect(response.statusCode).toBe(403)
      expect(refusals()[0]?.payload).toMatchObject({ instance: null, count: 1 })
    })

    it('refuses a body that mixes our instance with a stranger, rather than merging the half it likes', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/v1/metrics',
        payload: twoResourceBlocks(OUR_INSTANCE, 'factory-observatory-77'),
      })

      expect(response.statusCode).toBe(403)
      expect(refusals()[0]?.payload).toMatchObject({ instance: 'factory-observatory-77' })
      expect(recorder.eventsSoFar().filter((e) => e.type === 'llm.usage')).toHaveLength(0)
    })

    it('refuses an export with no resource blocks at all — no identity is not our identity', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/v1/metrics',
        payload: { resourceMetrics: [] },
      })

      expect(response.statusCode).toBe(403)
      expect(refusals()[0]?.payload).toMatchObject({ instance: null, count: 1 })
    })
  })

  describe('the refusal throttle', () => {
    /**
     * A misconfigured fleet exports every few seconds; the log must show one
     * standing fault, not one event per post. Own Fastify instance so the
     * throttle's clock is injected and the test never touches real time.
     */
    function appWithClock(clock: { ms: number }) {
      const app = Fastify()
      registerOtelRoutes(
        app,
        { repoPath: '/repo', repoName: 'repo', sessionDir: dir, recorder },
        { now: () => clock.ms },
      )
      return app
    }

    async function post(app: ReturnType<typeof Fastify>, instance: string | null) {
      return await app.inject({
        method: 'POST',
        url: '/v1/metrics',
        payload: declaring(fixture('metrics-token-and-cost.json'), instance),
      })
    }

    it('records one event per offender per minute, with a count of the posts it stands for', async () => {
      const start = 5_000
      const clock = { ms: start }
      const app = appWithClock(clock)

      for (let i = 0; i < 4; i += 1) {
        clock.ms = start + i * 1_000
        expect((await post(app, 'factory-observatory-77')).statusCode).toBe(403)
      }

      // Four refused posts, one event: the first, standing alone.
      expect(refusals()).toHaveLength(1)
      expect(refusals()[0]?.payload).toMatchObject({ instance: 'factory-observatory-77', count: 1 })

      // One millisecond inside the window: refused, still silent in the log.
      clock.ms = start + REFUSAL_THROTTLE_MS - 1
      expect((await post(app, 'factory-observatory-77')).statusCode).toBe(403)
      expect(refusals()).toHaveLength(1)

      // The moment the window closes: one more event, counting every post
      // swallowed since the last one (four) plus this one.
      clock.ms = start + REFUSAL_THROTTLE_MS
      expect((await post(app, 'factory-observatory-77')).statusCode).toBe(403)
      expect(refusals()).toHaveLength(2)
      expect(refusals()[1]?.payload).toMatchObject({
        instance: 'factory-observatory-77',
        count: 5,
      })
      expect(refusals()[1]?.ts).toBe(start + REFUSAL_THROTTLE_MS)
    })

    it('throttles per offender, so a second misconfigured instance is still heard immediately', async () => {
      const clock = { ms: 5_000 }
      const app = appWithClock(clock)

      await post(app, 'factory-observatory-77')
      await post(app, 'factory-observatory-77')
      await post(app, 'another-repo')
      await post(app, null)

      expect(refusals().map((event) => event.payload.instance)).toEqual([
        'factory-observatory-77',
        'another-repo',
        null,
      ])
      for (const event of refusals()) {
        expect(event.payload.count).toBe(1)
      }
    })

    it('never throttles acceptance: our own instance keeps being recorded post after post', async () => {
      const clock = { ms: 5_000 }
      const app = appWithClock(clock)

      expect((await post(app, OUR_INSTANCE)).statusCode).toBe(200)
      const perPost = recorder.eventsSoFar().filter((e) => e.type === 'llm.cost').length
      expect(perPost).toBeGreaterThan(0)

      for (let i = 0; i < 2; i += 1) {
        clock.ms += 1_000
        expect((await post(app, OUR_INSTANCE)).statusCode).toBe(200)
      }

      expect(refusals()).toHaveLength(0)
      expect(recorder.eventsSoFar().filter((e) => e.type === 'llm.cost')).toHaveLength(perPost * 3)
    })
  })
})
