import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ENV_GITHUB_APP_PRIVATE_KEY,
  ENV_GITHUB_APP_PRIVATE_KEY_FILE,
  ENV_GITHUB_INSTALLATION_ID,
} from '../config/config.js'
import { ENV_GITHUB_APP_PRIVATE_KEY_PATH } from '../../deploy/report.js'
import { type Fetch, type GithubAppCredentials, type MintTokenResult, mintInstallationToken } from './github-app.js'

/** Generated fresh at test run — synthetic, never a real app key. */
const { publicKey: TEST_PUBLIC_KEY, privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const CREDENTIALS: GithubAppCredentials = {
  appId: '999111',
  installationId: '424242',
  privateKeyPem: TEST_PRIVATE_KEY,
}

interface Call {
  readonly url: string
  readonly init: { readonly method?: string; readonly headers?: Record<string, string> } | undefined
}

/** A fake `fetch` that records every call and answers with a canned status/body for the mint POST. */
function fakeFetch(
  calls: Call[],
  respond: () => { status: number; json: () => Promise<unknown> },
): Fetch {
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init as Call['init'] })
    return respond() as unknown as Response
  }
  return fn as Fetch
}

/** A fake `fetch` whose call rejects, as a network failure would. */
function throwingFetch(): Fetch {
  const fn = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com')
  }
  return fn as Fetch
}

function decodeJwtPayload(jwt: string): { iat: number; exp: number; iss: string } {
  const [, payloadSegment] = jwt.split('.')
  return JSON.parse(Buffer.from(payloadSegment ?? '', 'base64url').toString('utf8'))
}

describe('case 38 — the installation token is minted from the app\'s own key with node:crypto, not a library', () => {
  it('signs a real RS256 JWT, POSTs it, and returns the token GitHub sends back', async () => {
    const calls: Call[] = []
    const fetchImpl = fakeFetch(calls, () => ({ status: 201, json: async () => ({ token: 'ghs_faketoken' }) }))

    const result = await mintInstallationToken(CREDENTIALS, fetchImpl, () => 1_700_000_000_000)

    expect(result).toEqual({ ok: true, token: 'ghs_faketoken' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.github.com/app/installations/424242/access_tokens')
    expect(calls[0]?.init?.method).toBe('POST')

    const authHeader = calls[0]?.init?.headers?.authorization ?? ''
    expect(authHeader.startsWith('Bearer ')).toBe(true)
    const jwt = authHeader.slice('Bearer '.length)

    // The strongest assertion: verify the signature against the PUBLIC half of
    // the test keypair. Three dot-separated segments would pass under a
    // mutation that stopped signing and started concatenating; this does not.
    const [headerSegment, payloadSegment, signatureSegment] = jwt.split('.')
    const signingInput = `${headerSegment}.${payloadSegment}`
    const signature = Buffer.from(signatureSegment ?? '', 'base64url')
    expect(verify('RSA-SHA256', Buffer.from(signingInput, 'utf8'), TEST_PUBLIC_KEY, signature)).toBe(true)

    const payload = decodeJwtPayload(jwt)
    expect(payload.iss).toBe(CREDENTIALS.appId)
    // Absolute, not just the 660s span: the fixed clock above (1_700_000_000_000ms)
    // makes these exact values cheap to assert, and only the absolute form catches
    // both `iat` and `exp` drifting together by the same offset — the 60s backdate
    // (github-app.ts:35-36) is a real GitHub requirement, not an arbitrary constant.
    expect(payload.iat).toBe(1_699_999_940)
    expect(payload.exp).toBe(1_700_000_600)
  })

  it('a non-201 response is refused, naming the installation token', async () => {
    const fetchImpl = fakeFetch([], () => ({ status: 401, json: async () => ({ message: 'Bad credentials' }) }))
    const result = await mintInstallationToken(CREDENTIALS, fetchImpl)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/installation token/)
  })

  it('a malformed private key is a clean error, not a thrown exception', async () => {
    const badCredentials: GithubAppCredentials = { ...CREDENTIALS, privateKeyPem: 'not a real key' }
    const fetchImpl = fakeFetch([], () => ({ status: 201, json: async () => ({ token: 'unreachable' }) }))

    const result = await mintInstallationToken(badCredentials, fetchImpl)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/could not be minted/)
  })
})

describe('case 39 — a credential failure is never reported as a clean falsy result', () => {
  it('a network failure during the mint itself is an explicit error naming the installation token', async () => {
    const result = await mintInstallationToken(CREDENTIALS, throwingFetch())
    expect(result.ok).toBe(false)
    expect(!result.ok && typeof result.error).toBe('string')
    expect(!result.ok && result.error.length > 0).toBe(true)
    expect(!result.ok && result.error).toMatch(/installation token/)
  })
})

/**
 * Loudly not-a-key, and shaped like one so the leak assertion below is not
 * vacuous. Same device as `packages/team/deploy/report.test.ts`'s FAKE_PRIVATE_KEY.
 */
