import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { CAPABILITY_COOKIE_NAME, CAPABILITY_TOKEN_HEADER } from './security.js'
import { capabilityHeaders } from './test-support.js'

/**
 * prd-29 wave 1 (#442, ruling 1 / ADR-0024) plus wave 1b's four late arrivals
 * (ruling 7, #58) plus wave 2a's two more (ruling 7, #59 — `/api/meta` and
 * `/api/doctor` themselves, held back from wave 1 so no consumer outside the
 * SPA broke mid-milestone) plus wave 2b's stream (ruling 4, #60 —
 * `/api/stream`, held back so it could gate once its cookie-based alternate
 * credential existed) plus prd-14 ruling 5's comparison save and its two
 * reads (#213) plus prd-55 ruling 6's telemetry and footprint reads
 * (#402): nineteen SPA-only reads that answer only the
 * capability token's holder. This walks all sixteen against the real
 * `buildApp`, so "Done when: all sixteen answer 401 to a bare request and
 * pass with the header" is one law, not sixteen scattered assertions — and
 * it fails the moment any one route loses its gate.
 *
 * `discoverRepos` (behind `/api/concierge/repos`) is left REAL here, not
 * mocked: this law only proves the gate opens and closes, never the shape of
 * what it returns, and a real scan of whatever `~/.claude/projects` and the
 * conventional roots hold on the machine running this suite always answers
 * 200 either way. `/api/doctor` similarly runs its real (if mocked-`exec`-free)
 * checks rather than a stub — it may take a moment to compute, same as
 * `/api/concierge/repos`, and that is fine: this law is about the gate, not
 * the latency.
 */
const GATED_READS: ReadonlyArray<{ method: 'GET'; url: string }> = [
  { method: 'GET', url: '/api/sessions' },
  { method: 'GET', url: '/api/sessions/1000/events' },
  { method: 'GET', url: '/api/lanes' },
  { method: 'GET', url: '/api/transcript/main' },
  { method: 'GET', url: '/api/lab/checkpoints' },
  { method: 'GET', url: '/api/lab/experiments' },
  { method: 'GET', url: '/api/lab/estimate?lane=main&arms=1' },
  { method: 'GET', url: '/api/lane-index' },
  { method: 'GET', url: '/api/lane-index/main' },
  { method: 'GET', url: '/api/session-preview/1000' },
  { method: 'GET', url: '/api/concierge/repos' },
  { method: 'GET', url: '/api/meta' },
  { method: 'GET', url: '/api/doctor' },
  { method: 'GET', url: '/api/stream' },
  { method: 'GET', url: '/api/lab/comparisons' },
  { method: 'GET', url: '/api/lab/comparisons/00000000-0000-4000-8000-000000000000' },
]

/**
 * `/api/stream` never sends a normal, completing response once the gate
 * opens — it `hijack()`s the connection and live-tails indefinitely (see
 * `stream.ts`). Injecting it like every other gated read (a plain
 * `app.inject`, waiting for the body) would hang the suite forever once the
 * token is valid, exactly the way `stream.test.ts`'s own route-level tests
 * avoid it: `payloadAsStream: true`, then destroy the stream the moment the
 * status code has been read. A REFUSAL never reaches `hijack()` — the
 * `preHandler` sends its 401 and returns — so the bare-request and
 * wrong-token loops below need no special case at all.
 */
async function injectGatedReadSuccess(
  app: FastifyInstance,
  route: { method: 'GET'; url: string },
  headers: Record<string, string>,
): Promise<number> {
  if (route.url !== '/api/stream') {
    const response = await app.inject({ ...route, headers })
    return response.statusCode
  }
  const response = await app.inject({ ...route, headers, payloadAsStream: true })
  const statusCode = response.statusCode
  response.stream().destroy()
  return statusCode
}

