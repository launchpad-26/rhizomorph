import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Fetch } from '../../auth/github-app.js'
import { SESSION_COOKIE, SESSION_TTL_MS, deriveSessionKey, signSessionCookie } from '../../auth/session.js'
import { resolveTeamConfig } from '../../config/config.js'
import { hashIngestKey } from '../../keys/hash.js'
import { type MintedIngestKey, mintIngestKey } from '../../keys/mint.js'
import { FakeTeamStorage } from '../../storage/fake.js'
import { REFUSAL_TEXT, type ViewRefusal, type ViewResponse } from '../questions.js'
import {
  MINT_REFUSAL_TEXT,
  type MintRefusal,
  type MintRequest,
  handleMint,
  sameOrigin,
  statusForMintRefusal,
} from './mint.js'

/**
 * A MEMBER MINTS, AND SEES IT EXACTLY ONCE (#560, prd-51 ruling 8).
 *
 * The unit layer. `api/api.test.ts` drives the same surface over a real socket; what is asserted
 * here is what a socket cannot see — how many times `takePlaintext` was called, what the stored
 * row does and does not carry, and that two responses are byte-identical.
 */

const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const CLIENT_SECRET = 'test-client-secret'
const ENV = {
  RZ_TEAM_GITHUB_ORG: 'rhizomorph-team',
  RZ_TEAM_GITHUB_APP_ID: '123456',
  RZ_TEAM_GITHUB_INSTALLATION_ID: '789',
  RZ_TEAM_GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
  RZ_TEAM_GITHUB_CLIENT_ID: 'Iv1.test',
  RZ_TEAM_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
}

const NOW = Date.UTC(2026, 8, 17, 9)
const PROJECT = 'acme-widgets'
const HOST = 'rhizomorph.devacademy.life'
const FORM_ACTION = `/v1/rhizomorph/keys?project=${PROJECT}`

/** The membership GET answers `memberStatus`; the installation-token mint always succeeds. */
function fakeFetch(memberStatus: number): Fetch {
  return (async (url: string | URL) => {
    if (String(url).endsWith('/access_tokens')) {
      return { status: 201, json: async () => ({ token: 'ghs_install_tok' }) } as unknown as Response
    }
    return { status: memberStatus, json: async () => ({}) } as unknown as Response
  }) as unknown as Fetch
}

/** The token mint itself fails — `checkOrgMembership` returns `error`, never `not-a-member`. */
function mintFailsFetch(): Fetch {
  return (async (url: string | URL) => {
    if (String(url).endsWith('/access_tokens')) {
      return { status: 500, json: async () => ({ message: 'boom' }) } as unknown as Response
    }
    return { status: 204, json: async () => ({}) } as unknown as Response
  }) as unknown as Fetch
}

function deps(memberStatus = 204, storage = new FakeTeamStorage()) {
  return { storage, config: resolveTeamConfig({ ...ENV }), fetch: fakeFetch(memberStatus), now: () => NOW }
}

function cookieFor(login: string, issuedAtMs = NOW): string {
  return `${SESSION_COOKIE}=${signSessionCookie(deriveSessionKey(CLIENT_SECRET), { uid: 42, sub: login }, issuedAtMs)}`
}

/** A POST by a signed-in member from this site. Overridden field by field per case. */
function post(overrides: Partial<MintRequest> = {}): MintRequest {
  return {
    cookieHeader: cookieFor('ada'),
    project: PROJECT,
    act: 'mint',
    origin: `https://${HOST}`,
    host: HOST,
    formAction: FORM_ACTION,
    ...overrides,
  }
}

function get(overrides: Partial<MintRequest> = {}): MintRequest {
  return post({ act: 'page', origin: undefined, ...overrides })
}

/** Counts how many times the surface asked for the plaintext. `takes` is the whole point. */
function countingMint(): { mintKey: (r: { projectId: string; nowMs: number }) => MintedIngestKey; takes: () => number } {
  let takes = 0
  return {
    mintKey: (r) => {
      const real = mintIngestKey(r)
      const wrapped: MintedIngestKey = {
        ...real,
        takePlaintext(): string {
          takes += 1
          return real.takePlaintext()
        },
      }
      return wrapped
    },
    takes: () => takes,
  }
}

