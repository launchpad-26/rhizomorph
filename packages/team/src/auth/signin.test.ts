import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ENV_GITHUB_APP_ID,
  ENV_GITHUB_APP_PRIVATE_KEY,
  ENV_GITHUB_APP_PRIVATE_KEY_FILE,
  ENV_GITHUB_CLIENT_ID,
  ENV_GITHUB_CLIENT_SECRET,
  ENV_GITHUB_INSTALLATION_ID,
  ENV_GITHUB_ORG,
  resolveTeamConfig,
} from '../config/config.js'
import { ENV_GITHUB_APP_PRIVATE_KEY_PATH } from '../../deploy/report.js'
import type { Fetch } from './github-app.js'
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  deriveSessionKey,
  issueOauthStateCookie,
  parseCookieHeader,
  verifySessionCookie,
  verifyStateCookie,
} from './session.js'
import { type CallbackRequest, type SignInResponse, handleGithubCallback, handleSignInStart } from './signin.js'

/**
 * THE SIGN-IN, WITH GITHUB STUBBED.
 *
 * **What this does NOT prove**: GitHub's own behaviour. Every answer below is a
 * stub, so C9/C10 assert *our reading* of `bad_verification_code` — that a body
 * carrying `error` is a refusal even at HTTP 200 — and not that GitHub sends it.
 * That reading is taken from GitHub's documented behaviour and is a stated
 * limitation of this layer, not a covered case.
 */

/** Generated fresh at test run — synthetic, never a real app key. */
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const CODE = 'the-code'
const USER_TOKEN = 'gho_user_tok'
const INSTALL_TOKEN = 'ghs_install_tok'
const CLIENT_SECRET = 'the-client-secret'
const CLIENT_ID = 'Iv1.abcdef0123456789'
const NOW = Date.UTC(2026, 8, 14, 9, 0, 0)

/** One base64 line of the test key — no newline, so it survives JSON.stringify. */
const KEY_FRAGMENT = TEST_PRIVATE_KEY.split('\n')[1] ?? ''

const CONFIGURED_ENV = {
  RZ_TEAM_GITHUB_ORG: 'rhizomorph-team',
  RZ_TEAM_GITHUB_APP_ID: '123456',
  RZ_TEAM_GITHUB_INSTALLATION_ID: '789',
  RZ_TEAM_GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
  RZ_TEAM_GITHUB_CLIENT_ID: CLIENT_ID,
  RZ_TEAM_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
}

const config = resolveTeamConfig(CONFIGURED_ENV)
const KEY = deriveSessionKey(CLIENT_SECRET)

interface Call {
  readonly url: string
  readonly init: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: unknown } | undefined
}

interface StubResponse {
  readonly status: number
  readonly json?: () => Promise<unknown>
}

interface Stubs {
  readonly exchange?: StubResponse | (() => never)
  readonly identity?: StubResponse | (() => never)
  readonly mint?: StubResponse
  readonly member?: StubResponse | (() => never)
}

const OK_EXCHANGE: StubResponse = { status: 200, json: async () => ({ access_token: USER_TOKEN, token_type: 'bearer' }) }
const OK_IDENTITY: StubResponse = { status: 200, json: async () => ({ login: 'octocat', id: 583231 }) }
const OK_MINT: StubResponse = { status: 201, json: async () => ({ token: INSTALL_TOKEN }) }

/** A fake `fetch` dispatched on URL, in the shape `membership.test.ts` already uses. */
function fakeFetch(calls: Call[], stubs: Stubs = {}): Fetch {
  const answer = (stub: StubResponse | (() => never) | undefined, fallback: StubResponse) => {
    if (stub === undefined) return fallback as unknown as Response
    if (typeof stub === 'function') return stub()
    return stub as unknown as Response
  }
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init as Call['init'] }
    calls.push(call)
    if (call.url.includes('login/oauth/access_token')) return answer(stubs.exchange, OK_EXCHANGE)
    if (call.url.includes('api.github.com/user')) return answer(stubs.identity, OK_IDENTITY)
    if (call.url.includes('/access_tokens')) return answer(stubs.mint, OK_MINT)
    return answer(stubs.member, { status: 204 })
  }
  return fn as Fetch
}

