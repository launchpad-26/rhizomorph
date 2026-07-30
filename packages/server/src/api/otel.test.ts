import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'

/**
 * Injected-request integration test for the OTLP/HTTP receiver: real Fastify
 * routes, real body parsing, asserting on what actually lands in the recorder
 * — not just the pure parser (see `collectors/otel/parse-metrics.test.ts` for that).
 */

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../collectors/otel/fixtures/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>
}

describe('OTLP/HTTP receiver routes', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'observatory-otel-test-'))
    recorder = new SessionRecorder('1000', sessionFilePath(dir, '1000'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeApp() {
    return buildApp({ repoPath: '/repo', repoName: 'repo', sessionDir: dir, recorder })
  }

  it('POST /v1/metrics with a valid OTLP body records llm.usage / llm.cost events, authoritative and source: otel', async () => {
    const app = makeApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/metrics',
      payload: fixture('metrics-token-and-cost.json'),
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

  it('POST /v1/logs accepts a structurally valid OTLP export', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'POST', url: '/v1/logs', payload: fixture('logs-basic.json') })
    expect(response.statusCode).toBe(200)
  })

  it('POST /v1/logs with a malformed body responds 400 and records one collector.error', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'POST', url: '/v1/logs', payload: fixture('logs-malformed.json') })
    expect(response.statusCode).toBe(400)
    const errors = recorder.eventsSoFar().filter((e) => e.type === 'collector.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.payload).toMatchObject({ collector: 'otel' })
  })
})
