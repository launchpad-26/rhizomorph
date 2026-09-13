import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { resolveTeamConfig } from '../config/config.js'
import { checkOrgMembership } from './membership.js'
import { type Fetch, mintInstallationToken } from './github-app.js'

/** Generated fresh at test run — synthetic, never a real app key. */
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const CONFIGURED_ENV = {
  RZ_TEAM_GITHUB_ORG: 'rhizomorph-team',
  RZ_TEAM_GITHUB_APP_ID: '123456',
  RZ_TEAM_GITHUB_INSTALLATION_ID: '789',
  RZ_TEAM_GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
}

interface Call {
  readonly url: string
  readonly init: { readonly method?: string; readonly redirect?: string; readonly headers?: Record<string, string> } | undefined
}

interface StubResponse {
  readonly status: number
  readonly json?: () => Promise<unknown>
}

/**
 * A fake `fetch` dispatched on URL: the mint POST to `.../access_tokens`
 * answers `mintResponse` (201/ghs_install_tok unless overridden), and the
 * membership GET to `.../orgs/.../members/...` answers `memberResponse` —
 * or, when `memberResponse` is a function that throws, simulates the GET
 * itself failing (a network failure distinct from a bad status).
 */
function fakeFetch(
  calls: Call[],
  memberResponse: StubResponse | (() => never),
  mintResponse: StubResponse = { status: 201, json: async () => ({ token: 'ghs_install_tok' }) },
): Fetch {
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init as Call['init'] }
    calls.push(call)
    if (call.url.includes('/access_tokens')) return mintResponse as unknown as Response
    if (typeof memberResponse === 'function') return memberResponse()
    return memberResponse as unknown as Response
  }
  return fn as Fetch
}

describe('case 40 — the boundary runs on the installation token, never a user token', () => {
  it('a 204 is a member, and the members-GET carries the minted installation token', async () => {
    const calls: Call[] = []
    const fetchImpl = fakeFetch(calls, { status: 204 })
    const config = resolveTeamConfig(CONFIGURED_ENV)

    const result = await checkOrgMembership(config, 'octocat', { fetch: fetchImpl })

    expect(result).toEqual({ status: 'member' })
    expect(calls).toHaveLength(2)
    const memberCall = calls[1]
    expect(memberCall?.url).toBe('https://api.github.com/orgs/rhizomorph-team/members/octocat')
    expect(memberCall?.init?.headers?.authorization).toBe('Bearer ghs_install_tok')
    expect(memberCall?.init?.redirect).toBe('manual')
  })
})

describe('case 41 — every non-204 is not-a-member, and the reason says which', () => {
  const cases: Array<{ label: string; response: StubResponse | (() => never); expected: { status: 'not-a-member'; reason: string } }> = [
    { label: '404', response: { status: 404 }, expected: { status: 'not-a-member', reason: 'no-such-membership' } },
    { label: '302', response: { status: 302 }, expected: { status: 'not-a-member', reason: 'legacy-redirect' } },
    { label: '401', response: { status: 401 }, expected: { status: 'not-a-member', reason: 'credential-rejected' } },
    { label: '403', response: { status: 403 }, expected: { status: 'not-a-member', reason: 'credential-rejected' } },
    { label: '500 (unlisted status)', response: { status: 500 }, expected: { status: 'not-a-member', reason: 'unexpected-response' } },
  ]

  for (const { label, response, expected } of cases) {
    it(`${label} resolves ${expected.reason}`, async () => {
      const calls: Call[] = []
      const config = resolveTeamConfig(CONFIGURED_ENV)
      const result = await checkOrgMembership(config, 'someone', { fetch: fakeFetch(calls, response) })
      expect(result).toEqual(expected)
    })
  }

  it('the members-GET is issued with redirect: manual, so a real 302 is read rather than silently followed to a public-membership endpoint that would answer 204', async () => {
    const calls: Call[] = []
    const config = resolveTeamConfig(CONFIGURED_ENV)
    await checkOrgMembership(config, 'someone', { fetch: fakeFetch(calls, { status: 302 }) })
    const memberCall = calls[calls.length - 1]
    expect(memberCall?.init?.redirect).toBe('manual')
  })

  it('a network failure on the members-GET itself resolves not-a-member/network-error', async () => {
    const config = resolveTeamConfig(CONFIGURED_ENV)
    const fetchImpl = fakeFetch([], () => {
      throw new Error('socket hang up')
    })
    const result = await checkOrgMembership(config, 'someone', { fetch: fetchImpl })
    expect(result).toEqual({ status: 'not-a-member', reason: 'network-error' })
  })
})