/** A freshly issued nonce and the `Cookie:` header a browser would send back with it. */
function freshState(nowMs = NOW): { state: string; cookieHeader: string } {
  const issued = issueOauthStateCookie(KEY, nowMs)
  const value = parseCookieHeader(issued.setCookie.split(';')[0])[OAUTH_STATE_COOKIE] ?? ''
  return { state: issued.nonce, cookieHeader: `${OAUTH_STATE_COOKIE}=${value}` }
}

function callbackRequest(overrides: Partial<CallbackRequest> = {}): CallbackRequest {
  const state = freshState()
  return { code: CODE, state: state.state, cookieHeader: state.cookieHeader, ...overrides }
}

const errorOf = (response: SignInResponse): string => {
  const body = response.body as { error?: unknown }
  return typeof body.error === 'string' ? body.error : ''
}

const knobsIn = (sentence: string): string[] => [...sentence.matchAll(/RZ_TEAM_[A-Z_]+/g)].map((m) => m[0])

/** Client id and secret set, org empty — `credentialsFrom` returns undefined, so the callback
 *  reaches `membership-unconfigured` with the exchange and the identity read both succeeding. */
async function membershipUnconfigured(): Promise<SignInResponse> {
  return handleGithubCallback(
    { config: resolveTeamConfig({ ...CONFIGURED_ENV, RZ_TEAM_GITHUB_ORG: '' }), fetch: fakeFetch([]), now: () => NOW },
    callbackRequest(),
  )
}

function setCookies(response: SignInResponse): readonly string[] {
  const value = response.headers['set-cookie']
  if (value === undefined) return []
  return typeof value === 'string' ? [value] : value
}

