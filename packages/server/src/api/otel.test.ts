import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EventOf } from '@rhizomorph/core'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { FAULT_THROTTLE_MS, INSTANCE_ATTRIBUTE, registerOtelRoutes } from './otel.js'

/**
 * Injected-request integration test for the OTLP/HTTP receiver: real Fastify
 * routes, real body parsing, asserting on what actually lands in the recorder
 * — not just the pure parser (see `collectors/otel/parse-metrics.test.ts` for that).
 *
 * The instance id under test is the recorder's session id (`OUR_INSTANCE`),
 * which is what `/api/meta` publishes and `rhizomorph env` writes into a
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
  for (const key of ['resourceMetrics', 'resourceLogs', 'resourceSpans']) {
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
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-otel-test-'))
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

  it('POST /v1/traces declaring our instance records trace.span events, source: otel', async () => {
    const app = makeApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      payload: declaring(fixture('claude-code-2.1.220-traces-llm-request.json'), OUR_INSTANCE),
    })

    expect(response.statusCode).toBe(200)
    const spans = recorder.eventsSoFar().filter((e) => e.type === 'trace.span')
    expect(spans).toHaveLength(1)
    expect(spans[0]?.source).toBe('otel')
    expect(spans[0]?.payload).toMatchObject({ kind: 'llm_request', model: 'claude-haiku-4-5-20251001' })
    expect(refusals()).toHaveLength(0)
  })

  it('POST /v1/traces with a structurally malformed body responds 400 and records one collector.error, without crashing', async () => {
    const app = makeApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      payload: { notResourceSpans: [] },
    })

    expect(response.statusCode).toBe(400)
    const errors = recorder.eventsSoFar().filter((e) => e.type === 'collector.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.payload).toMatchObject({ collector: 'otel' })
    expect(refusals()).toHaveLength(0)
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
      expect(response.json()).toMatchObject({ error: expect.stringContaining('rhizomorph env') })

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
        payload: declaring(fixture('metrics-token-and-cost.json'), 'factory-rhizomorph-77'),
      })

      expect(response.statusCode).toBe(403)
      expect(refusals()[0]?.payload).toEqual({
        instance: 'factory-rhizomorph-77',
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
        payload: twoResourceBlocks(OUR_INSTANCE, 'factory-rhizomorph-77'),
      })

      expect(response.statusCode).toBe(403)
      expect(refusals()[0]?.payload).toMatchObject({ instance: 'factory-rhizomorph-77' })
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

    it('refuses a traces export that declares no instance: 403, telemetry.refused, and not one span recorded', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/v1/traces',
        payload: fixture('claude-code-2.1.220-traces-llm-request.json'),
      })

      expect(response.statusCode).toBe(403)
      expect(refusals()[0]?.payload).toEqual({ instance: null, expectedInstance: OUR_INSTANCE, count: 1 })
      expect(recorder.eventsSoFar().filter((e) => e.type === 'trace.span')).toHaveLength(0)
    })

    it('refuses a traces export that declares someone else, and names them in the event', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/v1/traces',
        payload: declaring(fixture('claude-code-2.1.220-traces-llm-request.json'), 'factory-rhizomorph-77'),
      })

      expect(response.statusCode).toBe(403)
      expect(refusals()[0]?.payload).toEqual({
        instance: 'factory-rhizomorph-77',
        expectedInstance: OUR_INSTANCE,
        count: 1,
      })
      expect(recorder.eventsSoFar().filter((e) => e.type === 'trace.span')).toHaveLength(0)
    })

    /**
     * The gate fix this issue exists to prove: without `resourceSpans` in
     * `declaredInstances()`, a correctly-tagged trace POST declares an
     * instance the check never looks for and is refused as foreign.
     */
    it('accepts a correctly-tagged trace POST rather than refusing it as foreign (the resourceSpans gate fix)', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/v1/traces',
        payload: declaring(fixture('claude-code-2.1.220-traces-llm-request.json'), OUR_INSTANCE),
      })

      expect(response.statusCode).toBe(200)
      expect(refusals()).toHaveLength(0)
      expect(recorder.eventsSoFar().filter((e) => e.type === 'trace.span')).toHaveLength(1)
    })
  })

  describe('the bare-path fallback route (ADR-0018)', () => {
    it('routes a bare POST carrying resourceMetrics to the same handling as /v1/metrics', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/',
        payload: declaring(fixture('metrics-token-and-cost.json'), OUR_INSTANCE),
      })

      expect(response.statusCode).toBe(200)
      const costs = recorder.eventsSoFar().filter((e) => e.type === 'llm.cost')
      expect(costs.length).toBeGreaterThan(0)
      expect(refusals()).toHaveLength(0)
    })

    it('routes a bare POST carrying resourceLogs to the same handling as /v1/logs', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/',
        payload: declaring(fixture('logs-basic.json'), OUR_INSTANCE),
      })

      expect(response.statusCode).toBe(200)
      expect(refusals()).toHaveLength(0)
    })

    it('routes a bare POST carrying resourceSpans to the same handling as /v1/traces', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/',
        payload: declaring(fixture('claude-code-2.1.220-traces-llm-request.json'), OUR_INSTANCE),
      })

      expect(response.statusCode).toBe(200)
      const spans = recorder.eventsSoFar().filter((e) => e.type === 'trace.span')
      expect(spans).toHaveLength(1)
      expect(spans[0]?.source).toBe('otel')
      expect(refusals()).toHaveLength(0)
    })

    it('refuses a bare POST from a foreign instance exactly as loudly as the native routes', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/',
        payload: declaring(fixture('metrics-token-and-cost.json'), 'factory-rhizomorph-77'),
      })

      expect(response.statusCode).toBe(403)
      expect(refusals()[0]?.payload).toMatchObject({ instance: 'factory-rhizomorph-77' })
      expect(recorder.eventsSoFar().filter((e) => e.type === 'llm.cost')).toHaveLength(0)
    })

    it('refuses a bare POST naming none of resourceMetrics/resourceLogs/resourceSpans, by name, without crashing', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/',
        payload: { someOtherShape: [] },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({
        error: expect.stringContaining('expected exactly one of resourceMetrics, resourceLogs, resourceSpans'),
      })
      const errors = recorder.eventsSoFar().filter((e) => e.type === 'collector.error')
      expect(errors).toHaveLength(1)
      expect(errors[0]?.payload).toMatchObject({ collector: 'otel' })
      expect(refusals()).toHaveLength(0)
    })

    it('refuses a bare POST naming more than one shape at once, rather than guessing which to parse, and names both in the detail', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/',
        payload: {
          ...declaring(fixture('metrics-token-and-cost.json'), OUR_INSTANCE),
          ...declaring(fixture('logs-basic.json'), OUR_INSTANCE),
        },
      })

      expect(response.statusCode).toBe(400)
      const body = response.json() as { error: string }
      expect(body.error).toContain('ambiguous OTLP body')
      expect(body.error).toContain('resourceMetrics')
      expect(body.error).toContain('resourceLogs')
      const errors = recorder.eventsSoFar().filter((e) => e.type === 'collector.error')
      expect(errors).toHaveLength(1)
      expect(recorder.eventsSoFar().filter((e) => e.type === 'llm.cost')).toHaveLength(0)
    })

    /**
     * The gate fix this issue's review found (#321): `classifyBareBody` used
     * to filter on `Array.isArray(body[key])`, so a *named* key with the
     * wrong-shaped value was invisible to it — a body carrying a valid,
     * instance-tagged metrics export **and** a bogus, non-array `resourceLogs`
     * routed straight past the second key as if it were never there, landing
     * as an ordinary 200 with the metrics events recorded and the malformed
     * `resourceLogs` silently dropped (the metrics schema's `.passthrough()`
     * lets an unrelated key ride along unexamined). Presence (`!==
     * undefined`) sees both named keys and refuses the body as ambiguous
     * instead — the same all-or-nothing posture `foreignInstance` already
     * takes for a body naming two instances.
     */
    it('refuses a bare POST naming a valid metrics shape alongside a wrongly-shaped resourceLogs key, rather than routing past the second key unseen', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/',
        payload: {
          ...declaring(fixture('metrics-token-and-cost.json'), OUR_INSTANCE),
          resourceLogs: 'not-an-array',
        },
      })

      expect(response.statusCode).toBe(400)
      const body = response.json() as { error: string }
      expect(body.error).toContain('ambiguous OTLP body')
      const errors = recorder.eventsSoFar().filter((e) => e.type === 'collector.error')
      expect(errors).toHaveLength(1)
      expect(recorder.eventsSoFar().filter((e) => e.type === 'llm.usage' || e.type === 'llm.cost')).toHaveLength(0)
    })

    it('refuses a bare foreign-instance POST carrying resourceLogs, not only resourceMetrics', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/',
        payload: declaring(fixture('logs-basic.json'), 'factory-rhizomorph-77'),
      })

      expect(response.statusCode).toBe(403)
      expect(refusals()[0]?.payload).toMatchObject({ instance: 'factory-rhizomorph-77' })
    })

    it('refuses a bare POST with an empty resourceMetrics array exactly like the native route — no identity is not our identity', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/',
        payload: { resourceMetrics: [] },
      })

      expect(response.statusCode).toBe(403)
      expect(refusals()[0]?.payload).toMatchObject({ instance: null, count: 1 })
    })

    it('refuses a bare POST whose body is a scalar JSON value, naming that it is not a JSON object', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        payload: '42',
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: 'unrecognized OTLP body: not a JSON object' })
      const errors = recorder.eventsSoFar().filter((e) => e.type === 'collector.error')
      expect(errors).toHaveLength(1)
    })
  })

  describe('FAULT_THROTTLE_MS', () => {
    /**
     * Every throttle assertion in this file is written relative to the
     * constant (`+ FAULT_THROTTLE_MS - 1`, `+ FAULT_THROTTLE_MS`), so none of
     * them would notice the window shrinking — a test suite that can't fail
     * for the reason it claims (AGENTS.md's "what mutation would this test
     * survive?"). This pins the actual value both throttles below share.
     */
    it('is exactly one minute', () => {
      expect(FAULT_THROTTLE_MS).toBe(60_000)
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
        expect((await post(app, 'factory-rhizomorph-77')).statusCode).toBe(403)
      }

      // Four refused posts, one event: the first, standing alone.
      expect(refusals()).toHaveLength(1)
      expect(refusals()[0]?.payload).toMatchObject({ instance: 'factory-rhizomorph-77', count: 1 })

      // One millisecond inside the window: refused, still silent in the log.
      clock.ms = start + FAULT_THROTTLE_MS - 1
      expect((await post(app, 'factory-rhizomorph-77')).statusCode).toBe(403)
      expect(refusals()).toHaveLength(1)

      // The moment the window closes: one more event, counting every post
      // swallowed since the last one (four) plus this one.
      clock.ms = start + FAULT_THROTTLE_MS
      expect((await post(app, 'factory-rhizomorph-77')).statusCode).toBe(403)
      expect(refusals()).toHaveLength(2)
      expect(refusals()[1]?.payload).toMatchObject({
        instance: 'factory-rhizomorph-77',
        count: 5,
      })
      expect(refusals()[1]?.ts).toBe(start + FAULT_THROTTLE_MS)
    })

    it('throttles per offender, so a second misconfigured instance is still heard immediately', async () => {
      const clock = { ms: 5_000 }
      const app = appWithClock(clock)

      await post(app, 'factory-rhizomorph-77')
      await post(app, 'factory-rhizomorph-77')
      await post(app, 'another-repo')
      await post(app, null)

      expect(refusals().map((event) => event.payload.instance)).toEqual([
        'factory-rhizomorph-77',
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

  describe('the collector.error fault throttle (#472)', () => {
    /**
     * A misconfigured exporter posts the identical malformed body every few
     * seconds; the log must show one standing fault carrying a count, not
     * one event per POST — the same discipline the refusal throttle above
     * already has, generalised to route-level malformed-body faults. Own
     * Fastify instance so the throttle's clock is injected.
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

    function collectorErrors(): Array<EventOf<'collector.error'>> {
      return recorder
        .eventsSoFar()
        .filter((event): event is EventOf<'collector.error'> => event.type === 'collector.error')
    }

    async function postMalformedMetrics(app: ReturnType<typeof Fastify>) {
      return await app.inject({ method: 'POST', url: '/v1/metrics', payload: fixture('metrics-malformed.json') })
    }

    async function postMalformedLogs(app: ReturnType<typeof Fastify>) {
      return await app.inject({ method: 'POST', url: '/v1/logs', payload: fixture('logs-malformed.json') })
    }

    async function postMalformedTraces(app: ReturnType<typeof Fastify>) {
      return await app.inject({ method: 'POST', url: '/v1/traces', payload: { notResourceSpans: [] } })
    }

    it("an unread-records fault on a VALID post is throttled too — claude's ordinary export must not flood the feed", async () => {
      // The regression the verify pass on #323 measured. `metrics-token-and-cost.json`
      // is a real claude capture carrying `claude_code.session.count`, which this
      // receiver does not read — so every ordinary export reports an unread
      // record. Recorded outside the throttle that was one event per export,
      // i.e. one per 5s per `OTEL_METRIC_EXPORT_INTERVAL`, forever: 20 posts
      // flipped `collectors.otel` to `error`, and 205 reached `MAX_ERRORS` and
      // began evicting real faults.
      const start = 5_000
      const clock = { ms: start }
      const app = appWithClock(clock)
      const valid = declaring(fixture('metrics-token-and-cost.json'), OUR_INSTANCE)

      // Twelve posts at the real 5s interval — 55s, inside one 60s window, so
      // the honest answer is exactly one event. (Twenty posts would span 100s
      // and legitimately open a second window; that is the throttle working,
      // not failing, and getting this arithmetic wrong is how a correct fix
      // looks broken.)
      for (let i = 0; i < 12; i += 1) {
        clock.ms = start + i * 5_000 // the repo's own export interval
        expect((await app.inject({ method: 'POST', url: '/v1/metrics', payload: valid })).statusCode).toBe(200)
      }

      // One standing fault, not twelve. The count belongs to the throttle, and
      // the message carries no number of its own — that is what keys the window.
      expect(collectorErrors()).toHaveLength(1)
      expect(collectorErrors()[0]?.payload).toMatchObject({
        collector: 'otel',
        message: "a known harness sent records this receiver doesn't fully read",
      })
    })

    it('the traces sibling throttles too — one bad span in a VALID post does not flood the feed', async () => {
      // The structurally identical sibling, one screen down in the same file.
      // `parse-traces.ts` has emitted a per-span `collector.error` on an
      // otherwise-valid request since #510, and that path was outside the
      // throttle for exactly the same reason the metrics one was. Fixing only
      // the case #323 happened to surface is the defect shape AGENTS.md names
      // first, so this asserts the sibling directly rather than trusting the
      // shared code path.
      const start = 5_000
      const clock = { ms: start }
      const app = appWithClock(clock)
      // Valid ExportTraceServiceRequest; the single span is missing traceId, so
      // `buildSpanEvent` degrades it to a collector.error and the POST is 200.
      const oneBadSpan = declaring(
        {
          resourceSpans: [
            { scopeSpans: [{ spans: [{ spanId: 'b'.repeat(16), name: 'tool_decision' }] }] },
          ],
        },
        OUR_INSTANCE,
      )

      for (let i = 0; i < 4; i += 1) {
        clock.ms = start + i * 1_000 // 3s total, well inside one 60s window
        expect((await app.inject({ method: 'POST', url: '/v1/traces', payload: oneBadSpan })).statusCode).toBe(200)
      }

      // One standing fault, not four. Before the fix this read 4.
      expect(collectorErrors()).toHaveLength(1)
      expect(collectorErrors()[0]?.payload).toMatchObject({
        collector: 'otel',
        message: 'malformed span: missing traceId, spanId, or name',
      })
    })

    it('coalesces repeated posts of the identical fault into one event carrying a count, exactly like telemetry.refused', async () => {
      const start = 5_000
      const clock = { ms: start }
      const app = appWithClock(clock)

      for (let i = 0; i < 4; i += 1) {
        clock.ms = start + i * 1_000
        expect((await postMalformedMetrics(app)).statusCode).toBe(400)
      }

      // Four malformed posts, one event: the first, standing alone.
      expect(collectorErrors()).toHaveLength(1)
      expect(collectorErrors()[0]?.payload).toMatchObject({
        collector: 'otel',
        message: 'malformed OTLP metrics export request',
        count: 1,
      })

      // One millisecond inside the window: still 400, still silent in the log.
      clock.ms = start + FAULT_THROTTLE_MS - 1
      expect((await postMalformedMetrics(app)).statusCode).toBe(400)
      expect(collectorErrors()).toHaveLength(1)

      // The moment the window closes: one more event, counting every post
      // swallowed since the last one (four) plus this one.
      clock.ms = start + FAULT_THROTTLE_MS
      expect((await postMalformedMetrics(app)).statusCode).toBe(400)
      expect(collectorErrors()).toHaveLength(2)
      expect(collectorErrors()[1]?.payload).toMatchObject({
        message: 'malformed OTLP metrics export request',
        count: 5,
      })
      expect(collectorErrors()[1]?.ts).toBe(start + FAULT_THROTTLE_MS)
    })

    it('throttles per fault signature, so a different fault on the same route is still heard immediately', async () => {
      const clock = { ms: 5_000 }
      const app = appWithClock(clock)

      await postMalformedMetrics(app)
      await postMalformedMetrics(app)
      const invalidJson = await app.inject({
        method: 'POST',
        url: '/v1/metrics',
        headers: { 'content-type': 'application/json' },
        payload: '{ this is not valid json',
      })

      expect(invalidJson.statusCode).toBe(400)
      expect(collectorErrors().map((event) => event.payload.message)).toEqual([
        'malformed OTLP metrics export request',
        'malformed OTLP request body',
      ])
      for (const event of collectorErrors()) {
        expect(event.payload.count).toBe(1)
      }
    })

    it('never throttles a valid post: acceptance keeps recording normally after repeated malformed posts of the same fault', async () => {
      const clock = { ms: 5_000 }
      const app = appWithClock(clock)

      await postMalformedMetrics(app)
      clock.ms += 1_000
      await postMalformedMetrics(app)

      // metrics-conductor.json, not metrics-token-and-cost.json: the latter
      // also carries claude_code.session.count, a metric name outside
      // claude's profile that #323 now (correctly) surfaces as its own
      // collector.error — this test is about the fault throttle leaving a
      // *clean* valid post alone, so it needs a fixture with nothing else to
      // report.
      const response = await app.inject({
        method: 'POST',
        url: '/v1/metrics',
        payload: declaring(fixture('metrics-conductor.json'), OUR_INSTANCE),
      })

      expect(response.statusCode).toBe(200)
      expect(collectorErrors()).toHaveLength(1)
      expect(recorder.eventsSoFar().filter((e) => e.type === 'llm.cost').length).toBeGreaterThan(0)
    })

    /**
     * The metrics case above proves coalescing over a clock; this and the
     * traces test below prove the two sites whose collector.error event
     * arrives pre-built from the parser (`result.events`, intercepted by
     * `event.type === 'collector.error'` in otel.ts) are wired into the same
     * throttle, not just forwarded verbatim. Without this test, reverting
     * that interception to a plain `ctx.recorder.record(event)` loop leaves
     * every other otel.test.ts case green.
     */
    it('coalesces repeated malformed logs posts across a throttle window, the second recorded event carrying the count', async () => {
      const start = 5_000
      const clock = { ms: start }
      const app = appWithClock(clock)

      // First post of this fault: recorded immediately, standing alone.
      expect((await postMalformedLogs(app)).statusCode).toBe(400)
      expect(collectorErrors()).toHaveLength(1)
      expect(collectorErrors()[0]?.payload).toMatchObject({
        collector: 'otel',
        message: 'malformed OTLP logs export request',
        count: 1,
      })

      // Second post, still inside the window: suppressed, not a new event.
      clock.ms = start + 1_000
      expect((await postMalformedLogs(app)).statusCode).toBe(400)
      expect(collectorErrors()).toHaveLength(1)

      // The window closes: one more event, carrying the one post it swallowed
      // plus this one.
      clock.ms = start + FAULT_THROTTLE_MS
      expect((await postMalformedLogs(app)).statusCode).toBe(400)
      expect(collectorErrors()).toHaveLength(2)
      expect(collectorErrors()[1]?.payload).toMatchObject({
        message: 'malformed OTLP logs export request',
        count: 2,
      })
    })

    it('coalesces repeated malformed traces posts across a throttle window, the second recorded event carrying the count', async () => {
      const start = 5_000
      const clock = { ms: start }
      const app = appWithClock(clock)

      expect((await postMalformedTraces(app)).statusCode).toBe(400)
      expect(collectorErrors()).toHaveLength(1)
      expect(collectorErrors()[0]?.payload).toMatchObject({
        collector: 'otel',
        message: 'malformed OTLP traces export request',
        count: 1,
      })

      clock.ms = start + 1_000
      expect((await postMalformedTraces(app)).statusCode).toBe(400)
      expect(collectorErrors()).toHaveLength(1)

      clock.ms = start + FAULT_THROTTLE_MS
      expect((await postMalformedTraces(app)).statusCode).toBe(400)
      expect(collectorErrors()).toHaveLength(2)
      expect(collectorErrors()[1]?.payload).toMatchObject({
        message: 'malformed OTLP traces export request',
        count: 2,
      })
    })

    it('keys the bare route\'s unrecognized-body fault separately from a native route\'s malformed-body fault', async () => {
      const clock = { ms: 5_000 }
      const app = appWithClock(clock)

      await postMalformedMetrics(app)
      const bare = await app.inject({ method: 'POST', url: '/', payload: { someOtherShape: [] } })

      expect(bare.statusCode).toBe(400)
      expect(collectorErrors().map((event) => event.payload.message)).toEqual([
        'malformed OTLP metrics export request',
        'unrecognized OTLP body at the bare endpoint',
      ])
      for (const event of collectorErrors()) {
        expect(event.payload.count).toBe(1)
      }
    })
  })
})
