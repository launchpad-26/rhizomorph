import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir as osTmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beaconDirFor } from '../collectors/beacon/paths.js'
import { readOrMintInstallationId } from '../log/installation-id.js'
import { DATA_ROOT_ENV_VAR } from '../log/paths.js'
import { type CliHandle, runCli } from './index.js'
import { capabilityAwareFetch } from './rotate.js'
import {
  fetchInstanceId,
  fetchInstanceMeta,
  installationInstanceId,
  metaUrl,
  otlpEndpoint,
  renderTelemetryEnv,
} from './telemetry-env.js'
import { canonicalize } from '../paths/containment.js'

/**
 * The temp root in the ONE spelling the product answers with (#644).
 *
 * `os.tmpdir()` is `/var/folders/…` on macOS and a symlink to
 * `/private/var/folders/…`; on Linux it is neither, so the two spellings are
 * one string there. Every repo path this instrument pins goes through
 * `canonicalizeRepoPath` (prd-58 ruling 1, `paths/containment.ts`) — so a
 * fixture built on the RAW spelling disagrees with the product on macOS and
 * agrees with it vacuously on Linux.
 *
 * **The disagreement hides.** `repoSlug` folds the path into an eight-hex
 * digest, so both sides still print `/var/folders/…` and only the hash moves:
 * `env-repo-a83137d0` against `env-repo-5ef4ef53`. Grepping the output for
 * `private/var` returns nothing. A digest of a path is a path comparison in
 * disguise.
 *
 * Shadowing the import beats rewriting every call site below: a fixture added
 * later is canonical without anyone having to remember. This only removes an
 * ambiguity from tests that are about something else — the canonicalisation
 * itself is witnessed by the symlink laws, which manufacture the divergence
 * instead of borrowing it from the platform and so bite on every OS
 * (`paths/repo-path-canonical.test.ts`, and for `runDoctor` the suite at the
 * foot of `cli/doctor.test.ts`).
 */
const CANONICAL_TMP_ROOT = canonicalize(osTmpdir())
function tmpdir(): string {
  return CANONICAL_TMP_ROOT
}


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

describe('fetchInstanceMeta', () => {
  it('returns the session id and the repo path the server publishes', async () => {
    const meta = await fetchInstanceMeta(4321, {
      fetch: metaFetch({ repoPath: '/repo', repoName: 'repo', sessionId: '1785458425389' }),
    })
    expect(meta).toEqual({ sessionId: '1785458425389', repoPath: '/repo' })
  })

  it('rejects a body with a session id but no repo path', async () => {
    await expect(
      fetchInstanceMeta(4321, { fetch: metaFetch({ sessionId: '1785458425389' }) }),
    ).rejects.toThrow(/reported no repo path/)
  })
})

/**
 * The end-to-end claim #60 makes: what `rhizomorph env` prints is wired to the
 * instance id of the Rhizomorph actually listening on that port. Boots a real
 * server on an ephemeral port and reads it back through the real CLI path — no
 * stubbed fetch, nothing to drift out of sync with `/api/meta`.
 */
/**
 * AMENDED for #59: `/api/meta` is a `gated-read` now, and the token is handed
 * out only through the served dashboard page (ADR-0012) — same reason
 * `runCli rotate subcommand`/`runCli env subcommand` in `index.test.ts` give
 * their booted servers a real `webDistDir`. Without one there is no page to
 * scrape a token off.
 */
/**
 * THE ID AN ENV BLOCK DECLARES — prd-57 ruling 7.
 *
 * `installationInstanceId` reads a file rather than asking a server, and the
 * module doc says why that is not the guessed identity prd2 removed: a session
 * id is known only to the process holding it, while an installation id is one
 * file that both processes read. These pin that claim on both sides — the same
 * root agrees, a different root does not — because the second half is the
 * failure mode an operator can actually create, and the refusal that follows
 * names both ids.
 */