describe('the nineteen gated reads answer only the token holder (prd-29 waves 1, 1b, 2a and 2b; prd-14 ruling 5, #213; prd-55 ruling 6, #402)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-gated-reads-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeApp() {
    const recorder = new SessionRecorder('1000', sessionFilePath(dir, '1000'))
    return buildApp({ repoPath: dir, repoName: 'repo', sessionDir: dir, recorder })
  }

  /** A wrong token of the SAME length as the real one, so a length check alone cannot pass it. */
  function wrongTokenSameLength(token: string): string {
    return [...token].map((c) => (c === '0' ? '1' : '0')).join('')
  }

  it('refuses a bare request — 401 for every one of the sixteen, before the handler runs', async () => {
    const app = makeApp()
    for (const route of GATED_READS) {
      const response = await app.inject(route)
      expect(response.statusCode, `${route.url} answered a bare request`).toBe(401)
    }
    await app.close()
  })

  it('refuses a wrong token of the same length — 401, so it is not merely a length gate', async () => {
    const app = makeApp()
    const wrong = wrongTokenSameLength(app.capabilityToken)
    expect(wrong).not.toBe(app.capabilityToken)
    expect(wrong.length).toBe(app.capabilityToken.length)
    for (const route of GATED_READS) {
      const response = await app.inject({ ...route, headers: { [CAPABILITY_TOKEN_HEADER]: wrong } })
      expect(response.statusCode, `${route.url} accepted a wrong token`).toBe(401)
    }
    await app.close()
  })

  it('passes the gate with the real header — no 401 for any of the sixteen', async () => {
    const app = makeApp()
    for (const route of GATED_READS) {
      const statusCode = await injectGatedReadSuccess(app, route, capabilityHeaders(app))
      expect(statusCode, `${route.url} refused the real token`).not.toBe(401)
    }
    await app.close()
  })

  it('the plain reads answer 200 with the header — the gate opens, it does not merely stop refusing', async () => {
    const app = makeApp()
    const urls = [
      '/api/sessions',
      '/api/lanes',
      '/api/lab/checkpoints',
      '/api/lab/experiments',
      '/api/lane-index',
      '/api/concierge/repos',
      '/api/meta',
      '/api/doctor',
      '/api/lab/comparisons',
    ]
    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url, headers: capabilityHeaders(app) })
      expect(response.statusCode, `${url} did not answer 200 with the header`).toBe(200)
    }
    await app.close()
  })

  it('GET /* stays tokenless — the bootstrap answers a bare request (prd-29 ruling 1)', async () => {
    const app = makeApp()
    // No web build in this temp dir, so the catch-all is the missing-build
    // placeholder — still a real `GET /*`, and it must answer without a token.
    const response = await app.inject({ method: 'GET', url: '/' })
    expect(response.statusCode).toBe(200)
    await app.close()
  })
})

/**
 * The alternate credential itself (prd-29 ruling 4, #60): `/api/stream` is
 * the one gated route that accepts the HttpOnly capability cookie in place
 * of the header, because `EventSource` cannot set a header at all. Proven
 * against the real, registered `/api/stream` AND a real gated MUTATION
 * (`/api/rotate`) — not only the synthetic gate in `security.test.ts` — so
 * this is the wiring actually landing the ruling, not just the shared
 * primitive being capable of it.
 */
describe('the capability cookie is an alternate credential on /api/stream only (prd-29 ruling 4, #60)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-stream-cookie-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeApp() {
    const recorder = new SessionRecorder('1000', sessionFilePath(dir, '1000'))
    return buildApp({ repoPath: dir, repoName: 'repo', sessionDir: dir, recorder })
  }

  function cookieHeader(token: string): Record<string, string> {
    return { cookie: `${CAPABILITY_COOKIE_NAME}=${token}` }
  }

  it('GET /api/stream opens with only the cookie present — no capability header at all', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/stream',
      headers: cookieHeader(app.capabilityToken),
      payloadAsStream: true,
    })
    expect(response.statusCode).not.toBe(401)
    response.stream().destroy()
    await app.close()
  })

  it('GET /api/stream refuses a wrong cookie value, with no header competing', async () => {
    const app = makeApp()
    const wrong = [...app.capabilityToken].map((c) => (c === '0' ? '1' : '0')).join('')
    const response = await app.inject({ method: 'GET', url: '/api/stream', headers: cookieHeader(wrong) })
    expect(response.statusCode).toBe(401)
    await app.close()
  })

  it('a real gated MUTATION — POST /api/rotate — refuses a request bearing only the cookie, no header at all: an ambient credential on a mutation is CSRF re-invented', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/rotate',
      headers: cookieHeader(app.capabilityToken),
    })
    expect(response.statusCode).toBe(401)
    await app.close()
  })
})
