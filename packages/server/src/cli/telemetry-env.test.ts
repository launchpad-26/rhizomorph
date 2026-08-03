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

  /**
   * prd9 #140 — `--shell` learns powershell and cmd, but the default (`sh`,
   * unspecified) must stay byte-for-byte what it always was: `.workmux.yaml`
   * and every existing doc depend on this exact output.
   */
  it('renders the sh form byte-identical to before --shell existed, whether shell is omitted or explicit', () => {
    const withoutShell = renderTelemetryEnv({ lane: 'test-lane', role: 'worker', port: 4321, instance })
    const withShell = renderTelemetryEnv({ lane: 'test-lane', role: 'worker', port: 4321, instance, shell: 'sh' })

    expect(withoutShell).toBe(withShell)
    expect(withoutShell).toBe(
      [
        'export CLAUDE_CODE_ENABLE_TELEMETRY=1',
        'export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1',
        'export OTEL_METRICS_EXPORTER=otlp',
        'export OTEL_LOGS_EXPORTER=otlp',
        'export OTEL_TRACES_EXPORTER=otlp',
        'export OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
        'export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4321',
        'export OTEL_METRIC_EXPORT_INTERVAL=5000',
        'export OTEL_LOGS_EXPORT_INTERVAL=2000',
        'export OTEL_TRACES_EXPORT_INTERVAL=1000',
        `export OTEL_RESOURCE_ATTRIBUTES=lane=test-lane,role=worker,instance=${instance}`,
        '',
      ].join('\n'),
    )
  })

  it('renders the powershell form, every line as $env:NAME = "value", including the quoted OTEL_RESOURCE_ATTRIBUTES', () => {
    const block = renderTelemetryEnv({ lane: 'test-lane', role: 'worker', port: 4321, instance, shell: 'powershell' })

    expect(block).toBe(
      [
        '$env:CLAUDE_CODE_ENABLE_TELEMETRY = "1"',
        '$env:CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = "1"',
        '$env:OTEL_METRICS_EXPORTER = "otlp"',
        '$env:OTEL_LOGS_EXPORTER = "otlp"',
        '$env:OTEL_TRACES_EXPORTER = "otlp"',
        '$env:OTEL_EXPORTER_OTLP_PROTOCOL = "http/json"',
        '$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4321"',
        '$env:OTEL_METRIC_EXPORT_INTERVAL = "5000"',
        '$env:OTEL_LOGS_EXPORT_INTERVAL = "2000"',
        '$env:OTEL_TRACES_EXPORT_INTERVAL = "1000"',
        `$env:OTEL_RESOURCE_ATTRIBUTES = "lane=test-lane,role=worker,instance=${instance}"`,
        '',
      ].join('\n'),
    )
  })

  it('renders the cmd form, every line as set NAME=value, unquoted', () => {
    const block = renderTelemetryEnv({ lane: 'test-lane', role: 'worker', port: 4321, instance, shell: 'cmd' })

    expect(block).toBe(
      [
        'set CLAUDE_CODE_ENABLE_TELEMETRY=1',
        'set CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1',
        'set OTEL_METRICS_EXPORTER=otlp',
        'set OTEL_LOGS_EXPORTER=otlp',
        'set OTEL_TRACES_EXPORTER=otlp',
        'set OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
        'set OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4321',
        'set OTEL_METRIC_EXPORT_INTERVAL=5000',
        'set OTEL_LOGS_EXPORT_INTERVAL=2000',
        'set OTEL_TRACES_EXPORT_INTERVAL=1000',
        `set OTEL_RESOURCE_ATTRIBUTES=lane=test-lane,role=worker,instance=${instance}`,
        '',
      ].join('\n'),
    )
  })

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

  /**
   * prd9 — the trace era: `rhizomorph env` learns the trace beta gate (research
   * note §1's "two extra lines"). Pinned to the exact full block, in order, so
   * this fails the moment a new line lands anywhere but where it was placed, or
   * an existing line moves.
   */
  it('emits exactly the three new trace-beta lines, with every existing line unmoved', () => {
    const block = renderTelemetryEnv({ lane: 'test-lane', role: 'worker', port: 4321, instance })

    expect(block).toBe(
      [
        'export CLAUDE_CODE_ENABLE_TELEMETRY=1',
        'export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1',
        'export OTEL_METRICS_EXPORTER=otlp',
        'export OTEL_LOGS_EXPORTER=otlp',
        'export OTEL_TRACES_EXPORTER=otlp',
        'export OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
        'export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4321',
        'export OTEL_METRIC_EXPORT_INTERVAL=5000',
        'export OTEL_LOGS_EXPORT_INTERVAL=2000',
        'export OTEL_TRACES_EXPORT_INTERVAL=1000',
        `export OTEL_RESOURCE_ATTRIBUTES=lane=test-lane,role=worker,instance=${instance}`,
        '',
      ].join('\n'),
    )
  })

  it('does not set OTEL_EXPORTER_OTLP_ENDPOINT per-signal — the SDK appends /v1/traces to the shared base', () => {
    // Ruling: protocol/endpoint lines already cover traces once OTEL_TRACES_EXPORTER
    // is set, so there must be no separate traces endpoint line.
    const block = renderTelemetryEnv({ lane: 'test-lane', role: 'worker', port: 4321, instance })
    expect(block).not.toMatch(/OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/)
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
      /cannot read this Rhizomorph's instance id on port 4321[\s\S]*npm start -- --port 4321/,
    )
  })

  it('rejects a non-200 and a body with no session id — not an Rhizomorph', async () => {
    await expect(
      fetchInstanceId(4321, { fetch: metaFetch({}, { status: 502 }) }),
    ).rejects.toThrow(/HTTP 502/)
    await expect(fetchInstanceId(4321, { fetch: metaFetch({ repoName: 'repo' }) })).rejects.toThrow(
      /reported no session id/,
    )
  })
})

/**
 * The end-to-end claim #60 makes: what `rhizomorph env` prints is wired to the
 * instance id of the Rhizomorph actually listening on that port. Boots a real
 * server on an ephemeral port and reads it back through the real CLI path — no
 * stubbed fetch, nothing to drift out of sync with `/api/meta`.
 */
describe('rhizomorph env against a live server', () => {
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
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-env-test-'))
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
