import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
// From `./concierge.js`, not `../concierge/*` directly — this file is the
// namespace law's one declared importer, and importing the error classes
// straight from `concierge/` here would be a second, undeclared route in.
// See `concierge.ts`'s own re-export comment.
import { CloneDestinationExistsError, CloneFenceError, CloneValidationError } from './concierge.js'
import { CAPABILITY_TOKEN_HEADER } from './security.js'

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
  scanned: { repos: [{ path: '/Users/operator/code/other-repo' }], truncated: false, unreadable: [] },
}

// `vi.mock`'s factory is hoisted above every import in this file, so a plain
// module-scope `vi.fn()` referenced inside it would be read before its own
// declaration runs — `vi.hoisted` is the supported way to give the factory
// something to close over anyway (needed to assert, in the replay test
// below, that discoverRepos was never CALLED — not just that the response
// happens to match).
const { discoverReposMock } = vi.hoisted(() => ({ discoverReposMock: vi.fn() }))

vi.mock('../concierge/repos.js', () => ({
  discoverRepos: discoverReposMock,
}))

/**
 * `planClone`/`runClone` are mocked wholesale, the same posture as
 * `discoverRepos` above: this file covers only the WIRING (capability
 * token, readOnly, status-code mapping, the streamed response shape) —
 * `concierge/clone.test.ts` covers `planClone`'s real fence/validation
 * behaviour and `runClone`'s real progress/cleanup behaviour exhaustively.
 * `parseCloneRequestBody` and the error classes are left REAL (not
 * replaced): they're pure and cheap, and leaving them real means a bad-body
 * test here exercises the actual parser, not a stand-in for it.
 */
const { planCloneMock, runCloneMock } = vi.hoisted(() => ({ planCloneMock: vi.fn(), runCloneMock: vi.fn() }))

// `importOriginal()` (Vitest's own helper, passed to the factory) rather than
// `vi.importActual<typeof import('../concierge/clone.js')>(...)`: the
// namespace law's clause 1 sweep matches `import(` TEXTUALLY, including
// inside a type position, so spelling that generic out here would itself
// read as this test file reaching `concierge/` — exactly the mistake
// `repos.test.ts`'s own comment already warns about for a type-only import.
vi.mock('../concierge/clone.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, planClone: planCloneMock, runClone: runCloneMock }
})

describe('GET /api/concierge/repos', () => {
  let repoPath: string
  let sessionDir: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-session-'))
    discoverReposMock.mockReset()
    discoverReposMock.mockResolvedValue(FIXTURE_RESULT)
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  function makeApp(overrides: { readOnly?: boolean } = {}) {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    return buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, ...overrides })
  }

  it('serves exactly what discoverRepos returns, wrapped as available: true', async () => {
    const response = await makeApp().inject({ method: 'GET', url: '/api/concierge/repos' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ available: true, ...FIXTURE_RESULT })
  })

  describe('a replay server (ctx.readOnly) — the not-applicable posture, not label.ts\'s refusal', () => {
    it('never calls discoverRepos at all, and answers available: false instead', async () => {
      const response = await makeApp({ readOnly: true }).inject({ method: 'GET', url: '/api/concierge/repos' })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ available: false, reason: expect.stringContaining('replaying') })
      expect(discoverReposMock).not.toHaveBeenCalled()
    })

    it('a live (non-replay) server always calls discoverRepos', async () => {
      await makeApp({ readOnly: false }).inject({ method: 'GET', url: '/api/concierge/repos' })
      expect(discoverReposMock).toHaveBeenCalledTimes(1)
    })
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