describe('installationInstanceId (prd-57 ruling 7)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-instance-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('two readers of one data root get one id — there is nothing left to guess', () => {
    // Called twice, as the CLI and the server each call it once. Reading it
    // must not mint a second one, which is the property that makes a local read
    // safe at all.
    expect(installationInstanceId({ dataRoot: root })).toBe(installationInstanceId({ dataRoot: root }))
    expect(installationInstanceId({ dataRoot: root }).startsWith('rzi_')).toBe(true)
  })

  it('a DIFFERENT data root is a different id — the bound, stated as a test', async () => {
    // An operator who points one process elsewhere gets two ids. That is the
    // loud failure (a 403 naming both) rather than the invisible one, and it is
    // worth pinning so nobody later "fixes" it into a shared global.
    const other = await mkdtemp(path.join(tmpdir(), 'rhizomorph-instance-other-'))
    try {
      expect(installationInstanceId({ dataRoot: root })).not.toBe(installationInstanceId({ dataRoot: other }))
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('renders into the block verbatim, which is what the receiver compares against', () => {
    const id = installationInstanceId({ dataRoot: root })
    const block = renderTelemetryEnv({ lane: 'l', role: 'worker', port: 4321, instance: id })

    expect(block).toContain(`instance=${id}`)
  })
})

describe('rhizomorph env against a live server', () => {
  let dataRoot: string
  let webDistDir: string
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
    webDistDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-env-test-web-'))
    await writeFile(
      path.join(webDistDir, 'index.html'),
      '<!doctype html>\n<html lang="en"><head><title>the Rhizomorph</title></head><body><div id="root"></div></body></html>\n',
      'utf8',
    )
  })

  afterEach(async () => {
    await server?.stop()
    await rm(dataRoot, { recursive: true, force: true })
    await rm(webDistDir, { recursive: true, force: true })
  })

  /**
   * Boots a server on this test's own data root and reports BOTH ids.
   *
   * They are different values with different lifetimes since prd-57 ruling 7,
   * and every test below that said `instance` meant the session id — so they
   * are named apart here rather than one of them quietly changing meaning
   * under the same word.
   */
  async function boot(): Promise<{ port: number; instance: string; sessionId: string }> {
    server = await runCli([path.join(tmpdir(), 'env-repo'), '--port', '0'], {
      dataRoot,
      collectors: [],
      log: { log: () => {}, warn: () => {} },
      webDistDir,
    })
    const port = Number(new URL(server.url).port)
    return { port, instance: readOrMintInstallationId({ dataRoot }).id, sessionId: server.recorder.sessionId }
  }

  /**
   * Runs the CLI with `RHIZOMORPH_DATA_DIR` pointed at this test's data root.
   *
   * The `--hooks` test below already did this and explained why: the CLI and
   * the server agree only because they share an environment, never because a
   * test could inject the server's `dataRoot` into a CLI a real operator runs
   * in another process. Since ruling 7 the INSTANCE has that property too — it
   * is a file under the data root, read by both — so the same reproduction now
   * covers both halves and lives in one place.
   */
  async function runCliInEnv(
    argv: readonly string[],
    log: Pick<Console, 'log' | 'warn'>,
  ) {
    const previous = process.env[DATA_ROOT_ENV_VAR]
    process.env[DATA_ROOT_ENV_VAR] = dataRoot
    try {
      return await runCli(argv, { log, exit: fakeExit() }).catch((err: unknown) => err)
    } finally {
      if (previous === undefined) delete process.env[DATA_ROOT_ENV_VAR]
      else process.env[DATA_ROOT_ENV_VAR] = previous
    }
  }

  it('carries the INSTALLATION id into OTEL_RESOURCE_ATTRIBUTES, not the session id (prd-57 ruling 7)', async () => {
    const { port, instance, sessionId } = await boot()

    // The control that makes the assertion below mean something: these are
    // two different values, and the session id is still exactly what
    // `/api/meta` publishes and `fetchInstanceId` reads. Neither moved; what
    // moved is which of them an env block declares.
    expect(instance).not.toBe(sessionId)
    expect(await fetchInstanceId(port, { fetch: capabilityAwareFetch(port) })).toBe(sessionId)

    const log = { log: vi.fn(), warn: vi.fn() }
    const thrown = await runCliInEnv(['env', 'my-lane', '--port', String(port)], log)

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain(
      `export OTEL_RESOURCE_ATTRIBUTES=lane=my-lane,role=worker,instance=${instance}`,
    )
    // Said in the negative too, because 'carries the right id' would pass a
    // block that carried both.
    expect(output).not.toContain(`instance=${sessionId}`)
    expect(output).toContain(`export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${port}`)
  })

  it('prints, for --hooks claude, a fragment whose every command targets the live server\'s own beacon directory', async () => {
    const { port } = await boot()

    // `--hooks` resolves the beacon directory through `defaultDataRoot()`
    // (env var, else the platform default) rather than through any option
    // this in-process `runCli` call could inject — by design (plan #282
    // decision 1): the CLI and the server agree only because they share an
    // environment. Reproduce that environment here rather than the server's
    // injected `dataRoot`, which a real CLI invocation never has access to.
    const log = { log: vi.fn(), warn: vi.fn() }
    const thrown = await runCliInEnv(['env', 'my-lane', '--hooks', 'claude', '--port', String(port)], log)

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
    const parsed = JSON.parse(output) as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }

    const expectedBeaconDir = beaconDirFor(path.join(tmpdir(), 'env-repo'), dataRoot)
    for (const commands of Object.values(parsed.hooks)) {
      const command = commands[0]?.hooks[0]?.command ?? ''
      expect(command).toContain(`'${expectedBeaconDir}'`)
    }
  })

  it('emits a block the receiver on that very port accepts, and refuses the session id and no id alike', async () => {
    const { port, instance, sessionId } = await boot()

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

    // End to end over a real socket, against a real boot: the id this very
    // server publishes on `/api/meta` is NOT the id its own inbox accepts.
    // That is the whole of ruling 7, and it is the case a unit test with an
    // injected id cannot make — both halves here were resolved by the
    // running process, from its own data root.
    const stale = await fetch(`${otlpEndpoint(port)}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metrics(sessionId)),
    })
    expect(stale.status).toBe(403)
  })
})
