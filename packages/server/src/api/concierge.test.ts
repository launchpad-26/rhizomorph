import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'

/**
 * `registerConciergeReposRoute` calls `discoverRepos()` with no arguments,
 * so it always reads the REAL machine's home directory — `ServerContext` is
 * this fence's read-only boundary (see `concierge.ts`'s own doc) and has no
 * seam to hand it a fixture. Mocking `discoverRepos` itself, the same move
 * `doctor.test.ts` makes for `runServerDoctor`'s exec seam, keeps this suite
 * hermetic and independent of whatever `~/.claude/projects` happens to hold
 * on whichever machine runs it. `concierge/repos.test.ts` covers the real
 * function's own behaviour exhaustively; this file covers only the wiring:
 * the route exists, is GET-only, serves what `discoverRepos` returns
 * verbatim, and sits behind the app's global loopback guard like every
 * other route.
 *
 * Deliberately no `import type { DiscoverReposResult }` from
 * `concierge/repos.js` here, even though it would type this fixture more
 * tightly: the namespace law's reachability sweep counts a type-only import
 * as reaching the module too (it is still `from '...'` naming a concierge
 * file), and `api/concierge.ts` is the ONLY file this wave declares as an
 * importer — not this test.
 */
const FIXTURE_RESULT = {
  known: {
    available: true,
    projects: [{ slug: '-Users-operator-repo', path: '/Users/operator/repo', resolved: true }],
  },
  scanned: { repos: [{ path: '/Users/operator/code/other-repo' }], truncated: false },
}

vi.mock('../concierge/repos.js', () => ({
  discoverRepos: () => FIXTURE_RESULT,
}))

describe('GET /api/concierge/repos', () => {
  let repoPath: string
  let sessionDir: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-session-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  function makeApp() {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    return buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })
  }

  it('serves exactly what discoverRepos returns', async () => {
    const response = await makeApp().inject({ method: 'GET', url: '/api/concierge/repos' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(FIXTURE_RESULT)
  })

  it('is GET-only — a POST is not a registered route', async () => {
    const response = await makeApp().inject({ method: 'POST', url: '/api/concierge/repos' })
    expect(response.statusCode).toBe(404)
  })

  it('needs no capability token — the read-only half of the hand', async () => {
    const response = await makeApp().inject({ method: 'GET', url: '/api/concierge/repos' })
    expect(response.statusCode).toBe(200)
  })

  describe('the app-wide loopback guard (mutation-guard.ts) covers this route too', () => {
    it('a loopback Host succeeds', async () => {
      const response = await makeApp().inject({
        method: 'GET',
        url: '/api/concierge/repos',
        headers: { host: '127.0.0.1:4321' },
      })
      expect(response.statusCode).toBe(200)
    })

    it('a non-loopback Host is refused before the route ever runs', async () => {
      const response = await makeApp().inject({
        method: 'GET',
        url: '/api/concierge/repos',
        headers: { host: 'evil.example' },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: expect.stringContaining('not loopback') })
    })
  })
})
