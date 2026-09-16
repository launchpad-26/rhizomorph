import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { CAPABILITY_TOKEN_HEADER } from '../api/security.js'
import {
  enlistHelpText,
  enlistUrl,
  parseEnlistArgs,
  renderEnlistmentPlan,
  runEnlistCommand,
} from './enlist.js'

/**
 * `rhizomorph enlist` / `rhizomorph unenlist` — prd-57 ruling 4's CLI twin.
 *
 * What these pin, in order of how much they'd cost to get wrong:
 *
 * 1. **The command reaches the hand through the ROUTE.** Asserted against the
 *    source text, not inferred from behaviour — a `cli/enlist.ts` that imported
 *    `concierge/enlist.ts` would work perfectly and be a second, undeclared
 *    chain into a hand whose whole design is one declared importer.
 * 2. **Without `--apply`, nothing is written** — and the evidence is the second
 *    request never being made, not a claim in the help text.
 * 3. **`--apply` sends back the digest the diff carried.** Without it the
 *    server refuses, so a command that dropped it would be a two-step in name
 *    only.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOKEN = 'e'.repeat(64)

const SHELL = `<!doctype html><html><head><meta name="rhizomorph-capability" content="${TOKEN}"></head><body></body></html>`

const READY = {
  harness: 'claude',
  intent: 'enlist',
  applied: false,
  target: { path: '/home/operator/.claude/settings.json', display: '~/.claude/settings.json' },
  kind: 'ready',
  changes: [
    { keyPath: ['env', 'OTEL_EXPORTER_OTLP_ENDPOINT'], before: null, after: '"http://127.0.0.1:4321"' },
    { keyPath: ['env', 'OTEL_LOGS_EXPORTER'], before: '"none"', after: '"otlp"' },
  ],
  refusals: [],
  next: '{}',
  sourceDigest: 'present:abc123',
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function htmlResponse(html: string): Response {
  return { ok: true, status: 200, text: async () => html } as Response
}

/**
 * A server that answers the shell scrape and then each POST in turn.
 *
 * The posts are a QUEUE rather than one canned body, because the whole point of
 * the two-step is that the second answer differs from the first — a stub that
 * replayed one body would pass a command that never made the second request.
 */