/** How many times `needle` occurs in `haystack`. `split` rather than a regex: the key is literal. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('#560 — the mint, at the handler', () => {
  it('A MEMBER MINTS: the page carries the plaintext, and the stored row carries only its digest', async () => {
    const storage = new FakeTeamStorage()
    const counting = countingMint()
    const view = await handleMint({ ...deps(204, storage), mintKey: counting.mintKey }, post())

    expect(view.status).toBe(200)
    expect(view.headers['content-type']).toContain('text/html')

    const rows = [...storage.ingestKeys.values()]
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (row === undefined) throw new Error('no row was stored')
    expect(row.projectId).toBe(PROJECT)
    expect(row.revokedAtMs).toBeNull()
    expect(row.createdAtMs).toBe(NOW)

    // The page's key is the row's key: the digest stored is the digest of the value shown.
    const shown = /rzk_[0-9a-f]{64}/.exec(view.html)?.[0]
    expect(shown).toBeDefined()
    expect(row.keyHash).toBe(hashIngestKey(String(shown)))

    // …and the plaintext reached the row in NO form.
    expect(JSON.stringify(row)).not.toContain(String(shown))
    expect(Object.values(row)).not.toContain(shown)

    /**
     * THE ROW'S SHAPE, not only its contents — measured, because the contents assertion above is
     * not enough on its own. A mutation that stored `minted.toString()` (the `rzk_[redacted]`
     * rendering) on a fifth field left this whole file green: the redaction is not the plaintext,
     * so nothing above could see it. `IngestKeyRow` declares four fields and `keys/mint.ts`'s
     * header says *"a field that does not exist cannot reach a column"*, so the assertion that
     * bites is an exact key set. A fifth field of any kind reddens here.
     */
    expect(Object.keys(row).sort()).toEqual(['createdAtMs', 'keyHash', 'projectId', 'revokedAtMs'])

    expect(counting.takes()).toBe(1)
  })

  /**
   * RULING 8's *"shown once at mint"*, as a count rather than a promise.
   *
   * `keys/mint.ts` makes a second `takePlaintext` throw; this asserts the surface above it asks
   * exactly once. A route that asked twice would answer a 500 or a refusal instead of the key,
   * so the first assertion catches it too — but only this one says WHY.
   */
  it('takePlaintext IS CALLED EXACTLY ONCE, and the value appears in the response ONCE and nowhere else', async () => {
    const storage = new FakeTeamStorage()
    const counting = countingMint()
    const view = await handleMint({ ...deps(204, storage), mintKey: counting.mintKey }, post())

    expect(counting.takes()).toBe(1)
    const shown = String(/rzk_[0-9a-f]{64}/.exec(view.html)?.[0])
    expect(occurrences(view.html, shown)).toBe(1)
    // The operator's channel never carries it either — that is where a secret leaks into a log.
    expect(view.operatorNote).toBeUndefined()
  })

  /**
   * THE WHOLE CLAIM, AND THE ONE A FUNCTIONAL TEST MISSES.
   *
   * Going back to the page must not show the key again. The byte-equality of the two form pages is
   * what catches a surface that remembers: a status-and-absence assertion alone would still pass if
   * the page rendered a stale key under a different heading.
   */
  it('A RE-GET SHOWS THE FORM, NEVER THE KEY — and is byte-identical to the page before the mint', async () => {
    const storage = new FakeTeamStorage()
    const d = deps(204, storage)

    const before = await handleMint(d, get())
    const minted = await handleMint(d, post())
    const after = await handleMint(d, get())

    const shown = String(/rzk_[0-9a-f]{64}/.exec(minted.html)?.[0])
    expect(shown).toContain('rzk_')

    expect(after.status).toBe(200)
    expect(after.html).not.toContain(shown)
    // Not only the whole value: the body alone would be enough to ship with.
    expect(after.html).not.toContain(shown.slice('rzk_'.length))
    expect(after.html).toBe(before.html)
  })

  it('TWO MINTS ARE TWO KEYS AND TWO LIVE ROWS — nothing is memoised, and a mint revokes nothing', async () => {
    const storage = new FakeTeamStorage()
    const d = deps(204, storage)

    const first = await handleMint(d, post())
    const second = await handleMint(d, post())

    const one = String(/rzk_[0-9a-f]{64}/.exec(first.html)?.[0])
    const two = String(/rzk_[0-9a-f]{64}/.exec(second.html)?.[0])
    expect(one).not.toBe(two)
    expect(storage.ingestKeys.size).toBe(2)
    // The first key is STILL LIVE. A mint that revoked would silently kill a colleague's shipper.
    expect(storage.ingestKeys.get(hashIngestKey(one))?.revokedAtMs).toBeNull()
    expect(storage.ingestKeys.get(hashIngestKey(two))?.revokedAtMs).toBeNull()
  })

  /**
   * EVERY REFUSAL MINTS NOTHING.
   *
   * The table is the point: a gate that admitted any one of these rows would be a member-only
   * authority handed to whoever asked, and the status alone would not say so — `ingestKeys` being
   * empty is what does.
   */
  it('A REFUSED MINT MINTS NOTHING, for every reason a POST can be refused for', async () => {
    const cases: { reason: MintRefusal; status: number; build: () => Promise<ViewResponse>; storage: FakeTeamStorage }[] = []

    const add = (
      reason: MintRefusal,
      status: number,
      make: (storage: FakeTeamStorage) => Promise<ViewResponse>,
    ) => {
      const storage = new FakeTeamStorage()
      cases.push({ reason, status, storage, build: () => make(storage) })
    }

    add('no-session', 401, (s) => handleMint(deps(204, s), post({ cookieHeader: undefined })))
    add('not-a-member', 403, (s) => handleMint(deps(404, s), post()))
    add('membership-error', 502, (s) =>
      handleMint({ storage: s, config: resolveTeamConfig({ ...ENV }), fetch: mintFailsFetch(), now: () => NOW }, post()),
    )
    add('unconfigured', 503, (s) =>
      handleMint({ storage: s, config: resolveTeamConfig({}), fetch: fakeFetch(204), now: () => NOW }, post()),
    )
    add('no-project', 400, (s) => handleMint(deps(204, s), post({ project: undefined })))
    add('wrong-project', 404, (s) =>
      handleMint({ ...deps(204, s), deploymentProject: PROJECT }, post({ project: 'somewhere-else' })),
    )
    add('cross-origin', 403, (s) => handleMint(deps(204, s), post({ origin: 'https://evil.example' })))

    for (const one of cases) {
      const view = await one.build()
      expect(view.status, one.reason).toBe(one.status)
      expect(view.html, one.reason).toContain(MINT_REFUSAL_TEXT[one.reason])
      expect(one.storage.ingestKeys.size, one.reason).toBe(0)
      expect(one.storage.calls, one.reason).not.toContain('insertIngestKey')
    }

    // The whole vocabulary a POST can be refused for is exercised, not a subset of it.
    expect(cases.map((c) => c.reason).sort()).toEqual(
      (Object.keys(MINT_REFUSAL_TEXT) as MintRefusal[]).filter((r) => r !== 'storage-error').sort(),
    )
  })

  /**
   * #169's CASE, RE-ASSERTED WHERE AUTHORITY IS GRANTED RATHER THAN ROWS READ.
   *
   * `auth/membership.ts` documents a 404 from the membership GET as `no-such-membership`, *"also
   * what a pending, never-accepted invite looks like"*. On the read pages getting this wrong shows
   * an invitee some lane names; here it would hand them a live credential for the project.
   */
  it('A PENDING INVITEE IS NOT A MEMBER — a 404 from the membership GET mints nothing', async () => {
    const storage = new FakeTeamStorage()
    const view = await handleMint(deps(404, storage), post({ cookieHeader: cookieFor('mallory') }))
    expect(view.status).toBe(403)
    expect(view.html).not.toContain('rzk_')
    expect(storage.ingestKeys.size).toBe(0)
  })

  it('AN EXPIRED SESSION IS 401 and mints nothing — a cookie past its TTL is not a member', async () => {
    const storage = new FakeTeamStorage()
    const view = await handleMint(deps(204, storage), post({ cookieHeader: cookieFor('ada', NOW - SESSION_TTL_MS - 1) }))
    expect(view.status).toBe(401)
    expect(view.operatorNote).toContain('expired')
    expect(storage.ingestKeys.size).toBe(0)
  })

  /**
   * THE ORDER IS THE CLAIM: the digest is stored BEFORE the plaintext is yielded.
   *
   * With the two swapped this case still returns a 503 — and the member has already been shown a
   * key this server does not hold, which refuses at ingest as *"unknown key"* with nothing
   * anywhere saying why. So the assertion that bites is the ABSENCE of a key in the page.
   */
  it('A REJECTING INSERT IS A 503 AND THE KEY IS NEVER SHOWN', async () => {
    const storage = new FakeTeamStorage()
    const exploding = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop !== 'insertIngestKey') return Reflect.get(target, prop, receiver)
        return async () => {
          throw new Error('connection terminated unexpectedly')
        }
      },
    }) as FakeTeamStorage

    const view = await handleMint(deps(204, exploding), post())

    expect(view.status).toBe(503)
    expect(view.html).not.toContain('rzk_')
    // The database's own sentence names a host, a port and a relation: the operator's, not the wire's.
    expect(view.html).not.toContain('connection terminated')
    expect(view.operatorNote).toContain('connection terminated unexpectedly')
  })

  describe('the same-origin check on the POST', () => {
    it('a foreign Origin is 403 and mints nothing; this site’s Origin mints; no Origin mints', async () => {
      const foreignStorage = new FakeTeamStorage()
      const foreign = await handleMint(deps(204, foreignStorage), post({ origin: 'https://evil.example' }))
      expect(foreign.status).toBe(403)
      expect(foreignStorage.ingestKeys.size).toBe(0)
      expect(foreign.operatorNote).toContain('evil.example')

      const sameStorage = new FakeTeamStorage()
      const same = await handleMint(deps(204, sameStorage), post())
      expect(same.status).toBe(200)
      expect(sameStorage.ingestKeys.size).toBe(1)

      // ADR-0008's own recorded choice: a caller with no `Origin` is not a browser being steered.
      const bareStorage = new FakeTeamStorage()
      const bare = await handleMint(deps(204, bareStorage), post({ origin: undefined }))
      expect(bare.status).toBe(200)
      expect(bareStorage.ingestKeys.size).toBe(1)
    })

    it('a GET is never refused for its Origin — a top-level navigation is not a write', async () => {
      const storage = new FakeTeamStorage()
      const view = await handleMint(deps(204, storage), get({ origin: 'https://evil.example' }))
      expect(view.status).toBe(200)
      expect(view.html).toContain('<form method="post"')
    })

    it('sameOrigin itself: the host is compared, the scheme and the port are what they are', () => {
      expect(sameOrigin(undefined, HOST)).toBe(true)
      expect(sameOrigin('', HOST)).toBe(true)
      // TLS terminates at Caddy, so this process cannot know its own public scheme.
      expect(sameOrigin(`http://${HOST}`, HOST)).toBe(true)
      expect(sameOrigin(`https://${HOST}`, HOST)).toBe(true)
      expect(sameOrigin(`https://${HOST}`, `${HOST}:8443`)).toBe(false)
      expect(sameOrigin(`https://${HOST}.evil.example`, HOST)).toBe(false)
      expect(sameOrigin('null', HOST)).toBe(false)
      expect(sameOrigin('https://not-a url', HOST)).toBe(false)
      expect(sameOrigin(`https://${HOST}`, undefined)).toBe(false)
    })
  })

  /**
   * THE VOCABULARY IS EXTENDED, NOT FORKED.
   *
   * Derived from `MINT_REFUSAL_TEXT`'s keys rather than from a type-level assertion, for the
   * reason `questions.test.ts` records: `satisfies readonly MintRefusal[]` checks that each element
   * IS a refusal and never that all of them are present, so dropping one leaves `tsc` at exit 0.
   */
  it('every refusal has its own status and its own words, and the seven shared ones are questions.ts’s', () => {
    const ALL = [
      'no-session',
      'not-a-member',
      'unconfigured',
      'membership-error',
      'no-project',
      'wrong-project',
      'storage-error',
      'cross-origin',
    ] as const satisfies readonly MintRefusal[]

    expect([...ALL].sort()).toEqual(Object.keys(MINT_REFUSAL_TEXT).sort())

    const messages = ALL.map((reason) => MINT_REFUSAL_TEXT[reason])
    expect(new Set(messages).size, 'two refusals say the same thing').toBe(messages.length)
    for (const reason of ALL) expect(statusForMintRefusal(reason), reason).toBeGreaterThanOrEqual(400)

    // IMPORTED, NOT COPIED: every reason the read pages also have carries their exact string and
    // their exact status. A second copy of any of the seven would fail here.
    for (const reason of Object.keys(REFUSAL_TEXT) as ViewRefusal[]) {
      expect(MINT_REFUSAL_TEXT[reason], reason).toBe(REFUSAL_TEXT[reason])
    }
    // …and the one this module owns is its own, at the status a refused write deserves.
    expect(statusForMintRefusal('cross-origin')).toBe(403)
    expect(Object.keys(REFUSAL_TEXT)).not.toContain('cross-origin')
  })

  it('CALLER DATA IS ESCAPED — a project id cannot break out of the form’s action attribute', async () => {
    const hostile = '"><script>alert(1)</script>'
    const storage = new FakeTeamStorage()
    const view = await handleMint(
      deps(204, storage),
      get({ project: hostile, formAction: `/v1/rhizomorph/keys?project=${hostile}` }),
    )
    expect(view.status).toBe(200)
    expect(view.html).not.toContain('<script>alert(1)</script>')
    expect(view.html).toContain('&lt;script&gt;')
    expect(view.html).toContain('&quot;')
  })

  it('REPETITION — three GETs are byte-identical, and buy no write', async () => {
    const storage = new FakeTeamStorage()
    const d = deps(204, storage)
    const pages = [await handleMint(d, get()), await handleMint(d, get()), await handleMint(d, get())]
    expect(pages[0]?.html).toBe(pages[1]?.html)
    expect(pages[1]?.html).toBe(pages[2]?.html)
    expect(storage.calls).not.toContain('insertIngestKey')
    expect(storage.ingestKeys.size).toBe(0)
  })
})
