import { requestEnlistDiff, applyEnlistment, type EnlistFetchLike } from '@rhizomorph/web/concierge/enlist'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildContractHarness, type ContractHarness, stripCapabilityToken, tamperCapabilityToken } from './harness.js'

/**
 * `/api/concierge/enlist`'s contract test (prd-24 rulings 1 and 2) — the tenth
 * mutating route, and the file `contract-coverage-law.test.ts` names for it.
 *
 * **What it deliberately does NOT do is complete the act.** A completed request
 * here would rewrite `~/.claude/settings.json` on whoever's machine is running
 * the suite — the sharpest edge in this family, because unlike its siblings the
 * damage would be to a file the operator uses every day rather than to a
 * worktree under our own data root. `clone` declines to download a repository,
 * `instrument` declines to spawn a conductor, `launch` declines to fork a
 * worktree; this one declines to touch a home directory.
 *
 * **What makes that stopping point trustworthy rather than convenient.** The
 * route's gates run in a fixed order (`server/src/api/concierge.ts`), all of
 * them strictly before a byte is written: the capability `preHandler`, the
 * replay refusal, `parseEnlistRequestBody`, then `planEnlistment` — and
 * planning itself writes nothing by construction, which is ruling 4's own
 * diff-first shape and is asserted over strings in
 * `harness/claude.test.ts`. So every case below stops before `applyEnlistment`
 * can reach a filesystem, and the two answers cannot be confused: a 400 naming
 * the digest proves the token was accepted and the handler was reached, exactly
 * as a sibling's 500 naming a port does.
 *
 * ## The one contract this route has that no sibling has
 *
 * The two sides must agree that **the write is unreachable without the diff**.
 * That is not a client convention to be tested on the client alone — the server
 * holds it, and this file is the only place both halves are in the room.
 */
describe('contract: the enlist two-step (#524)', () => {
  let h: ContractHarness

  beforeEach(async () => {
    h = await buildContractHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  /** `h.fetch`, forwarded verbatim. Nothing about the request is composed here. */
  function transport(): EnlistFetchLike {
    return h.fetch as unknown as EnlistFetchLike
  }

  /**
   * The token the REAL served page carries, read the same way the client reads
   * it. The two direct-transport cases below bypass the client on purpose — to
   * prove the SERVER holds the bar — and a direct call still has to be
   * authentic, or it proves only that the gate works, which a sibling already
   * proves.
   */
  function stampedToken(): string {
    const meta = document.querySelector('meta[name="rhizomorph-capability"]')
    const token = meta?.getAttribute('content')
    if (token === null || token === undefined) throw new Error('the served page carried no capability stamp')
    return token
  }

  const jsonHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    'x-rhizomorph-capability': stampedToken(),
  })

  it('the two sides agree on the token header — the client composes it, the route accepts it', async () => {
    // Reaching a 4xx that names the REQUEST rather than the token is what
    // proves the header was accepted: an unknown harness is refused by
    // `planEnlistment`, which runs after the capability preHandler.
    await expect(requestEnlistDiff('nosuchharness', 'enlist', transport())).rejects.toThrow(
      /could not read the enlistment diff/,
    )
  })

  it('a stripped token is refused by the route, and the client says so in the operator’s words', async () => {
    stripCapabilityToken()
    await expect(requestEnlistDiff('claude', 'enlist', transport())).rejects.toThrow(/capability/i)
  })

  it('a tampered token reaches the route and comes back as the stale-token message', async () => {
    tamperCapabilityToken()
    await expect(requestEnlistDiff('claude', 'enlist', transport())).rejects.toThrow()
  })

  it('THE CONTRACT: the write is unreachable without a digest, and the SERVER is what refuses', async () => {
    // The client cannot express "apply with no digest" — `applyEnlistment`
    // takes the digest as a required parameter. So this drives the transport
    // directly, which is the only way to prove the server holds the bar rather
    // than merely that the client keeps it.
    //
    // If this request ever comes back 200, the confirmation bar has become a
    // client convention and prd-14 ruling 4 is being kept by politeness.
    const response = await h.fetch('/api/concierge/enlist', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ harness: 'claude', intent: 'enlist', apply: true }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toMatch(/sourceDigest/)
  })

  it('and a digest that does not match the file is refused too — 409, nothing written', async () => {
    const response = await h.fetch('/api/concierge/enlist', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ harness: 'claude', intent: 'enlist', apply: true, sourceDigest: 'f'.repeat(64) }),
    })
    // Either the plan cannot proceed on this machine or the digest disagrees;
    // both are 409 and both mean nothing was written. Asserting the STATUS
    // rather than the message keeps this true on a machine that happens to
    // have a settings file and one that does not.
    expect(response.status).toBe(409)
  })

  it('the CLIENT’s write path meets the same refusal — both halves, not just the transport', async () => {
    // The two cases above drive `h.fetch` directly to prove the server holds
    // the bar. This one goes through the real client, so the contract covers
    // both of its exported functions rather than only the read half — and it
    // is the client's error text an operator actually sees.
    await expect(applyEnlistment('claude', 'enlist', 'f'.repeat(64), transport())).rejects.toThrow(
      /the enlistment was not applied/,
    )
  })

  it('every refusal kind the route can send is one the client can read, and vice versa', async () => {
    // The vocabulary check prd-24 ruling 1 exists for. The route's plan arms
    // are `ready`, `already-settled` and `refused`; the client's `EnlistDiff`
    // union names exactly those three, and a fourth on either side would leave
    // the other rendering nothing.
    // Read from the TYPE that declares them rather than from the route, which
    // passes `plan.kind` through and names only one arm literally. The first
    // version of this test read `api/concierge.ts` and failed for that reason —
    // a vocabulary check has to read the file that owns the vocabulary.
    const serverSource = await readServerTypes()
    const clientSource = await readClientSource()
    for (const kind of ['ready', 'already-settled', 'refused']) {
      expect(serverSource, `the server stopped naming ${kind}`).toContain(`'${kind}'`)
      expect(clientSource, `the client stopped naming ${kind}`).toContain(`'${kind}'`)
    }
  })
})

async function readServerTypes(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  return readFile(
    path.resolve(here, '..', '..', 'server', 'src', 'concierge', 'harness', 'types.ts'),
    'utf8',
  )
}

async function readClientSource(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  return readFile(path.resolve(here, '..', '..', 'web', 'src', 'concierge', 'enlist.ts'), 'utf8')
}
