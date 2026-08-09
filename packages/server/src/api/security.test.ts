import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_TOKEN_HEADER, generateCapabilityToken, requireCapabilityToken } from './security.js'

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

  it('refuses an empty token header', async () => {
    const app = makeApp('the-right-token')
    const response = await app.inject({ method: 'POST', url: '/mutate', headers: { [CAPABILITY_TOKEN_HEADER]: '' } })
    expect(response.statusCode).toBe(401)
  })

  it('never echoes the expected token back in its refusal', async () => {
    const app = makeApp('super-secret-value')
    const response = await app.inject({ method: 'POST', url: '/mutate' })
    expect(response.payload).not.toContain('super-secret-value')
  })

  it('two independently generated tokens are never equal — no shared default hiding in the mint', () => {
    expect(generateCapabilityToken()).not.toBe(generateCapabilityToken())
  })
})