function serving(...posts: readonly { body: unknown; status?: number }[]): typeof globalThis.fetch {
  const queue = [...posts]
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    if (init?.method !== 'POST') return htmlResponse(SHELL)
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected POST to ${String(input)} — the queue is empty`)
    return jsonResponse(next.body, next.status ?? 200)
  }) as unknown as typeof globalThis.fetch
}

function posted(fetchImpl: typeof globalThis.fetch): { url: string; body: Record<string, unknown>; token: string | null }[] {
  return vi
    .mocked(fetchImpl)
    .mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')
    .map((call) => {
      const init = call[1] as RequestInit
      return {
        url: String(call[0]),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        token: new Headers(init.headers).get(CAPABILITY_TOKEN_HEADER),
      }
    })
}

/** Collects what the command printed and what it exited with, without killing the runner. */
function run(argv: readonly string[], intent: 'enlist' | 'unenlist', fetchImpl: typeof globalThis.fetch) {
  const out: string[] = []
  const log = { log: (line: string) => out.push(line), warn: () => {} }
  let code: number | undefined
  const exit = ((c: number) => {
    code = c
    throw new Error('exit')
  }) as (c: number) => never

  return runEnlistCommand(argv, intent, log, exit, { fetch: fetchImpl })
    .catch(() => undefined)
    .then(() => ({ out: out.join('\n'), code }))
}

describe('THE LAW: the CLI reaches the hand through the route, never by import', () => {
  /**
   * `concierge/namespace-law.test.ts` declares exactly one importer of the
   * fourth hand — `api/concierge.ts`. A declared importer is a terminus, and
   * prd-57 declares no widening of that set, so this file must hold no import
   * of `concierge/` at all. Read from the source text because the defect is
   * invisible in behaviour: an imported hand would do the same thing and be a
   * second grant nobody wrote down.
   */
  const source = readFileSync(path.join(HERE, 'enlist.ts'), 'utf8')

  it('imports nothing from concierge/', () => {
    const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]!)
    expect(imports.filter((specifier) => specifier.includes('concierge'))).toEqual([])
    // The control: this file really does have imports, so an empty filter is
    // evidence rather than a regex that matched nothing.
    expect(imports.length).toBeGreaterThan(0)
  })

  it('names the route, and the route is the one the server registers', () => {
    expect(enlistUrl(4321)).toBe('http://127.0.0.1:4321/api/concierge/enlist')
    const route = readFileSync(path.join(HERE, '..', 'api', 'concierge.ts'), 'utf8')
    expect(route).toContain("'/api/concierge/enlist'")
  })
})

describe('the diff-first two-step', () => {
  it('without --apply it asks once, prints the change, and says nothing was written', async () => {
    const fetchImpl = serving({ body: READY })

    const { out, code } = await run(['claude'], 'enlist', fetchImpl)

    const calls = posted(fetchImpl)
    // ONE post. The absence of a second is the whole promise: a command that
    // wrote anything here would have made it.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({ harness: 'claude', intent: 'enlist', apply: false })
    expect(out).toContain('~/.claude/settings.json')
    expect(out).toContain('+ env.OTEL_EXPORTER_OTLP_ENDPOINT')
    expect(out).toContain('Nothing was written')
    expect(code).toBe(0)
  })

  it('--apply sends back the digest the diff carried — the second act, not a skipped confirmation', async () => {
    const fetchImpl = serving(
      { body: READY },
      { body: { applied: true, target: READY.target, backupPath: '/home/operator/.claude/settings.json.rhizo-backup', changedKeys: ['env.OTEL_LOGS_EXPORTER', 'hooks'] } },
    )

    const { out, code } = await run(['claude', '--apply'], 'enlist', fetchImpl)

    const calls = posted(fetchImpl)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body).toEqual({
      harness: 'claude',
      intent: 'enlist',
      apply: true,
      sourceDigest: READY.sourceDigest,
    })
    expect(out).toContain('2 keys changed')
    expect(out).toContain('.rhizo-backup')
    expect(code).toBe(0)
  })

  it('a digest the server will not accept is reported, not retried', async () => {
    const fetchImpl = serving(
      { body: READY },
      { body: { error: '~/.claude/settings.json changed since that diff was taken — read it again' }, status: 409 },
    )

    const { code } = await run(['claude', '--apply'], 'enlist', fetchImpl)

    expect(posted(fetchImpl)).toHaveLength(2)
    expect(code).toBe(1)
  })

  it('--apply over an already-settled plan asks once and exits 0 — idempotence, not an error', async () => {
    const fetchImpl = serving({
      body: { kind: 'already-settled', target: READY.target, why: 'already enlisted', refusals: [] },
    })

    const { out, code } = await run(['claude', '--apply'], 'enlist', fetchImpl)

    // No second request: there is no digest, because there is nothing to write.
    expect(posted(fetchImpl)).toHaveLength(1)
    expect(out).toContain('nothing to do')
    expect(code).toBe(0)
  })
})

describe('the token, and the saving this command is the first to collect', () => {
  it('carries the capability header on both posts, from ONE shell scrape', async () => {
    const fetchImpl = serving({ body: READY }, { body: { applied: true, target: READY.target, changedKeys: [] } })

    await run(['claude', '--apply'], 'enlist', fetchImpl)

    const calls = posted(fetchImpl)
    expect(calls.map((c) => c.token)).toEqual([TOKEN, TOKEN])
    // `capabilityAwareFetch` documents this saving and had no caller for it:
    // two gated requests, one `GET /`. Built once above both posts, so a later
    // edit that moved it inside the request helper would double the scrapes and
    // redden here.
    const scrapes = vi.mocked(fetchImpl).mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== 'POST')
    expect(scrapes).toHaveLength(1)
  })

  it('a server with no token to hand out fails with a sentence, not a stack', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('<html><head></head><body>no dashboard built</body></html>')) as unknown as typeof globalThis.fetch

    const { code } = await run(['claude'], 'enlist', fetchImpl)

    expect(code).toBe(1)
  })

  it('a port with nothing listening says what to start', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const { code } = await run(['claude', '--port', '9999'], 'enlist', fetchImpl)

    expect(code).toBe(1)
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('port 9999')
    stderr.mockRestore()
  })
})

describe('unenlist is the same command with the other word', () => {
  it('sends intent "unenlist" and renders a removal as a removal', async () => {
    const fetchImpl = serving({
      body: {
        kind: 'ready',
        target: READY.target,
        changes: [{ keyPath: ['env', 'OTEL_LOGS_EXPORTER'], before: '"otlp"', after: null }],
        refusals: [],
        sourceDigest: 'present:xyz',
      },
    })

    const { out } = await run(['claude'], 'unenlist', fetchImpl)

    expect(posted(fetchImpl)[0]!.body.intent).toBe('unenlist')
    expect(out).toContain('- env.OTEL_LOGS_EXPORTER (was "otlp")')
  })
})

describe('what the operator is shown', () => {
  it('prints a refusal on the SETTLED arm — the one that otherwise reads as “everything is fine”', () => {
    // Not a hypothetical: a second enlist over a foreign OTLP endpoint changes
    // nothing AND leaves something untouched, which is why the plan carries
    // refusals on this arm at all. A renderer that dropped them would be silent
    // at the one moment the operator most needs to hear what was declined.
    const lines = renderEnlistmentPlan({
      kind: 'already-settled',
      target: { display: '~/.claude/settings.json' },
      why: 'already enlisted',
      refusals: [
        {
          keyPath: ['env', 'OTEL_EXPORTER_OTLP_ENDPOINT'],
          existing: '"https://otel.example.com"',
          reason: 'you already export somewhere',
          offer: 'hooks-only enlist, which still delivers the witness',
        },
      ],
    }).join('\n')

    expect(lines).toContain('nothing to do')
    expect(lines).toContain('! env.OTEL_EXPORTER_OTLP_ENDPOINT left alone')
    expect(lines).toContain('"https://otel.example.com"')
    expect(lines).toContain('hooks-only enlist')
  })

  it('survives a body from a server that answers something else entirely', () => {
    // One process parsing another process's JSON. A different version, or a
    // different program on that port, must produce lines rather than a TypeError.
    expect(() => renderEnlistmentPlan({})).not.toThrow()
    expect(() => renderEnlistmentPlan({ kind: 'ready', changes: [{}] })).not.toThrow()
    expect(renderEnlistmentPlan({ kind: 'refused', why: 'read-only', remedy: 'watch a repo' })).toEqual([
      '  refused — read-only',
      '  watch a repo',
    ])
  })
})

describe('argv', () => {
  it('refuses a bare invocation rather than guessing a harness', () => {
    expect(() => parseEnlistArgs([], 'enlist')).toThrow(/which harness/)
  })

  it('refuses a path, because enlistment is about your home and not this repo', () => {
    expect(() => parseEnlistArgs(['claude', '.'], 'enlist')).toThrow(/takes one harness and no path/)
  })

  it('reads --port and --apply', () => {
    expect(parseEnlistArgs(['claude', '--port', '5000', '--apply'], 'enlist')).toEqual({
      harness: 'claude',
      apply: true,
      port: 5000,
      help: false,
    })
  })

  it('--help wins over a missing harness, so `rhizomorph enlist --help` is not a usage error', () => {
    expect(parseEnlistArgs(['--help'], 'enlist').help).toBe(true)
  })

  it('each help text names its own command and points at the other one', () => {
    expect(enlistHelpText('enlist')).toContain('rhizomorph enlist <harness>')
    expect(enlistHelpText('enlist')).toContain('See also: rhizomorph unenlist')
    expect(enlistHelpText('unenlist')).toContain('rhizomorph unenlist <harness>')
    expect(enlistHelpText('unenlist')).toContain('See also: rhizomorph enlist')
    // Both say the cost this design pays, because an operator meeting
    // "cannot reach a rhizomorph" should have read why a server is needed.
    for (const intent of ['enlist', 'unenlist'] as const) {
      expect(enlistHelpText(intent)).toContain('It does not start one')
    }
  })
})