function sessionCookieIn(response: SignInResponse): string | undefined {
  return setCookies(response).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`) && !cookie.startsWith(`${SESSION_COOKIE}=;`))
}

async function callback(stubs: Stubs = {}, overrides: Partial<CallbackRequest> = {}) {
  const calls: Call[] = []
  const response = await handleGithubCallback(
    { config, fetch: fakeFetch(calls, stubs), now: () => NOW },
    callbackRequest(overrides),
  )
  return { response, calls }
}

describe('the callback admits a member', () => {
  it('C1 — 200, two Set-Cookies, a verifiable session, and the secret never in a URL', async () => {
    const { response, calls } = await callback()

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ signedIn: true, login: 'octocat' })

    const cookies = setCookies(response)
    expect(cookies).toHaveLength(2)
    const session = sessionCookieIn(response)
    expect(session).toBeDefined()
    expect(cookies.some((cookie) => cookie.startsWith(`${OAUTH_STATE_COOKIE}=;`) && cookie.includes('Max-Age=0'))).toBe(true)

    const value = parseCookieHeader(session?.split(';')[0])[SESSION_COOKIE]
    const verdict = verifySessionCookie(KEY, value, NOW)
    expect(verdict.ok && verdict.claims.uid).toBe(583231)
    expect(verdict.ok && verdict.claims.sub).toBe('octocat')

    const exchange = calls[0]
    expect(exchange?.url).toBe('https://github.com/login/oauth/access_token')
    // The secret and the code go in the BODY. A URL reaches proxy logs and Referer.
    expect(exchange?.url).not.toContain('?')
    expect(exchange?.init?.method).toBe('POST')
    expect(exchange?.init?.headers?.accept).toBe('application/json')
    expect(String(exchange?.init?.body)).toContain(CODE)
  })

  it('C2 — ruling 8: the membership GET carries the INSTALLATION token, never the user token', async () => {
    const calls: Call[] = []
    await handleGithubCallback({ config, fetch: fakeFetch(calls, {}), now: () => NOW }, callbackRequest())
    const memberCall = calls.find((call) => call.url.includes('/orgs/'))
    expect(memberCall?.url).toBe('https://api.github.com/orgs/rhizomorph-team/members/octocat')
    expect(memberCall?.init?.headers?.authorization).toBe(`Bearer ${INSTALL_TOKEN}`)
    expect(memberCall?.init?.headers?.authorization).not.toBe(`Bearer ${USER_TOKEN}`)
  })

  it('C18 — start then callback, pure: the nonce one half issues is the nonce the other accepts', async () => {
    const started = handleSignInStart({ config, fetch: fakeFetch([]), now: () => NOW })
    const stateCookie = setCookies(started)[0] ?? ''
    const value = parseCookieHeader(stateCookie.split(';')[0])[OAUTH_STATE_COOKIE]
    const location = String(started.headers.location)
    const nonce = new URL(location).searchParams.get('state') ?? ''

    const calls: Call[] = []
    const response = await handleGithubCallback(
      { config, fetch: fakeFetch(calls, {}), now: () => NOW },
      { code: CODE, state: nonce, cookieHeader: `${OAUTH_STATE_COOKIE}=${value}` },
    )
    expect(response.status).toBe(200)
    expect(sessionCookieIn(response)).toBeDefined()
  })
})

describe('the callback refuses everything else, naming the reason', () => {
  it('C3 — a non-member (404) is 403, keeps membership.ts’s reason word, and mints NO session', async () => {
    const { response } = await callback({ member: { status: 404 } })
    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ refusal: 'not-a-member', reason: 'no-such-membership' })
    expect(sessionCookieIn(response)).toBeUndefined()
  })

  it('C4 — every NotMemberReason survives the trip, and every one of them is a 403', async () => {
    const cases: Array<{ label: string; member: StubResponse | (() => never); reason: string }> = [
      { label: '404', member: { status: 404 }, reason: 'no-such-membership' },
      { label: '302', member: { status: 302 }, reason: 'legacy-redirect' },
      { label: '401', member: { status: 401 }, reason: 'credential-rejected' },
      { label: '403', member: { status: 403 }, reason: 'credential-rejected' },
      { label: '500', member: { status: 500 }, reason: 'unexpected-response' },
      {
        label: 'the GET itself throwing',
        member: () => {
          throw new Error('econnreset')
        },
        reason: 'network-error',
      },
    ]
    const seen = new Set<string>()
    for (const one of cases) {
      const { response } = await callback({ member: one.member })
      expect(response.status, one.label).toBe(403)
      expect(response.body, one.label).toMatchObject({ reason: one.reason })
      seen.add(one.reason)
    }
    // Five distinct reason words reached the wire — they were not collapsed to one.
    expect(seen.size).toBe(5)
  })

  it('C5 — a MINT failure is a 500 with an operatorNote, never folded into the 403', async () => {
    const { response } = await callback({ mint: { status: 401 } })
    expect(response.status).toBe(500)
    expect(response.body).toMatchObject({ refusal: 'membership-error' })
    expect(response.operatorNote).toBeDefined()
    expect(response.operatorNote).toContain('installation token')
    // The wire carries the fact and the remedy; GitHub's status and the mint's
    // own sentence are the operator's.
    const wire = JSON.stringify(response.body)
    expect(wire).not.toContain('installation token')
    expect(wire).not.toContain('status 401')
    expect(sessionCookieIn(response)).toBeUndefined()
  })

  it('C6 — no code is a 400 and buys NO network call', async () => {
    for (const code of [undefined, '', '   ']) {
      const { response, calls } = await callback({}, { code })
      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ refusal: 'no-code' })
      expect(calls).toEqual([])
    }
  })

  it('C7 — bad state is a 400, buys NO network call, and clears NO cookie', async () => {
    const good = freshState()
    const expired = freshState(NOW - 60 * 60 * 1000)
    const cases: Array<{ label: string; overrides: Partial<CallbackRequest> }> = [
      { label: 'no cookie header at all', overrides: { cookieHeader: undefined } },
      { label: 'cookie present, state absent', overrides: { cookieHeader: good.cookieHeader, state: undefined } },
      { label: 'cookie valid, state mismatched', overrides: { cookieHeader: good.cookieHeader, state: 'somebody-elses' } },
      { label: 'cookie expired', overrides: { cookieHeader: expired.cookieHeader, state: expired.state } },
    ]
    for (const one of cases) {
      const { response, calls } = await callback({}, one.overrides)
      expect(response.status, one.label).toBe(400)
      expect(response.body, one.label).toMatchObject({ refusal: 'bad-state' })
      expect(calls, one.label).toEqual([])
      // A forged state must not delete a cookie a concurrent legitimate flow holds.
      expect(setCookies(response), one.label).toEqual([])
      // …and the refusal never echoes what was presented.
      expect(JSON.stringify(response.body), one.label).not.toContain('somebody-elses')
    }
  })

  it('C8 — an unconfigured deployment is a 503 that reaches no network', async () => {
    for (const env of [
      { ...CONFIGURED_ENV, RZ_TEAM_GITHUB_CLIENT_ID: '' },
      { ...CONFIGURED_ENV, RZ_TEAM_GITHUB_CLIENT_SECRET: '' },
    ]) {
      const calls: Call[] = []
      const response = await handleGithubCallback(
        { config: resolveTeamConfig(env), fetch: fakeFetch(calls), now: () => NOW },
        callbackRequest(),
      )
      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({ refusal: 'unconfigured' })
      expect(calls).toEqual([])
    }
  })

  it('C9 — A USED CODE: GitHub answers HTTP 200 with an error body, and that is a refusal', async () => {
    const { response } = await callback({
      exchange: { status: 200, json: async () => ({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }) },
    })
    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ refusal: 'github-refused' })
    expect(sessionCookieIn(response)).toBeUndefined()
  })

  it('C9b — an error body is a refusal even when a token-shaped field sits beside it', async () => {
    // Without this case the `error` branch is dead code: every realistic
    // bad_verification_code body also lacks `access_token`, so the absent-token
    // check alone would catch C9 and the error check could be deleted with the
    // suite staying green. Belt and braces, each tested.
    const { response } = await callback({
      exchange: { status: 200, json: async () => ({ error: 'bad_verification_code', access_token: USER_TOKEN }) },
    })
    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ refusal: 'github-refused' })
    expect(sessionCookieIn(response)).toBeUndefined()
  })

  it('C10 — REPLAY: the same code twice mints exactly one session', async () => {
    let exchanges = 0
    const calls: Call[] = []
    // One stub that behaves the way GitHub does: the first exchange yields a
    // token, every later one is 200 + bad_verification_code.
    const stubs: Stubs = {
      exchange: {
        status: 200,
        json: async () => {
          exchanges += 1
          return exchanges === 1 ? { access_token: USER_TOKEN } : { error: 'bad_verification_code' }
        },
      },
    }
    const deps = { config, fetch: fakeFetch(calls, stubs), now: () => NOW }

    const first = await handleGithubCallback(deps, callbackRequest())
    const second = await handleGithubCallback(deps, callbackRequest())

    expect(first.status).toBe(200)
    expect(sessionCookieIn(first)).toBeDefined()
    expect(second.status).toBe(401)
    expect(second.body).toMatchObject({ refusal: 'github-refused' })
    expect(sessionCookieIn(second)).toBeUndefined()
    expect(exchanges).toBe(2)
  })

  it('C11 — a network failure on the exchange is a 502, and the thrown message does not reach the wire', async () => {
    const marker = 'ECONNREFUSED-marker-9f3a'
    const { response } = await callback({
      exchange: () => {
        throw new Error(marker)
      },
    })
    expect(response.status).toBe(502)
    expect(response.body).toMatchObject({ refusal: 'github-unreachable' })
    expect(JSON.stringify(response)).not.toContain(marker)
    expect(sessionCookieIn(response)).toBeUndefined()
  })

  it('C12 — the identity read distinguishes "who?" from "no"', async () => {
    const noLogin = await callback({ identity: { status: 200, json: async () => ({ id: 1 }) } })
    expect(noLogin.response.status).toBe(502)
    expect(noLogin.response.body).toMatchObject({ refusal: 'no-identity' })

    const noId = await callback({ identity: { status: 200, json: async () => ({ login: 'octocat' }) } })
    expect(noId.response.status).toBe(502)
    expect(noId.response.body).toMatchObject({ refusal: 'no-identity' })

    const refused = await callback({ identity: { status: 401 } })
    expect(refused.response.status).toBe(401)
    expect(refused.response.body).toMatchObject({ refusal: 'github-refused' })
  })

  it('C13 — repetition: the same refusal three times is three identical responses and the same call count', async () => {
    const runs = []
    for (let i = 0; i < 3; i += 1) runs.push(await callback({ member: { status: 404 } }))
    expect(runs[1]?.response).toEqual(runs[0]?.response)
    expect(runs[2]?.response).toEqual(runs[0]?.response)
    expect(runs[1]?.calls.length).toBe(runs[0]?.calls.length)
    expect(runs[2]?.calls.length).toBe(runs[0]?.calls.length)
  })
})

/** Every case above, gathered once — the loop reddens on the case nobody thought of. */
async function everyResponse(): Promise<Array<{ label: string; response: SignInResponse }>> {
  const out: Array<{ label: string; response: SignInResponse }> = []
  const push = async (label: string, stubs: Stubs, overrides: Partial<CallbackRequest> = {}) => {
    out.push({ label, response: (await callback(stubs, overrides)).response })
  }
  await push('happy path', {})
  await push('non-member', { member: { status: 404 } })
  await push('mint failure', { mint: { status: 401 } })
  await push('no code', {}, { code: undefined })
  await push('bad state', {}, { state: 'somebody-elses' })
  await push('used code', { exchange: { status: 200, json: async () => ({ error: 'bad_verification_code' }) } })
  await push('exchange throws', {
    exchange: () => {
      throw new Error(`boom ${CLIENT_SECRET}`)
    },
  })
  await push('no identity', { identity: { status: 200, json: async () => ({}) } })
  await push('identity refused', { identity: { status: 401 } })
  out.push({
    label: 'unconfigured',
    response: await handleGithubCallback(
      { config: resolveTeamConfig({ ...CONFIGURED_ENV, RZ_TEAM_GITHUB_CLIENT_ID: '' }), fetch: fakeFetch([]), now: () => NOW },
      callbackRequest(),
    ),
  })
  out.push({ label: 'membership unconfigured', response: await membershipUnconfigured() })
  out.push({ label: 'start, configured', response: handleSignInStart({ config, fetch: fakeFetch([]), now: () => NOW }) })
  out.push({
    label: 'start, unconfigured',
    response: handleSignInStart({
      config: resolveTeamConfig({ ...CONFIGURED_ENV, RZ_TEAM_GITHUB_CLIENT_SECRET: '' }),
      fetch: fakeFetch([]),
      now: () => NOW,
    }),
  })
  return out
}

describe('nothing leaks, and the callback never redirects', () => {
  it('C14 — no secret reaches the wire, on any path', async () => {
    expect(KEY_FRAGMENT.length).toBeGreaterThan(40)
    for (const { label, response } of await everyResponse()) {
      const wire = JSON.stringify({ status: response.status, headers: response.headers, body: response.body })
      for (const secret of [CODE, USER_TOKEN, INSTALL_TOKEN, CLIENT_SECRET, KEY_FRAGMENT]) {
        expect(wire, `${label} leaked a secret`).not.toContain(secret)
      }
      if (response.operatorNote !== undefined) {
        for (const secret of [CODE, USER_TOKEN, CLIENT_SECRET, KEY_FRAGMENT]) {
          expect(response.operatorNote, `${label}'s operatorNote leaked a secret`).not.toContain(secret)
        }
      }
    }
  })

  it('C15 — the callback never sets a location, on any path', async () => {
    for (const { label, response } of await everyResponse()) {
      if (label.startsWith('start')) continue
      expect(response.headers.location, label).toBeUndefined()
    }
  })
})

