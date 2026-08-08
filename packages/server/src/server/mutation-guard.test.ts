import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerMutationGuard } from './mutation-guard.js'

/**
 * THE MUTATION GUARD — against a throwaway app with one dummy mutating route
 * and one dummy read-only route, so this suite proves the LAW itself: any
 * mutating route in an app that registers this guard gets the protection,
 * without needing a real route's other business logic in the way. The real
 * routes' own suites (`api/label.test.ts` today; `api/rotate.test.ts` and
 * the laboratory's own tests once they adopt this guard) prove the wiring
 * holds for what an operator actually calls.
 */
function makeApp(): FastifyInstance {
  const app = Fastify()
  registerMutationGuard(app)
  app.post('/mutate', async (request) => ({ ok: true, body: request.body ?? null }))
  app.get('/read', async () => ({ ok: true }))
  app.get('/api/transcript/:lane', async () => ({ ok: true }))
  app.get('/api/stream', async () => ({ ok: true }))
  return app
}

describe('registerMutationGuard', () => {
  describe('Origin', () => {
    it('rejects a cross-origin POST outright — the audit\'s core ask', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { origin: 'https://evil.example' },
      })
      expect(response.statusCode).toBe(403)
    })

    it('accepts a loopback Origin (http://127.0.0.1)', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { origin: 'http://127.0.0.1:4317' },
      })
      expect(response.statusCode).toBe(200)
    })

    it('accepts a loopback Origin (http://localhost)', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { origin: 'http://localhost:4317' },
      })
      expect(response.statusCode).toBe(200)
    })

    it('accepts a loopback IPv6 Origin ([::1])', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { origin: 'http://[::1]:4317' },
      })
      expect(response.statusCode).toBe(200)
    })

    it('allows a request with no Origin header at all — most non-browser callers never send one', async () => {
      const app = makeApp()
      const response = await app.inject({ method: 'POST', url: '/mutate' })
      expect(response.statusCode).toBe(200)
    })

    it('rejects an Origin that is not even a parseable URL', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { origin: 'not-a-url' },
      })
      expect(response.statusCode).toBe(403)
    })

    it('defeats DNS rebinding: a page whose Origin names the attacker\'s own hostname is refused even though this same request would resolve to loopback on the wire', async () => {
      // The whole point of the check: `Origin` reflects the page's OWN
      // address, which a DNS answer served after the page loaded cannot
      // retroactively change to `127.0.0.1` — this is exactly what a rebound
      // request looks like on arrival.
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { origin: 'http://attacker-controlled.example:4317' },
      })
      expect(response.statusCode).toBe(403)
    })
  })

  describe('Host', () => {
    it('rejects a non-loopback Host', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { host: 'attacker-controlled.example:4317' },
      })
      expect(response.statusCode).toBe(400)
    })

    it('accepts a loopback Host with a port', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { host: '127.0.0.1:4317' },
      })
      expect(response.statusCode).toBe(200)
    })

    it('accepts a bracketed loopback IPv6 Host with a port', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { host: '[::1]:4317' },
      })
      expect(response.statusCode).toBe(200)
    })
  })

  describe('Content-Type', () => {
    it('rejects a JSON-shaped body sent as text/plain', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { 'content-type': 'text/plain' },
        payload: '{"a":1}',
      })
      expect(response.statusCode).toBe(415)
    })

    it('rejects a body with no Content-Type at all', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        payload: Buffer.from('{"a":1}'),
      })
      expect(response.statusCode).toBe(415)
    })

    it('accepts application/json with a body', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        payload: { a: 1 },
      })
      expect(response.statusCode).toBe(200)
    })

    it('accepts application/json with a charset parameter', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/mutate',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        payload: '{"a":1}',
      })
      expect(response.statusCode).toBe(200)
    })

    it('does not require a Content-Type at all for a bodyless mutation (e.g. /api/rotate)', async () => {
      const app = makeApp()
      const response = await app.inject({ method: 'POST', url: '/mutate' })
      expect(response.statusCode).toBe(200)
    })
  })

  describe('read-only routes: Origin and Content-Type are exempt, Host is not', () => {
    it('a cross-origin GET with a loopback Host still passes — Origin/Content-Type never apply to reads', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'GET',
        url: '/read',
        headers: { origin: 'https://evil.example', host: '127.0.0.1:4317' },
      })
      expect(response.statusCode).toBe(200)
    })

    it('rejects a GET whose Host is not loopback — the DNS-rebinding case: a rebound page reading /api/transcript/:lane', async () => {
      // This is the defect #235 fixes: a page from `evil.example` that gets
      // rebound to 127.0.0.1 sends no `Origin` at all for this request (the
      // browser treats it as same-origin), so only `Host` can catch it.
      const app = makeApp()
      const response = await app.inject({
        method: 'GET',
        url: '/api/transcript/lane-1',
        headers: { host: 'evil.example' },
      })
      expect(response.statusCode).toBe(400)
    })

    it('accepts a GET with a loopback Host for /api/transcript/:lane', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'GET',
        url: '/api/transcript/lane-1',
        headers: { host: '127.0.0.1:4317' },
      })
      expect(response.statusCode).toBe(200)
    })

    it('rejects a GET whose Host is not loopback — the /api/stream SSE shape', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'GET',
        url: '/api/stream',
        headers: { host: 'evil.example' },
      })
      expect(response.statusCode).toBe(400)
    })

    it('accepts a GET with a loopback Host for /api/stream', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'GET',
        url: '/api/stream',
        headers: { host: 'localhost:4317' },
      })
      expect(response.statusCode).toBe(200)
    })

    it('accepts a GET with no Host header override — fastify app.inject defaults to a loopback Host', async () => {
      const app = makeApp()
      const response = await app.inject({ method: 'GET', url: '/read' })
      expect(response.statusCode).toBe(200)
    })
  })

  describe('every mutating method, not just POST', () => {
    it.each(['PUT', 'PATCH', 'DELETE'] as const)('rejects a cross-origin %s the same way', async (method) => {
      const app = Fastify()
      registerMutationGuard(app)
      app.route({ method, url: '/mutate', handler: async () => ({ ok: true }) })

      const response = await app.inject({ method, url: '/mutate', headers: { origin: 'https://evil.example' } })
      expect(response.statusCode).toBe(403)
    })
  })
})
