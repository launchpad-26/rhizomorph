import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type Fetch, type GithubAppCredentials, mintInstallationToken } from './github-app.js'

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