describe('handleSignInStart', () => {
  it('C16 — a 302 to GitHub carrying a client id and a nonce, and nothing else', () => {
    const response = handleSignInStart({ config, fetch: fakeFetch([]), now: () => NOW })
    expect(response.status).toBe(302)

    const location = new URL(String(response.headers.location))
    expect(location.host).toBe('github.com')
    expect(location.pathname).toBe('/login/oauth/authorize')
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
    // The callback URL is registered on the GitHub App, so this code cannot be
    // tricked into pointing GitHub at a different host.
    expect(location.searchParams.get('redirect_uri')).toBeNull()
    expect(location.searchParams.get('scope')).toBeNull()
    for (const secret of [CLIENT_SECRET, CODE, USER_TOKEN]) {
      expect(location.toString()).not.toContain(secret)
    }

    const stateCookie = setCookies(response)[0] ?? ''
    expect(stateCookie.startsWith(`${OAUTH_STATE_COOKIE}=`)).toBe(true)
    expect(stateCookie).toContain('HttpOnly')
    expect(stateCookie).toContain('SameSite=Lax')
    // The nonce in the URL is the nonce in the cookie — the whole point of both.
    const value = parseCookieHeader(stateCookie.split(';')[0])[OAUTH_STATE_COOKIE]
    const nonce = location.searchParams.get('state')
    expect(nonce).not.toBeNull()
    expect(verifyStateCookie(KEY, value, nonce ?? undefined, NOW)).toBe(true)
    expect(verifyStateCookie(KEY, value, `${nonce}-tampered`, NOW)).toBe(false)
  })

  it('C17 — unconfigured is a 503 that issues no nonce a callback could never complete', () => {
    for (const env of [
      { ...CONFIGURED_ENV, RZ_TEAM_GITHUB_CLIENT_ID: '' },
      { ...CONFIGURED_ENV, RZ_TEAM_GITHUB_CLIENT_SECRET: '' },
    ]) {
      const response = handleSignInStart({ config: resolveTeamConfig(env), fetch: fakeFetch([]), now: () => NOW })
      expect(response.status).toBe(503)
      expect(setCookies(response)).toEqual([])
      expect(response.headers.location).toBeUndefined()
    }
  })
})

