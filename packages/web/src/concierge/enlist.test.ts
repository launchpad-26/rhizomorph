import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_TOKEN_HEADER } from '../recordings/capability.js'
import { applyEnlistment, type EnlistFetchLike, requestEnlistDiff } from './enlist.js'

/**
 * The tenth mutating call's client — prd-57 ruling 4 / ADR-0053.
 *
 * The property every case here exists to hold: **the write cannot be reached
 * without the diff**, because the digest the write requires exists nowhere but
 * in the diff's own answer. A test that only checked the happy path would pass
 * against a client that sent `apply: true` on the first call.
 */

function tokenInDocument(token: string | null): void {
  document.head.innerHTML = token === null ? '' : `<meta name="rhizomorph-capability" content="${token}">`
}

function respondWith(status: number, body: unknown): EnlistFetchLike {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as EnlistFetchLike
}

const READY_DIFF = {
  kind: 'ready',
  target: { path: '/somewhere/.claude/settings.json', display: '~/.claude/settings.json' },
  changes: [{ keyPath: ['hooks', 'PreToolUse'], before: null, after: '[{}]' }],
  refusals: [],
  next: '{}\n',
  sourceDigest: 'a'.repeat(64),
}

beforeEach(() => {
  tokenInDocument('test-token')
})

/**
 * A stand-in server that REMEMBERS WHETHER IT WROTE.
 *
 * The issue names the mutation the pair has to survive: *a test asserting the
 * diff is shown survives a build where the second click also writes nothing.*
 * Two separate tests — one that the first call sends `apply: false`, one that
 * the second sends `apply: true` — do not catch that either, because neither
 * has any idea what the other did.
 *
 * So one fake, one run, counting writes on the far side of the wire. After step
 * one it must be zero; after step two, exactly one.
 */
function recordingServer() {
  const writes: Record<string, unknown>[] = []
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const sent = JSON.parse(init.body) as Record<string, unknown>
    if (sent.apply === true) {
      if (sent.sourceDigest !== READY_DIFF.sourceDigest) {
        // What the real route does, and the reason the digest is the bar
        // rather than a convenience: the server holds it, not the caller.
        return { status: 409, ok: false, json: async () => ({ error: 'stale digest' }), text: async () => 'stale' }
      }
      writes.push(sent)
      return {
        status: 200,
        ok: true,
        json: async () => ({ target: READY_DIFF.target, backupPath: '/somewhere/.claude/settings.json.bak', changedKeys: ['hooks'] }),
        text: async () => '',
      }
    }
    return { status: 200, ok: true, json: async () => READY_DIFF, text: async () => '' }
  }) as unknown as EnlistFetchLike
  return { fetchImpl, writes }
}

describe('THE PAIR: the diff writes nothing and the confirmation writes once', () => {
  it('counts the writes on the server side across one whole two-step', async () => {
    const server = recordingServer()

    const diff = await requestEnlistDiff('claude', 'enlist', server.fetchImpl)
    // Nothing yet. This is the assertion a diff-only test cannot make.
    expect(server.writes).toHaveLength(0)
    expect(diff.kind).toBe('ready')
    if (diff.kind !== 'ready') return

    const applied = await applyEnlistment('claude', 'enlist', diff.sourceDigest, server.fetchImpl)

    expect(server.writes).toHaveLength(1)
    expect(server.writes[0]).toMatchObject({ harness: 'claude', intent: 'enlist', apply: true })
    expect(applied.changedKeys).toEqual(['hooks'])
    expect(applied.backupPath).toBe('/somewhere/.claude/settings.json.bak')
  })

  it("a digest from nowhere writes nothing — the bar is the SERVER's, not this client's", async () => {
    const server = recordingServer()

    await expect(applyEnlistment('claude', 'enlist', 'b'.repeat(64), server.fetchImpl)).rejects.toThrow(/not applied/)

    // The point of holding the count: an implementation that sent the write and
    // then reported the refusal would still have written.
    expect(server.writes).toHaveLength(0)
  })
})

