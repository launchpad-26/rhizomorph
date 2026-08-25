import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { CAPABILITY_TOKEN_HEADER } from './security.js'
import { capabilityHeaders } from './test-support.js'

/**
 * prd-29 wave 1 (#442, ruling 1 / ADR-0024) plus wave 1b's four late arrivals
 * (ruling 7, #58 — the reads that postdated the PRD's route math): eleven
 * SPA-only reads that answer only the capability token's holder. This walks
 * all eleven against the real `buildApp`, so "Done when: all eleven answer
 * 401 to a bare request and pass with the header" is one law, not eleven
 * scattered assertions — and it fails the moment any one route loses its gate.
 *
 * `discoverRepos` (behind `/api/concierge/repos`) is left REAL here, not
 * mocked: this law only proves the gate opens and closes, never the shape of
 * what it returns, and a real scan of whatever `~/.claude/projects` and the
 * conventional roots hold on the machine running this suite always answers
 * 200 either way.
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
]

describe('the eleven gated reads answer only the token holder (prd-29 waves 1 and 1b)', () => {
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

  it('refuses a bare request — 401 for every one of the eleven, before the handler runs', async () => {
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

  it('passes the gate with the real header — no 401 for any of the eleven', async () => {
    const app = makeApp()
    for (const route of GATED_READS) {
      const response = await app.inject({ ...route, headers: capabilityHeaders(app) })
      expect(response.statusCode, `${route.url} refused the real token`).not.toBe(401)
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
