import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli, type CliHandle } from './index.js'
import { fetchInstanceId, metaUrl, otlpEndpoint, renderTelemetryEnv } from './telemetry-env.js'

/** A `fetch` that answers one `/api/meta` body, without a socket. */
function metaFetch(body: unknown, init: ResponseInit = {}): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify(body), init)) as typeof globalThis.fetch
}

describe('renderTelemetryEnv', () => {
  const instance = '1785458425389'

  it('emits an exportable env block pointed at this server\'s OTLP receiver', () => {
    const block = renderTelemetryEnv({ lane: 'test-lane', role: 'worker', port: 4321, instance })

    expect(block).toContain('export CLAUDE_CODE_ENABLE_TELEMETRY=1')
    expect(block).toContain('export OTEL_METRICS_EXPORTER=otlp')
    expect(block).toContain('export OTEL_LOGS_EXPORTER=otlp')
    expect(block).toContain('export OTEL_EXPORTER_OTLP_PROTOCOL=http/json')
    expect(block).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4321')
    expect(block).toContain(
      `export OTEL_RESOURCE_ATTRIBUTES=lane=test-lane,role=worker,instance=${instance}`,
    )
  })

  it('carries the role through for a conductor', () => {
    const block = renderTelemetryEnv({ lane: 'conductor', role: 'conductor', port: 9000, instance })
    expect(block).toContain(
      `export OTEL_RESOURCE_ATTRIBUTES=lane=conductor,role=conductor,instance=${instance}`,
    )
    expect(block).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9000')
  })

  it('declares the instance the receiver will check, so nothing it emits is refused', () => {
    // Every accepted export must carry `instance=<id>` (api/otel.ts): the
    // attribute is the whole contract between this block and the receiver.
    const block = renderTelemetryEnv({ lane: 'l', role: 'worker', port: 1, instance: 'abc' })
    expect(block).toMatch(/OTEL_RESOURCE_ATTRIBUTES=.*\binstance=abc\b/)
  })
})

describe('otlpEndpoint', () => {
  it('builds the base endpoint the OTel SDK appends /v1/metrics and /v1/logs to', () => {
    expect(otlpEndpoint(4321)).toBe('http://127.0.0.1:4321')
    expect(metaUrl(4321)).toBe('http://127.0.0.1:4321/api/meta')
  })
})

describe('fetchInstanceId', () => {
  it('reads the session id the server publishes as its instance', async () => {
    const id = await fetchInstanceId(4321, {
      fetch: metaFetch({ repoPath: '/repo', repoName: 'repo', sessionId: '1785458425389' }),
    })
    expect(id).toBe('1785458425389')
  })

  it('says what to start when nothing is listening, instead of emitting a block that would be refused', async () => {
    const fetchImpl = (async () => {
      throw new Error('fetch failed')
    }) as typeof globalThis.fetch

    await expect(fetchInstanceId(4321, { fetch: fetchImpl })).rejects.toThrow(
      /cannot read this Observatory's instance id on port 4321[\s\S]*npm start -- --port 4321/,
    )
  })

  it('rejects a non-200 and a body with no session id — not an Observatory', async () => {
    await expect(
      fetchInstanceId(4321, { fetch: metaFetch({}, { status: 502 }) }),
    ).rejects.toThrow(/HTTP 502/)
    await expect(fetchInstanceId(4321, { fetch: metaFetch({ repoName: 'repo' }) })).rejects.toThrow(
      /reported no session id/,
    )
  })
})

/**
 * The end-to-end claim #60 makes: what `observatory env` prints is wired to the
 * instance id of the Observatory actually listening on that port. Boots a real
 * server on an ephemeral port and reads it back through the real CLI path — no
 * stubbed fetch, nothing to drift out of sync with `/api/meta`.
 */
describe('observatory env against a live server', () => {
  let dataRoot: string
  let server: CliHandle | undefined

  class FakeExit extends Error {
    constructor(readonly code: number) {
      super(`exit(${code})`)
    }
  }
  const fakeExit = () =>
    ((code: number) => {
      throw new FakeExit(code)
    }) as (code: number) => never

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'observatory-env-test-'))
  })

  afterEach(async () => {
    await server?.stop()
    await rm(dataRoot, { recursive: true, force: true })
  })

  async function boot(): Promise<{ port: number; instance: string }> {
    server = await runCli([path.join(tmpdir(), 'env-repo'), '--port', '0'], {
      dataRoot,
      collectors: [],
      log: { log: () => {}, warn: () => {} },
    })
    const port = Number(new URL(server.url).port)
    return { port, instance: server.recorder.sessionId }
  }

  it('carries the live server\'s instance id into OTEL_RESOURCE_ATTRIBUTES', async () => {
    const { port, instance } = await boot()

    expect(await fetchInstanceId(port)).toBe(instance)

    const log = { log: vi.fn(), warn: vi.fn() }
    const thrown = await runCli(['env', 'my-lane', '--port', String(port)], {
      log,
      exit: fakeExit(),
    }).catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain(
      `export OTEL_RESOURCE_ATTRIBUTES=lane=my-lane,role=worker,instance=${instance}`,
    )
    expect(output).toContain(`export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${port}`)
  })

  it('emits a block the receiver on that very port accepts, and one it refuses without the id', async () => {
    const { port, instance } = await boot()

    const metrics = (declared: string | null) => ({
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: 'lane', value: { stringValue: 'my-lane' } },
              ...(declared === null
                ? []
                : [{ key: 'instance', value: { stringValue: declared } }]),
            ],
          },
          scopeMetrics: [],
        },
      ],
    })

    const accepted = await fetch(`${otlpEndpoint(port)}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metrics(instance)),
    })
    expect(accepted.status).toBe(200)

    const refused = await fetch(`${otlpEndpoint(port)}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metrics(null)),
    })
    expect(refused.status).toBe(403)
  })
})