describe('step one reads, and cannot write', () => {
  it('sends apply: false and returns the diff', async () => {
    const fetchImpl = respondWith(200, READY_DIFF)
    const diff = await requestEnlistDiff('claude', 'enlist', fetchImpl)

    expect(diff.kind).toBe('ready')
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }]
    const sent = JSON.parse(init.body)
    expect(sent.apply).toBe(false)
    // And carries no digest, because there is nothing yet to be a digest OF.
    expect(sent.sourceDigest).toBeUndefined()
  })

  it('carries the capability token, and refuses before sending when there is none', async () => {
    const fetchImpl = respondWith(200, READY_DIFF)
    await requestEnlistDiff('claude', 'enlist', fetchImpl)
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ]
    expect(init.headers[CAPABILITY_TOKEN_HEADER]).toBe('test-token')

    // Refused HERE rather than sent bare, so the operator reads what is missing
    // instead of a 401 naming a header they cannot supply.
    tokenInDocument(null)
    const never = respondWith(200, READY_DIFF)
    await expect(requestEnlistDiff('claude', 'enlist', never)).rejects.toThrow()
    expect((never as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('returns a refusal as a VALUE, not a throw — codex is an answer, not an exception', async () => {
    // A harness with no captured config file is something an operator should
    // see rendered beside the others. Throwing would make a caller catch in
    // order to discover that codex simply cannot be enlisted.
    const fetchImpl = respondWith(409, {
      kind: 'refused',
      target: { path: '', display: 'codex' },
      why: 'no capture',
      remedy: 'capture its config file',
    })
    const diff = await requestEnlistDiff('codex', 'enlist', fetchImpl)

    expect(diff.kind).toBe('refused')
    if (diff.kind !== 'refused') return
    expect(diff.why).toMatch(/no capture/)
  })

  it('throws on a refusal it cannot render — a 500 is not an answer', async () => {
    await expect(requestEnlistDiff('claude', 'enlist', respondWith(500, { error: 'boom' }))).rejects.toThrow(/boom/)
  })
})

describe('step two writes, and only against a diff somebody saw', () => {
  it('sends apply: true WITH the digest the diff returned', async () => {
    const fetchImpl = respondWith(200, { target: READY_DIFF.target, backupPath: null, changedKeys: ['hooks.Stop'] })
    await applyEnlistment('claude', 'enlist', READY_DIFF.sourceDigest, fetchImpl)

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }]
    const sent = JSON.parse(init.body)
    expect(sent.apply).toBe(true)
    expect(sent.sourceDigest).toBe(READY_DIFF.sourceDigest)
  })

  it('surfaces the stale refusal rather than retrying', async () => {
    // The file moved between the diff and the write. A client that retried
    // would be writing against bytes nobody read, which is the whole thing the
    // digest exists to prevent.
    const fetchImpl = respondWith(409, { error: '~/.claude/settings.json changed since that diff was taken' })
    await expect(applyEnlistment('claude', 'enlist', READY_DIFF.sourceDigest, fetchImpl)).rejects.toThrow(
      /changed since that diff/,
    )
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('reports the backup path, which is what makes the write recoverable', async () => {
    const backupPath = '/somewhere/.claude/settings.json.rhizomorph-backup-2026-09-16T12-00-00-000Z'
    const applied = await applyEnlistment(
      'claude',
      'enlist',
      READY_DIFF.sourceDigest,
      respondWith(200, { target: READY_DIFF.target, backupPath, changedKeys: [] }),
    )
    expect(applied.backupPath).toBe(backupPath)
  })
})

describe('unenlist is the same call, and it is what makes this power reversible', () => {
  it('sends intent: unenlist on both steps', async () => {
    const diffFetch = respondWith(200, { ...READY_DIFF, changes: [] })
    await requestEnlistDiff('claude', 'unenlist', diffFetch)
    const [, diffInit] = (diffFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }]
    expect(JSON.parse(diffInit.body).intent).toBe('unenlist')

    const applyFetch = respondWith(200, { target: READY_DIFF.target, backupPath: null, changedKeys: [] })
    await applyEnlistment('claude', 'unenlist', READY_DIFF.sourceDigest, applyFetch)
    const [, applyInit] = (applyFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }]
    expect(JSON.parse(applyInit.body).intent).toBe('unenlist')
  })

  it('renders already-settled as a success, because running it twice is normal', async () => {
    const diff = await requestEnlistDiff(
      'claude',
      'unenlist',
      respondWith(200, { kind: 'already-settled', target: READY_DIFF.target, why: 'nothing this hand installed' }),
    )
    expect(diff.kind).toBe('already-settled')
  })
})
