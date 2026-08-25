import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  buildCapabilityCookie,
  CAPABILITY_COOKIE_NAME,
  CAPABILITY_GATE,
  CAPABILITY_TOKEN_HEADER,
  generateCapabilityToken,
  requireCapabilityToken,
} from './security.js'

/**
 * THE CAPABILITY TOKEN — in isolation, against a throwaway Fastify app
 * rather than a real route, so this suite is the one place the check's own
 * shape is asserted without a real mutating route's other rules (readOnly,
 * body validation, …) in the way. `label.test.ts` then proves the same
 * control holds for the real `/api/label` route end to end.
 */
describe('CAPABILITY_TOKEN_HEADER', () => {
  /**
   * `packages/web/src/recordings/capability.ts` holds its own copy of this
   * exact string — there is no shared package to import one constant from
   * (`docs/adr/0012`'s Consequences names the cost). Pinning the literal
   * here, and its mirror in `capability.test.ts`, turns a one-sided edit
   * into a failing test instead of a silent 401 on every real boot (#249).
   */
  it('pins the exact literal string the web side must independently match', () => {
    expect(CAPABILITY_TOKEN_HEADER).toBe('x-rhizomorph-capability')
  })
})

describe('generateCapabilityToken', () => {
  it('mints a long, high-entropy hex string', () => {
    const token = generateCapabilityToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('mints a different token every call — never a fixed or predictable value', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateCapabilityToken()))
    expect(tokens.size).toBe(20)
  })
})

describe('requireCapabilityToken', () => {
  function makeApp(expectedToken: string) {
    const app = Fastify()
    app.post('/mutate', { preHandler: requireCapabilityToken(expectedToken) }, async () => ({ ok: true }))
    return app
  }

  it('lets a request bearing the exact expected token through', async () => {
    const app = makeApp('the-right-token')
    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { [CAPABILITY_TOKEN_HEADER]: 'the-right-token' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('refuses a request with no token header at all', async () => {
    const app = makeApp('the-right-token')
    const response = await app.inject({ method: 'POST', url: '/mutate' })
    expect(response.statusCode).toBe(401)
    expect((response.json() as { error: string }).error).toContain(CAPABILITY_TOKEN_HEADER)
  })

  it('refuses a request bearing a wrong token, even one that shares a prefix', () => {
    const app = makeApp('the-right-token')
    return app
      .inject({ method: 'POST', url: '/mutate', headers: { [CAPABILITY_TOKEN_HEADER]: 'the-right-token-but-longer' } })
      .then((response) => expect(response.statusCode).toBe(401))
  })

  it('refuses a wrong token of EXACTLY the same length — the constant-time compare rejects content, not just length (prd-29 ruling 5)', async () => {
    // `timingSafeEqual` is the reason this case matters: a same-length token
    // gets past the length guard and into the byte comparison, which must
    // still refuse it. `aaaaaaaaaaa` is 11 chars, same as `right-token`.
    const app = makeApp('right-token')
    const wrong = 'aaaaaaaaaaa'
    expect(wrong.length).toBe('right-token'.length)
    const response = await app.inject({ method: 'POST', url: '/mutate', headers: { [CAPABILITY_TOKEN_HEADER]: wrong } })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a shorter token without throwing — the length guard runs before timingSafeEqual, which would throw on unequal buffers (prd-29 ruling 5)', async () => {
    const app = makeApp('the-right-token')
    const response = await app.inject({ method: 'POST', url: '/mutate', headers: { [CAPABILITY_TOKEN_HEADER]: 'short' } })
    // A thrown RangeError from timingSafeEqual would surface as a 500, not a
    // clean 401 — so this asserting 401 also asserts the guard held.
    expect(response.statusCode).toBe(401)
  })

  it('refuses an empty token header', async () => {
    const app = makeApp('the-right-token')
    const response = await app.inject({ method: 'POST', url: '/mutate', headers: { [CAPABILITY_TOKEN_HEADER]: '' } })
    expect(response.statusCode).toBe(401)
  })

  it('an UNCONFIGURED server refuses, rather than matching an empty header and opening the route', async () => {
    // The fail-open this closes: `tokensMatch('', '')` is true, and every
    // call site spells `requireCapabilityToken(ctx.capabilityToken ?? '')`,
    // so an unset token would let an empty header through the gate.
    const app = makeApp('')
    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { [CAPABILITY_TOKEN_HEADER]: '' },
    })
    expect(response.statusCode).toBe(401)
    expect((response.json() as { error: string }).error).toContain('not configured')
  })

  it('an unconfigured server refuses a request with no header at all, and one bearing any token', async () => {
    // Not vacuously true: the case above could pass for the wrong reason if
    // the empty header were rejected on its own. An unconfigured gate must
    // refuse EVERY request, whatever it carries.
    const app = makeApp('')
    for (const headers of [undefined, { [CAPABILITY_TOKEN_HEADER]: 'any-token-at-all' }]) {
      const response = await app.inject({ method: 'POST', url: '/mutate', headers })
      expect(response.statusCode).toBe(401)
    }
  })

  it('never echoes the expected token back in its refusal', async () => {
    const app = makeApp('super-secret-value')
    const response = await app.inject({ method: 'POST', url: '/mutate' })
    expect(response.payload).not.toContain('super-secret-value')
  })

  it('two independently generated tokens are never equal — no shared default hiding in the mint', () => {
    expect(generateCapabilityToken()).not.toBe(generateCapabilityToken())
  })

  it('brands the gate it returns, so the route-class law can prove a route carries it (prd-29 ruling 2)', () => {
    const gate = requireCapabilityToken('some-token') as unknown as { [CAPABILITY_GATE]?: unknown }
    expect(gate[CAPABILITY_GATE]).toBe(true)
    // A bare preHandler that is NOT this gate carries no brand — so the law's
    // check distinguishes the capability gate from any other preHandler.
    const notAGate = (async () => {}) as unknown as { [CAPABILITY_GATE]?: unknown }
    expect(notAGate[CAPABILITY_GATE]).toBeUndefined()
  })

  it('THE LAW: the default gate — the one every gated-mutation call site uses — never honours the cookie, even when the cookie carries the exact right token and no header is present at all (prd-29 ruling 4)', async () => {
    // No `allowCookie` passed here — this is exactly what
    // `requireCapabilityToken(ctx.capabilityToken ?? '')` spells at every
    // `/api/label`, `/api/rotate`, `/api/lab/launch`, `/api/concierge/clone`
    // and `/api/concierge/launch` call site. An ambient credential on a
    // mutation is CSRF re-invented — this asserts the refusal directly
    // against the gate itself, rather than trusting that no call site ever
    // opts in by accident.
    const app = makeApp('the-right-token')
    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { cookie: `${CAPABILITY_COOKIE_NAME}=the-right-token` },
    })
    expect(response.statusCode).toBe(401)
  })

  it('the gate still brands itself with CAPABILITY_GATE when allowCookie is set — the route-class law keeps seeing it', () => {
    const gate = requireCapabilityToken('some-token', { allowCookie: true }) as unknown as {
      [CAPABILITY_GATE]?: unknown
    }
    expect(gate[CAPABILITY_GATE]).toBe(true)
  })
})