/**
 * THE REFUSALS ARE CHECKED AGAINST compose.yml, NOT AGAINST MEMORY (#543).
 *
 * The same device `packages/team/deploy/report.test.ts` uses for the boot line,
 * applied here to the two sentences an operator reads while sign-in is failing.
 * Every knob name below is imported rather than retyped, so a rename reddens.
 * Every literal compared against the yaml is a single line with no newline in it,
 * which is what keeps this green on the Windows leg.
 */
describe('the configuration refusals name a knob a docker operator can actually set', () => {
  const COMPOSE = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../deploy/compose.yml'),
    'utf8',
  )
  const APP_SERVICE = COMPOSE.slice(COMPOSE.indexOf('\n  app:'), COMPOSE.indexOf('\n  caddy:'))

  it('C19 — the app service block really is what was sliced out', () => {
    expect(APP_SERVICE).toContain(`${ENV_GITHUB_APP_PRIVATE_KEY_FILE}:`)
    expect(APP_SERVICE).not.toContain('caddy')
  })

  it('C20 — the start refusal names the two knobs compose forwards, and says recreate, not restart', () => {
    const response = handleSignInStart({
      config: resolveTeamConfig({ ...CONFIGURED_ENV, RZ_TEAM_GITHUB_CLIENT_ID: '' }),
      fetch: fakeFetch([]),
      now: () => NOW,
    })
    const sentence = errorOf(response)
    expect(new Set(knobsIn(sentence))).toEqual(new Set([ENV_GITHUB_CLIENT_ID, ENV_GITHUB_CLIENT_SECRET]))
    for (const name of [ENV_GITHUB_CLIENT_ID, ENV_GITHUB_CLIENT_SECRET]) {
      expect(APP_SERVICE, name).toContain(`${name}: \${${name}`)
    }
    expect(sentence).toContain('docker compose up -d')
    expect(sentence).not.toContain('and restart')
  })

  it('C21 — the membership refusal names the key knob compose reads, never the one it ignores', async () => {
    const response = await membershipUnconfigured()
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ refusal: 'membership-unconfigured' })

    const sentence = errorOf(response)
    const named = knobsIn(sentence)
    expect(new Set(named)).toEqual(
      new Set([
        ENV_GITHUB_ORG,
        ENV_GITHUB_APP_ID,
        ENV_GITHUB_INSTALLATION_ID,
        ENV_GITHUB_APP_PRIVATE_KEY_PATH,
        ENV_GITHUB_APP_PRIVATE_KEY_FILE,
        ENV_GITHUB_APP_PRIVATE_KEY,
      ]),
    )
    for (const name of [ENV_GITHUB_ORG, ENV_GITHUB_APP_ID, ENV_GITHUB_INSTALLATION_ID]) {
      expect(APP_SERVICE, name).toContain(`${name}: \${${name}`)
    }
    // compose derives the file variable from the host-path one …
    expect(APP_SERVICE).toContain(`\${${ENV_GITHUB_APP_PRIVATE_KEY_PATH}`)
    // … and never forwards the inline one, which is why it is offered only outside docker.
    expect(APP_SERVICE).not.toMatch(new RegExp(`^\\s+${ENV_GITHUB_APP_PRIVATE_KEY}:`, 'm'))
    expect(named.indexOf(ENV_GITHUB_APP_PRIVATE_KEY_PATH)).toBeLessThan(named.indexOf(ENV_GITHUB_APP_PRIVATE_KEY))
    expect(sentence).toContain('Outside docker')
    expect(sentence).toContain('docker compose up -d')

    // BIND EACH NAME TO ITS CLAUSE, not only to the set (review of #543, verify's MX-C/MX-E):
    // a set-plus-one-ordering check does not stop `_FILE` from becoming the docker-apply knob
    // while `_PATH` is demoted into "Outside docker" — the identical class of defect this issue
    // exists to kill, in a new spelling, with the same six names present in the same relative
    // order. Split the sentence at the clause boundary and assert per half.
    const clauseBoundary = sentence.indexOf('Outside docker')
    expect(clauseBoundary).toBeGreaterThan(-1)
    const dockerClause = sentence.slice(0, clauseBoundary)
    const nonDockerClause = sentence.slice(clauseBoundary)
    expect(knobsIn(dockerClause)).toContain(ENV_GITHUB_APP_PRIVATE_KEY_PATH)
    expect(knobsIn(dockerClause)).not.toContain(ENV_GITHUB_APP_PRIVATE_KEY_FILE)
    expect(knobsIn(nonDockerClause)).toContain(ENV_GITHUB_APP_PRIVATE_KEY_FILE)
    expect(knobsIn(nonDockerClause)).not.toContain(ENV_GITHUB_APP_PRIVATE_KEY_PATH)
  })

  it('C22 — on EVERY path, no refusal tells an operator to restart, and any that names a knob says how to apply it', async () => {
    let withKnobs = 0
    for (const { label, response } of await everyResponse()) {
      const sentence = errorOf(response)
      if (sentence === '') continue
      expect(sentence, label).not.toContain('and restart')
      if (knobsIn(sentence).length > 0) {
        withKnobs += 1
        expect(sentence, label).toContain('docker compose up -d')
      }
    }
    // Non-vacuity: the two configuration refusals really were in the sweep.
    expect(withKnobs).toBeGreaterThanOrEqual(2)
  })

  it('C23 — repetition: the membership refusal three times is the identical response', async () => {
    const first = await membershipUnconfigured()
    expect(await membershipUnconfigured()).toEqual(first)
    expect(await membershipUnconfigured()).toEqual(first)
  })
})