const FAKE_MALFORMED_PEM = '-----BEGIN PRIVATE KEY-----\nFAKE-543-NOT-A-KEY\n-----END PRIVATE KEY-----'

/** One base64 line of the real test key — NO newline, see the note in the leak test. */
const KEY_FRAGMENT = TEST_PRIVATE_KEY.split('\n')[1] ?? ''

const knobsIn = (sentence: string): string[] => [...sentence.matchAll(/RZ_TEAM_[A-Z_]+/g)].map((m) => m[0])
const errorOf = (result: MintTokenResult): string => (result.ok ? '' : result.error)

describe('case 40 — the mint refusal names a knob a docker operator can actually set (#543)', () => {
  it('names the compose knob first, the non-docker knobs second, and nothing else', async () => {
    const fetchImpl = fakeFetch([], () => ({ status: 201, json: async () => ({ token: 'unreachable' }) }))
    const result = await mintInstallationToken({ ...CREDENTIALS, privateKeyPem: FAKE_MALFORMED_PEM }, fetchImpl)
    expect(result.ok).toBe(false)

    const error = errorOf(result)
    const named = knobsIn(error)
    // The WHOLE set, not one membership: `report.test.ts`'s mutation M-H showed a
    // presence-and-position check stays green when a bogus knob is appended.
    expect(new Set(named)).toEqual(
      new Set([
        ENV_GITHUB_INSTALLATION_ID,
        ENV_GITHUB_APP_PRIVATE_KEY_PATH,
        ENV_GITHUB_APP_PRIVATE_KEY_FILE,
        ENV_GITHUB_APP_PRIVATE_KEY,
      ]),
    )
    expect(named.indexOf(ENV_GITHUB_APP_PRIVATE_KEY_PATH)).toBeLessThan(named.indexOf(ENV_GITHUB_APP_PRIVATE_KEY))
    expect(error).toContain('docker compose up -d')
    expect(error).toContain('Outside docker')
    expect(error).not.toContain('and restart')

    // BIND EACH NAME TO ITS CLAUSE, not only to the set (review of #543, verify's MX-C/MX-E):
    // a set-plus-one-ordering check does not stop `_FILE` from becoming the docker-apply knob
    // while `_PATH` is demoted into "Outside docker" — the identical class of defect this issue
    // exists to kill, in a new spelling, with the same names present in the same relative order.
    const clauseBoundary = error.indexOf('Outside docker')
    expect(clauseBoundary).toBeGreaterThan(-1)
    const dockerClause = error.slice(0, clauseBoundary)
    const nonDockerClause = error.slice(clauseBoundary)
    expect(knobsIn(dockerClause)).toContain(ENV_GITHUB_APP_PRIVATE_KEY_PATH)
    expect(knobsIn(dockerClause)).not.toContain(ENV_GITHUB_APP_PRIVATE_KEY_FILE)
    expect(knobsIn(nonDockerClause)).toContain(ENV_GITHUB_APP_PRIVATE_KEY_FILE)
    expect(knobsIn(nonDockerClause)).not.toContain(ENV_GITHUB_APP_PRIVATE_KEY_PATH)
  })

  it('no failure path echoes the key it was given, on any of the three', async () => {
    // NON-VACUITY: the fragment must be a real base64 line. A `split('\n')[1]`
    // that came back '' would make every assertion below pass against nothing.
    expect(KEY_FRAGMENT.length).toBeGreaterThan(40)
    expect(FAKE_MALFORMED_PEM).toContain('FAKE-543-NOT-A-KEY')

    const ok201 = () => ({ status: 201, json: async () => ({ token: 'unreachable' }) })
    const cases: Array<{ label: string; result: MintTokenResult }> = [
      { label: 'non-201', result: await mintInstallationToken(CREDENTIALS, fakeFetch([], () => ({ status: 401, json: async () => ({}) }))) },
      { label: 'malformed key', result: await mintInstallationToken({ ...CREDENTIALS, privateKeyPem: FAKE_MALFORMED_PEM }, fakeFetch([], ok201)) },
      { label: 'network failure', result: await mintInstallationToken(CREDENTIALS, throwingFetch()) },
    ]
    for (const one of cases) {
      expect(one.result.ok, one.label).toBe(false)
      const error = errorOf(one.result)
      expect(error, one.label).not.toContain(KEY_FRAGMENT)
      expect(error, one.label).not.toContain('FAKE-543-NOT-A-KEY')
      expect(error, one.label).not.toContain('-----BEGIN')
    }
  })

  it('repetition: the same failure three times is the identical sentence', async () => {
    const run = async () => errorOf(await mintInstallationToken(CREDENTIALS, throwingFetch()))
    const first = await run()
    expect(await run()).toBe(first)
    expect(await run()).toBe(first)
  })
})