describe('case 42 — a pending invite is not a member', () => {
  it(
    "a pending, never-accepted invite resolves not-a-member — REASONED from GitHub's documented behaviour, " +
      'not EXECUTED against a real pending invite (this lane holds no rhizomorph-team org credentials)',
    async () => {
      // GitHub's org membership API (GET /orgs/{org}/members/{username}) returns
      // 404 both for "never was a member" and for "invited, never accepted" —
      // it does not surface `state: pending` on this endpoint at all (that only
      // appears on GET /orgs/{org}/memberships/{username}, which this module
      // deliberately does not call: ruling 8 only asks for the boundary check,
      // not the invite's own state). So the pending case is exercised here by
      // the same 404 branch case 41 already pins, labeled for what it actually
      // is rather than left as an unlabelled claim.
      const config = resolveTeamConfig(CONFIGURED_ENV)
      const result = await checkOrgMembership(config, 'pending-invitee', { fetch: fakeFetch([], { status: 404 }) })
      expect(result).toEqual({ status: 'not-a-member', reason: 'no-such-membership' })
    },
  )
})

describe('case 43 — absent credentials are unconfigured, and a mint failure is an error — neither is not-a-member', () => {
  it('an empty environment is unconfigured, and never reaches the network', async () => {
    const calls: Call[] = []
    const config = resolveTeamConfig({})
    const result = await checkOrgMembership(config, 'someone', { fetch: fakeFetch(calls, { status: 204 }) })
    expect(result).toEqual({ status: 'unconfigured' })
    expect(calls).toHaveLength(0)
  })

  it('a partially configured environment is unconfigured too', async () => {
    const config = resolveTeamConfig({ RZ_TEAM_GITHUB_ORG: 'rhizomorph-team' })
    const result = await checkOrgMembership(config, 'someone', { fetch: fakeFetch([], { status: 204 }) })
    expect(result).toEqual({ status: 'unconfigured' })
  })

  it('a mint failure is an error, never collapsed into not-a-member', async () => {
    const config = resolveTeamConfig(CONFIGURED_ENV)
    const fetchImpl = fakeFetch([], { status: 204 }, { status: 401, json: async () => ({ message: 'Bad credentials' }) })

    const result = await checkOrgMembership(config, 'someone', { fetch: fetchImpl })

    expect(result.status).toBe('error')
    expect('error' in result && result.error.length > 0).toBe(true)
  })

  /**
   * The minter's own sentence reaches the caller INTACT — asserted against the
   * minter, so this test owns no string. `membership.ts` passes `mint.error`
   * through; replacing it with a paraphrase left every test green (the PR's own
   * gap 3), because `github-app.test.ts` exercises the minter alone and the
   * assertion above reads only the length. A 500 from the mint POST produces a
   * deterministic message (no JWT bytes in it), which is why that status is the
   * one used here.
   */
  it("the error is the minter's own sentence, not a paraphrase of it", async () => {
    const config = resolveTeamConfig(CONFIGURED_ENV)
    const mintResponse = { status: 500, json: async () => ({}) }
    const fetchImpl = fakeFetch([], { status: 204 }, mintResponse)

    const minted = await mintInstallationToken(
      { appId: CONFIGURED_ENV.RZ_TEAM_GITHUB_APP_ID, installationId: CONFIGURED_ENV.RZ_TEAM_GITHUB_INSTALLATION_ID, privateKeyPem: TEST_PRIVATE_KEY },
      fetchImpl,
    )
    expect(minted.ok).toBe(false)

    const result = await checkOrgMembership(config, 'someone', { fetch: fetchImpl })
    expect(result).toEqual({ status: 'error', error: minted.ok ? '' : minted.error })
  })
})