describe('POST /api/concierge/clone', () => {
  let repoPath: string
  let sessionDir: string
  const CAPABILITY_TOKEN = 'test-token'

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-clone-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-clone-session-'))
    planCloneMock.mockReset()
    runCloneMock.mockReset()
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  function makeApp(overrides: { readOnly?: boolean } = {}) {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    return buildApp({
      repoPath,
      repoName: 'repo',
      sessionDir,
      recorder,
      capabilityToken: CAPABILITY_TOKEN,
      ...overrides,
    })
  }

  function post(app: ReturnType<typeof makeApp>, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/concierge/clone',
      payload: body,
      headers: { [CAPABILITY_TOKEN_HEADER]: CAPABILITY_TOKEN, ...headers },
    })
  }

  it('refuses a request with no capability token, before planClone ever runs', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/api/concierge/clone',
      payload: { url: 'https://example.com/repo.git' },
    })
    expect(response.statusCode).toBe(401)
    expect(planCloneMock).not.toHaveBeenCalled()
  })

  it('refuses a replay server — nowhere live to clone into', async () => {
    const response = await post(makeApp({ readOnly: true }), { url: 'https://example.com/repo.git' })
    expect(response.statusCode).toBe(409)
    expect(planCloneMock).not.toHaveBeenCalled()
  })

  it('refuses a malformed body with 400, via the real (unmocked) parser', async () => {
    const response = await post(makeApp(), { url: 42 })
    expect(response.statusCode).toBe(400)
    expect(planCloneMock).not.toHaveBeenCalled()
  })

  it('maps a CloneValidationError from planClone to 400', async () => {
    planCloneMock.mockRejectedValue(new CloneValidationError('bad url'))
    const response = await post(makeApp(), { url: 'https://example.com/repo.git' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'bad url' })
  })

  it('maps a CloneFenceError from planClone to 403', async () => {
    planCloneMock.mockRejectedValue(new CloneFenceError('refusing to clone: overlaps the watched repo'))
    const response = await post(makeApp(), { url: 'https://example.com/repo.git' })
    expect(response.statusCode).toBe(403)
  })

  it('maps a CloneDestinationExistsError from planClone to 409', async () => {
    planCloneMock.mockRejectedValue(new CloneDestinationExistsError('/clones/repo'))
    const response = await post(makeApp(), { url: 'https://example.com/repo.git' })
    expect(response.statusCode).toBe(409)
  })

  it('plans with ctx.repoPath as the watched repo, then streams runClone as newline-delimited JSON', async () => {
    planCloneMock.mockResolvedValue({ clonesRoot: '/clones', candidate: '/clones/repo' })
    runCloneMock.mockImplementation(async function* () {
      yield { type: 'progress', line: 'Cloning into \'repo\'...' }
      yield { type: 'progress', line: 'Receiving objects: 100%, done.' }
      yield { type: 'done', path: '/clones/repo' }
    })

    const response = await post(makeApp(), { url: 'https://example.com/repo.git' })

    expect(planCloneMock).toHaveBeenCalledWith('https://example.com/repo.git', { watchedRepoPath: repoPath })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/x-ndjson')

    const lines = response.body.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { type: 'progress', line: "Cloning into 'repo'..." },
      { type: 'progress', line: 'Receiving objects: 100%, done.' },
      { type: 'done', path: '/clones/repo' },
    ])
  })

  it('streams an error event from runClone with the same 200 status — the outcome is IN the stream, not the status line', async () => {
    planCloneMock.mockResolvedValue({ clonesRoot: '/clones', candidate: '/clones/repo' })
    runCloneMock.mockImplementation(async function* () {
      yield { type: 'error', message: 'git clone exited with code 128' }
    })

    const response = await post(makeApp(), { url: 'https://example.com/repo.git' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body.trim())).toEqual({ type: 'error', message: 'git clone exited with code 128' })
  })

  describe('the app-wide mutation guard (mutation-guard.ts) covers this route too', () => {
    it('a non-loopback Host is refused before the route ever runs', async () => {
      const response = await post(makeApp(), { url: 'https://example.com/repo.git' }, { host: 'evil.example' })
      expect(response.statusCode).toBe(400)
      expect(planCloneMock).not.toHaveBeenCalled()
    })

    it('a cross-origin Origin is refused as a mutating request', async () => {
      const response = await post(makeApp(), { url: 'https://example.com/repo.git' }, { origin: 'https://evil.example' })
      expect(response.statusCode).toBe(403)
      expect(planCloneMock).not.toHaveBeenCalled()
    })
  })
})