describe('requireCapabilityToken with allowCookie (prd-29 ruling 4, #60 — the stream cannot set a header)', () => {
  function makeReadApp(expectedToken: string) {
    const app = Fastify()
    app.get('/read', { preHandler: requireCapabilityToken(expectedToken, { allowCookie: true }) }, async () => ({
      ok: true,
    }))
    return app
  }

  it('lets a request bearing only the right cookie through — no header at all', async () => {
    const app = makeReadApp('the-right-token')
    const response = await app.inject({
      method: 'GET',
      url: '/read',
      headers: { cookie: `${CAPABILITY_COOKIE_NAME}=the-right-token` },
    })
    expect(response.statusCode).toBe(200)
  })

  it('still lets the header through on its own, exactly as before — allowCookie adds a channel, it does not remove one', async () => {
    const app = makeReadApp('the-right-token')
    const response = await app.inject({
      method: 'GET',
      url: '/read',
      headers: { [CAPABILITY_TOKEN_HEADER]: 'the-right-token' },
    })
    expect(response.statusCode).toBe(200)
  })

  it('refuses a wrong cookie value, even one of the same length', async () => {
    const app = makeReadApp('right-token')
    const wrong = 'aaaaaaaaaaa'
    expect(wrong.length).toBe('right-token'.length)
    const response = await app.inject({
      method: 'GET',
      url: '/read',
      headers: { cookie: `${CAPABILITY_COOKIE_NAME}=${wrong}` },
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses when neither header nor cookie is present', async () => {
    const app = makeReadApp('the-right-token')
    const response = await app.inject({ method: 'GET', url: '/read' })
    expect(response.statusCode).toBe(401)
  })

  it('picks the right cookie out of several — the cookie header can carry more than one', async () => {
    const app = makeReadApp('the-right-token')
    const response = await app.inject({
      method: 'GET',
      url: '/read',
      headers: { cookie: `other=1; ${CAPABILITY_COOKIE_NAME}=the-right-token; another=2` },
    })
    expect(response.statusCode).toBe(200)
  })

  it('a present but WRONG header is refused even when a valid cookie also rides along — the header takes priority, it is never given a fallback to a cookie that would silently paper over it', async () => {
    const app = makeReadApp('the-right-token')
    const response = await app.inject({
      method: 'GET',
      url: '/read',
      headers: {
        [CAPABILITY_TOKEN_HEADER]: 'wrong-token',
        cookie: `${CAPABILITY_COOKIE_NAME}=the-right-token`,
      },
    })
    expect(response.statusCode).toBe(401)
  })

  it('an UNCONFIGURED server refuses a cookie-bearing request too, same as the header path', async () => {
    const app = makeReadApp('')
    const response = await app.inject({
      method: 'GET',
      url: '/read',
      headers: { cookie: `${CAPABILITY_COOKIE_NAME}=anything` },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('buildCapabilityCookie', () => {
  it('sets the token under CAPABILITY_COOKIE_NAME, HttpOnly, SameSite=Strict', () => {
    const cookie = buildCapabilityCookie('abc123')
    expect(cookie).toContain(`${CAPABILITY_COOKIE_NAME}=abc123`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })

  it('never sets Secure — this server is reached over plain HTTP on loopback, and a Secure cookie would silently never be sent', () => {
    const cookie = buildCapabilityCookie('abc123')
    expect(cookie).not.toMatch(/;\s*Secure/i)
  })
})
