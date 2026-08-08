import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from './build-app.js'
import { SessionRecorder } from './recorder.js'
import { registerStaticRoute } from './static.js'

/**
 * The lane page (prd9 B1b, #135) is a client-side route: `GET /lane/<handle>`
 * has no file of its own in `dist`, so it must fall back to `index.html` the
 * same way `/` already does — the SPA router then reads the URL itself. This
 * file proves that fallback, and that it never shadows a route the API or
 * OTLP receiver actually owns.
 */
describe('registerStaticRoute — the SPA fallback', () => {
  let dir: string
  // Must hold to the real shape (`/^[0-9a-f]{64}$/`) — `injectCapabilityMeta`
  // refuses anything else, since that shape is what lets it interpolate a
  // token into HTML with no escaping.
  const TEST_TOKEN = 'deadbeef'.repeat(8)

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-test-'))
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><head><title>rhizomorph</title></head>')
    await mkdir(path.join(dir, 'assets'), { recursive: true })
    await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("app")')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeApp() {
    const app = Fastify()
    registerStaticRoute(app, dir, TEST_TOKEN)
    return app
  }

  it('serves a real file with its own content type', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/javascript')
    expect(response.body).toBe('console.log("app")')
  })

  it('serves index.html at the root', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('rhizomorph')
  })

  it('falls back to index.html for a lane page URL — a client route, not a file on disk', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/lane/42-otel-receiver' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('rhizomorph')
  })

  it('falls back to index.html for any lane handle, including one with slashes in the wildcard tail', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/lane/some/deeply/nested/handle' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('rhizomorph')
  })

  it('stamps the capability token into index.html at the root — issue #249, the only channel that delivers it', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain(`<meta name="rhizomorph-capability" content="${TEST_TOKEN}">`)
  })

  it('stamps the capability token into the SPA-fallback index.html too, not only the literal root', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/lane/42-otel-receiver' })

    expect(response.body).toContain(`<meta name="rhizomorph-capability" content="${TEST_TOKEN}">`)
  })

  it('never stamps a token into a non-HTML asset', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' })

    expect(response.body).not.toContain('rhizomorph-capability')
  })

  it('refuses a caller-supplied token that is not the 64-hex-character shape, rather than interpolating it unescaped', async () => {
    const app = Fastify()
    registerStaticRoute(app, dir, 'abc" onload="alert(1)')
    const response = await app.inject({ method: 'GET', url: '/' })

    // Fastify's default error handler turns the thrown refusal into a 500 —
    // the important fact either way is that the malformed value never
    // reaches the response body at all.
    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('onload')
  })

  it('inserts the meta tag right after <head ...> when there is no </head> to anchor on, never before <!doctype html>', async () => {
    const headlessDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-headless-test-'))
    try {
      await writeFile(path.join(headlessDir, 'index.html'), '<!doctype html><head><title>no closing tag</title>')
      const app = Fastify()
      registerStaticRoute(app, headlessDir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/' })

      expect(response.statusCode).toBe(200)
      expect(response.body.indexOf('<!doctype html>')).toBe(0)
      expect(response.body).toContain(`<head>\n  <meta name="rhizomorph-capability" content="${TEST_TOKEN}">`)
    } finally {
      await rm(headlessDir, { recursive: true, force: true })
    }
  })

  it('refuses a shell with no <head> element at all, rather than silently prepending before the doctype', async () => {
    const noHeadDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-no-head-test-'))
    try {
      await writeFile(path.join(noHeadDir, 'index.html'), '<!doctype html><body>no head here</body>')
      const app = Fastify()
      registerStaticRoute(app, noHeadDir, TEST_TOKEN)
      const response = await app.inject({ method: 'GET', url: '/' })

      expect(response.statusCode).toBe(500)
    } finally {
      await rm(noHeadDir, { recursive: true, force: true })
    }
  })

  it('never reads outside the dist root, however the wildcard tail is spelled', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/../../etc/passwd' })

    // The URL is normalised before it reaches the route at all, so this lands
    // on the ordinary SPA fallback — the outcome that matters either way:
    // nothing outside `dir` is ever read, and the response is never a 403 or
    // a leak of a file the dist root does not contain.
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('rhizomorph')
  })
})

describe('buildApp — the SPA fallback never shadows a real route', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-static-app-test-'))
    recorder = new SessionRecorder('1000', sessionFilePath(dir, '1000'))

    const distDir = path.join(dir, 'dist')
    await mkdir(distDir, { recursive: true })
    await writeFile(path.join(distDir, 'index.html'), '<!doctype html><head><title>rhizomorph shell</title></head>')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeApp() {
    return buildApp({
      repoPath: '/repo',
      repoName: 'repo',
      sessionDir: dir,
      recorder,
      webDistDir: path.join(dir, 'dist'),
    })
  }

  it('a real API route still answers as itself, not the app shell', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/api/meta' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.json()).toMatchObject({ repoPath: '/repo', repoName: 'repo' })
  })

  it('the OTLP receiver still answers as itself, not the app shell', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      payload: { resourceSpans: [] },
    })

    // Whatever the receiver's own verdict on an empty payload, it must be the
    // receiver that answered — a route that fell through to the HTML shell
    // would report 200 with `content-type: text/html`, which this is not.
    expect(response.headers['content-type']).not.toContain('text/html')
  })

  it('a real boot delivers the capability token it minted, embedded in the shell it serves — issue #249', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain(`<meta name="rhizomorph-capability" content="${app.capabilityToken}">`)
  })

  it('GET /lane/<handle> gets the app shell, cold, with no session events at all', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/lane/42-otel-receiver' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('rhizomorph shell')
  })
})
