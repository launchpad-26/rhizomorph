import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/worktree-slug.js'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
// From `./concierge.js`, not `../concierge/*` directly — this file is the
// namespace law's one declared importer, and importing the error classes
// straight from `concierge/` here would be a second, undeclared route in.
// See `concierge.ts`'s own re-export comment.
import {
  CloneDestinationExistsError,
  CloneFenceError,
  CloneValidationError,
  HarnessNotAvailableError,
  LaunchContinuityUnavailableError,
  ConciergeLaunchValidationError,
  registerConciergeLaunchRoute,
} from './concierge.js'
import { CAPABILITY_TOKEN_HEADER } from './security.js'
import { capabilityHeaders, TEST_CAPABILITY_TOKEN } from './test-support.js'

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

/**
 * `planLaunch`/`runLaunch` mocked wholesale, the same posture as clone's
 * above: this file covers only the WIRING (capability token, readOnly, the
 * missing-port guard, status-code mapping, the response shape) —
 * `concierge/launch.test.ts` covers `planLaunch`'s real harness-lookup/
 * detect/continuity behaviour and `runLaunch`'s real spawn-outcome behaviour
 * exhaustively. `parseConciergeLaunchRequestBody` and the error classes are left REAL.
 */
const { planLaunchMock, runLaunchMock } = vi.hoisted(() => ({ planLaunchMock: vi.fn(), runLaunchMock: vi.fn() }))

vi.mock('../concierge/launch.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, planLaunch: planLaunchMock, runLaunch: runLaunchMock }
})

/**
 * `planMigration`/`runMigration` are WRAPPED, not replaced — the opposite
 * posture from clone's and launch's mocks above, and deliberately so. The
 * migration is the one half of this route that can be exercised end to end
 * without a real machine: it needs a temp `~/.claude/projects` (which this
 * route takes as an option, exactly as `api/session-preview.ts` does) and
 * nothing else. So every test below runs the REAL plan and the REAL copy
 * against real directories, and only the two outcomes that cannot be
 * reproduced without a broken filesystem — a runtime copy failure, and the
 * `already-present` the fence refuses to plan for — are overridden per test
 * with `mockResolvedValueOnce`.
 *
 * `mockClear`, never `mockReset`, in the `beforeEach` below: reset would drop
 * these implementations and silently turn every end-to-end assertion into an
 * assertion about `undefined`.
 */
const { planMigrationMock, runMigrationMock } = vi.hoisted(() => ({
  planMigrationMock: vi.fn(),
  runMigrationMock: vi.fn(),
}))

vi.mock('../concierge/migrate.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  planMigrationMock.mockImplementation(actual.planMigration as never)
  runMigrationMock.mockImplementation(actual.runMigration as never)
  return { ...actual, planMigration: planMigrationMock, runMigration: runMigrationMock }
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
    return buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, capabilityToken: TEST_CAPABILITY_TOKEN, ...overrides })
  }

  it('serves exactly what discoverRepos returns, wrapped as available: true', async () => {
    const response = await makeApp().inject({
      method: 'GET',
      url: '/api/concierge/repos',
      headers: capabilityHeaders(TEST_CAPABILITY_TOKEN),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ available: true, ...FIXTURE_RESULT })
  })

  describe('a replay server (ctx.readOnly) — the not-applicable posture, not label.ts\'s refusal', () => {
    it('never calls discoverRepos at all, and answers available: false instead', async () => {
      const response = await makeApp({ readOnly: true }).inject({
        method: 'GET',
        url: '/api/concierge/repos',
        headers: capabilityHeaders(TEST_CAPABILITY_TOKEN),
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ available: false, reason: expect.stringContaining('replaying') })
      expect(discoverReposMock).not.toHaveBeenCalled()
    })

    it('a live (non-replay) server always calls discoverRepos', async () => {
      await makeApp({ readOnly: false }).inject({
        method: 'GET',
        url: '/api/concierge/repos',
        headers: capabilityHeaders(TEST_CAPABILITY_TOKEN),
      })
      expect(discoverReposMock).toHaveBeenCalledTimes(1)
    })
  })

  it('is GET-only — a POST is not a registered route', async () => {
    const response = await makeApp().inject({ method: 'POST', url: '/api/concierge/repos' })
    expect(response.statusCode).toBe(404)
  })

  it('needs the capability token — a gated read, like the rest of wave 1 (prd-29 ruling 7, #58)', async () => {
    const bare = await makeApp().inject({ method: 'GET', url: '/api/concierge/repos' })
    expect(bare.statusCode).toBe(401)

    const response = await makeApp().inject({
      method: 'GET',
      url: '/api/concierge/repos',
      headers: capabilityHeaders(TEST_CAPABILITY_TOKEN),
    })
    expect(response.statusCode).toBe(200)
  })

  describe('the app-wide loopback guard (mutation-guard.ts) covers this route too', () => {
    it('a loopback Host succeeds', async () => {
      const response = await makeApp().inject({
        method: 'GET',
        url: '/api/concierge/repos',
        headers: { host: '127.0.0.1:4321', ...capabilityHeaders(TEST_CAPABILITY_TOKEN) },
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

describe('POST /api/concierge/launch', () => {
  let repoPath: string
  let sessionDir: string
  const CAPABILITY_TOKEN = 'test-token'
  const PORT = 4321

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-launch-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-launch-session-'))
    planLaunchMock.mockReset()
    runLaunchMock.mockReset()
    // Clear, not reset — see the migrate mock's own comment above.
    planMigrationMock.mockClear()
    runMigrationMock.mockClear()
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  function makeApp(overrides: { readOnly?: boolean; port?: number } = {}) {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    return buildApp({
      repoPath,
      repoName: 'repo',
      sessionDir,
      recorder,
      capabilityToken: CAPABILITY_TOKEN,
      port: PORT,
      ...overrides,
    })
  }

  function post(app: ReturnType<typeof makeApp>, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/concierge/launch',
      payload: body,
      headers: { [CAPABILITY_TOKEN_HEADER]: CAPABILITY_TOKEN, ...headers },
    })
  }

  it('refuses a request with no capability token, before planLaunch ever runs', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/api/concierge/launch',
      payload: { harness: 'claude', mode: 'launch' },
    })
    expect(response.statusCode).toBe(401)
    expect(planLaunchMock).not.toHaveBeenCalled()
  })

  it('refuses a replay server — nowhere live to launch a conductor into', async () => {
    const response = await post(makeApp({ readOnly: true }), { harness: 'claude', mode: 'launch' })
    expect(response.statusCode).toBe(409)
    expect(planLaunchMock).not.toHaveBeenCalled()
  })

  it('refuses a server with no known port, honestly, rather than launching pointed at nowhere', async () => {
    const response = await post(makeApp({ port: undefined }), { harness: 'claude', mode: 'launch' })
    expect(response.statusCode).toBe(500)
    expect(planLaunchMock).not.toHaveBeenCalled()
  })

  it('refuses port: 0 the same way — "let the OS pick" is real and documented, not only a test value, and this ctx never learns the real bound port', async () => {
    const response = await post(makeApp({ port: 0 }), { harness: 'claude', mode: 'launch' })
    expect(response.statusCode).toBe(500)
    expect(planLaunchMock).not.toHaveBeenCalled()
  })

  it('checks readOnly BEFORE the port guard — a replaying server with no port still answers 409, not 500', async () => {
    // Both failure conditions armed at once, so this would catch a reordering
    // regression the single-condition tests above cannot: each of those only
    // ever turns on ONE guard's failure.
    const response = await post(makeApp({ readOnly: true, port: 0 }), { harness: 'claude', mode: 'launch' })
    expect(response.statusCode).toBe(409)
    expect(planLaunchMock).not.toHaveBeenCalled()
  })

  it('refuses a malformed body with 400, via the real (unmocked) parser', async () => {
    const response = await post(makeApp(), { harness: 42, mode: 'launch' })
    expect(response.statusCode).toBe(400)
    expect(planLaunchMock).not.toHaveBeenCalled()
  })

  it('maps a ConciergeLaunchValidationError from planLaunch to 400', async () => {
    planLaunchMock.mockRejectedValue(new ConciergeLaunchValidationError('unknown harness "bogus"'))
    const response = await post(makeApp(), { harness: 'bogus', mode: 'launch' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'unknown harness "bogus"' })
  })

  it('maps a HarnessNotAvailableError from planLaunch to 409', async () => {
    planLaunchMock.mockRejectedValue(new HarnessNotAvailableError('claude cannot be launched on this machine'))
    const response = await post(makeApp(), { harness: 'claude', mode: 'launch' })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'claude cannot be launched on this machine' })
  })

  it('maps a LaunchContinuityUnavailableError from planLaunch to 409', async () => {
    planLaunchMock.mockRejectedValue(new LaunchContinuityUnavailableError('no continuity story'))
    const response = await post(makeApp(), { harness: 'claude', mode: 'continue' })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'no continuity story' })
  })

  it('plans with ctx.repoPath/port/instance, then reports runLaunch’s outcome in a 200 body', async () => {
    planLaunchMock.mockResolvedValue({
      argv: ['claude'],
      env: {},
      cwd: repoPath,
      telemetry: { level: 'provided' },
    })
    runLaunchMock.mockResolvedValue({ kind: 'launched', pid: 4242 })

    const response = await post(makeApp(), { harness: 'claude', mode: 'launch' })

    // The fourth argument is the resume-by-id session (#517's seam): `undefined`
    // for every other mode, and asserted rather than omitted so a route that
    // stopped forwarding it at all would fail here too.
    expect(planLaunchMock).toHaveBeenCalledWith(
      'claude',
      'launch',
      { watchedRepoPath: repoPath, port: PORT, instance: '1000' },
      undefined,
    )
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      harness: 'claude',
      mode: 'launch',
      telemetry: { level: 'provided' },
      continuity: null,
      migration: null,
      kind: 'launched',
      pid: 4242,
    })
    expect(planMigrationMock).not.toHaveBeenCalled()
  })

  /**
   * #532. The route used to answer `{kind:'launched', pid}` for a conductor
   * that had already exited, because `runLaunch` had no way to notice and this
   * route asked it for nothing more. Two claims, one per half of the fix.
   */
  describe('the launch is reported honestly, and this route lends the clock that makes that possible', () => {
    beforeEach(() => {
      planLaunchMock.mockResolvedValue({ argv: ['claude'], env: {}, cwd: repoPath, telemetry: { level: 'provided' } })
    })

    it('a died outcome rides the 200 body verbatim — never rewritten into a launched, never a 500', async () => {
      runLaunchMock.mockResolvedValue({
        kind: 'died',
        via: 'detached',
        message: 'the process started and then exited with code 1 straight away',
      })

      const response = await post(makeApp(), { harness: 'claude', mode: 'launch' })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        harness: 'claude',
        mode: 'launch',
        telemetry: { level: 'provided' },
        continuity: null,
        migration: null,
        kind: 'died',
        via: 'detached',
        message: 'the process started and then exited with code 1 straight away',
      })
    })

    it('a tmux launch says WHERE — via and window cross into the body unchanged', async () => {
      runLaunchMock.mockResolvedValue({ kind: 'launched', via: 'tmux', pid: 9911, window: 'main:3' })

      const response = await post(makeApp(), { harness: 'claude', mode: 'launch' })

      expect(response.json()).toMatchObject({ kind: 'launched', via: 'tmux', pid: 9911, window: 'main:3' })
    })

    /**
     * The concierge owns no clock (its namespace law's clause 3), so the wait
     * that makes a `died` findable at all is this route's to supply. Asserted
     * as a REAL delay, not merely a function: a `wait` stubbed to resolve at
     * once would satisfy the type, pass a `toHaveBeenCalledWith(expect.any(
     * Function))`, and quietly restore the defect — the settle window would
     * close before any child could exit inside it.
     */
    it('hands runLaunch a wait that really waits', async () => {
      runLaunchMock.mockResolvedValue({ kind: 'launched', via: 'detached', pid: 4242 })

      await post(makeApp(), { harness: 'claude', mode: 'launch' })

      const options = runLaunchMock.mock.calls[0]?.[1] as { wait: (ms: number) => Promise<void> }
      expect(typeof options.wait).toBe('function')
      const before = Date.now()
      await options.wait(25)
      expect(Date.now() - before).toBeGreaterThanOrEqual(20)
    })
  })

  it('a spawn failure still answers 200 — the outcome rides in the body, never the status line', async () => {
    planLaunchMock.mockResolvedValue({ argv: ['claude'], env: {}, cwd: repoPath, telemetry: { level: 'provided' } })
    runLaunchMock.mockResolvedValue({ kind: 'error', message: 'could not start claude: ENOENT' })

    const response = await post(makeApp(), { harness: 'claude', mode: 'launch' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ kind: 'error', message: 'could not start claude: ENOENT' })
  })

  it('a continue-mode plan’s continuity AND telemetry ride along VERBATIM — never hardcoded, never upgraded', async () => {
    const continuity = {
      kind: 'proven',
      argv: ['--continue'],
      whatContinues: 'the conversation',
      whatIsLost: 'nothing',
      evidence: 'fixture',
    }
    // Deliberately NOT `{ level: 'provided' }` — every other fixture in this
    // file uses that value, which would let a route that hardcodes it in the
    // response (instead of forwarding `plan.telemetry`) pass every other
    // test here. `absent` proves the pass-through is real.
    const telemetry = { level: 'absent' as const, reason: 'fixture: this harness reports no telemetry' }
    planLaunchMock.mockResolvedValue({
      argv: ['claude', '--continue'],
      env: {},
      cwd: repoPath,
      telemetry,
      continuity,
    })
    runLaunchMock.mockResolvedValue({ kind: 'launched', pid: 4343 })

    const response = await post(makeApp(), { harness: 'claude', mode: 'continue' })

    // Full-body `toEqual`, not `toMatchObject`: also proves `mode` is echoed
    // as the REQUEST's mode ('continue'), not hardcoded to 'launch' the way
    // the sibling fresh-launch test above could not distinguish.
    expect(response.json()).toEqual({
      harness: 'claude',
      mode: 'continue',
      telemetry,
      continuity,
      // `continue` has nothing to migrate — an explicit null, not an absent key.
      migration: null,
      kind: 'launched',
      pid: 4343,
    })
    expect(planMigrationMock).not.toHaveBeenCalled()
  })

  describe('the app-wide mutation guard (mutation-guard.ts) covers this route too', () => {
    it('a non-loopback Host is refused before the route ever runs', async () => {
      const response = await post(makeApp(), { harness: 'claude', mode: 'launch' }, { host: 'evil.example' })
      expect(response.statusCode).toBe(400)
      expect(planLaunchMock).not.toHaveBeenCalled()
    })

    it('a cross-origin Origin is refused as a mutating request', async () => {
      const response = await post(makeApp(), { harness: 'claude', mode: 'launch' }, { origin: 'https://evil.example' })
      expect(response.statusCode).toBe(403)
      expect(planLaunchMock).not.toHaveBeenCalled()
    })
  })
})

/**
 * `mode: 'resume'` — prd-20 ruling 6 / ADR-0020 wired through the route (#519).
 *
 * A bare `Fastify()` rather than `buildApp`, the same shape
 * `session-preview.test.ts` uses for the same reason: the temp
 * `~/.claude/projects` this suite writes into reaches the route through its own
 * options seam, and `buildApp`/`ServerContext` have no such field (nor should
 * they — one route reads that root). The capability-token preHandler is
 * registered by the route itself, so it is still under test here; the app-wide
 * mutation guard is covered by the `buildApp` suites above.
 *
 * Nothing below touches the real `~/.claude`: every root is a `mkdtemp` this
 * file removes.
 */
describe('POST /api/concierge/launch — mode: resume brings the transcript home', () => {
  const CAPABILITY_TOKEN = 'test-token'
  const PORT = 4321
  const SESSION_ID = '200fb100-b3e2-4828-a3a6-01333a255127'

  let root: string
  let projectsRoot: string
  let repoPath: string
  let originRepoPath: string
  let sessionDir: string

  beforeEach(async () => {
    // `realpathSync`: the destination slug is derived from the watched repo's
    // CANONICAL path (Claude Code slugs its own resolved `cwd`), and on macOS
    // `mkdtemp` hands back the unresolved `/var/…` spelling — a raw-path
    // expectation would pass vacuously on Linux and fail on the macOS leg.
    root = realpathSync(await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-resume-')))
    projectsRoot = path.join(root, 'claude-projects')
    repoPath = path.join(root, 'watched-repo')
    originRepoPath = path.join(root, 'origin-repo')
    sessionDir = path.join(root, 'session')
    await mkdir(repoPath, { recursive: true })
    await mkdir(originRepoPath, { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await writeTranscript(originTranscript(), [userLine('the conversation that began somewhere else')])

    planLaunchMock.mockReset()
    runLaunchMock.mockReset()
    planMigrationMock.mockClear()
    runMigrationMock.mockClear()
    planLaunchMock.mockResolvedValue({
      argv: ['/usr/local/bin/claude', '--resume', SESSION_ID],
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
      cwd: repoPath,
      telemetry: { level: 'provided' },
      continuity: {
        kind: 'proven',
        argv: ['--resume', SESSION_ID],
        whatContinues: 'the conversation',
        whatIsLost: 'every token the origin already spent',
        evidence: 'research/2026-08-14-cross-host-resume.md',
      },
    })
    runLaunchMock.mockResolvedValue({ kind: 'launched', pid: 5150 })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function slugDir(repo: string): string {
    return path.join(projectsRoot, worktreePathToProjectSlug(repo))
  }

  function originTranscript(): string {
    return path.join(slugDir(originRepoPath), `${SESSION_ID}.jsonl`)
  }

  function homeTranscript(): string {
    return path.join(slugDir(repoPath), `${SESSION_ID}.jsonl`)
  }

  function userLine(text: string): string {
    return JSON.stringify({ type: 'user', sessionId: SESSION_ID, message: { role: 'user', content: text } })
  }

  async function writeTranscript(filePath: string, lines: readonly string[]): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, lines.map((line) => `${line}\n`).join(''))
  }

  /** The event log's own attribution — the only thing that can name a source. */
  function sessionEvents(sessionId: string = SESSION_ID): RhizomorphEvent[] {
    const f = createEventFactory()
    return [f.llmUsage({ lane: 'conductor', branch: 'conductor', sessionId, worktreePath: originRepoPath })]
  }

  function makeApp(events: readonly RhizomorphEvent[] = sessionEvents()) {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'), { resumeFrom: events })
    const app = Fastify()
    registerConciergeLaunchRoute(
      app,
      { repoPath, repoName: 'repo', sessionDir, recorder, capabilityToken: CAPABILITY_TOKEN, port: PORT },
      { claudeProjectsRoot: projectsRoot },
    )
    return app
  }

  function post(app: ReturnType<typeof makeApp>, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/concierge/launch',
      payload: body,
      headers: { [CAPABILITY_TOKEN_HEADER]: CAPABILITY_TOKEN },
    })
  }

  function resume(app: ReturnType<typeof makeApp>, sessionId: string = SESSION_ID) {
    return post(app, { harness: 'claude', mode: 'resume', sessionId })
  }

  async function sha256(filePath: string): Promise<string> {
    return createHash('sha256').update(await readFile(filePath)).digest('hex')
  }

  it('copies the transcript, then launches the resume — one request, end to end', async () => {
    const sourceHash = await sha256(originTranscript())

    const response = await resume(makeApp())

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      harness: 'claude',
      mode: 'resume',
      telemetry: { level: 'provided' },
      continuity: {
        kind: 'proven',
        argv: ['--resume', SESSION_ID],
        whatContinues: 'the conversation',
        whatIsLost: 'every token the origin already spent',
        evidence: 'research/2026-08-14-cross-host-resume.md',
      },
      migration: { kind: 'migrated', at: homeTranscript() },
      kind: 'launched',
      pid: 5150,
    })

    // The copy is real, and it is where a resume in the watched repo looks.
    expect(await sha256(homeTranscript())).toBe(sourceHash)
    // The origin is untouched — ADR-0020's rollback.
    expect(await sha256(originTranscript())).toBe(sourceHash)

    // And the id reaches the launch plan: the fourth argument is what makes
    // this a resume rather than a fresh launch (#517's seam, wired here).
    expect(planLaunchMock).toHaveBeenCalledWith(
      'claude',
      'resume',
      { watchedRepoPath: repoPath, port: PORT, instance: '1000' },
      SESSION_ID,
    )
    expect(runLaunchMock).toHaveBeenCalledTimes(1)
  })

  it('migrates BEFORE it plans the launch — the file is home by the time the harness is asked', async () => {
    // Ordering, asserted rather than assumed: `planLaunch`'s own resume story
    // is what a harness answers for, and the transcript has to be in place for
    // the process it eventually spawns to find anything.
    let presentWhenPlanned = false
    planLaunchMock.mockImplementation(async () => {
      presentWhenPlanned = (await readFile(homeTranscript(), 'utf8')).length > 0
      return { argv: ['claude'], env: {}, cwd: repoPath, telemetry: { level: 'provided' } }
    })

    await resume(makeApp())

    expect(presentWhenPlanned).toBe(true)
  })

  it('404s a session id this event log never attributed, and launches nothing', async () => {
    const response = await resume(makeApp(sessionEvents('edf0eb2b-9c37-4d15-8f06-99e9306cdac6')))

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: expect.stringContaining('NO SUCH SESSION') })
    expect(planLaunchMock).not.toHaveBeenCalled()
    expect(runLaunchMock).not.toHaveBeenCalled()
  })

  it('404s an attributed session whose transcript is not on disk — the client\'s command-only cue', async () => {
    await rm(originTranscript())

    const response = await resume(makeApp())

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: expect.stringContaining('NO TRANSCRIPT') })
    expect(planLaunchMock).not.toHaveBeenCalled()
  })

  it('400s a metadata-only stub, and says what it is rather than what is missing', async () => {
    // The spike's own finding: `--resume` gives a stub the SAME error a missing
    // file gives, so a 404 here would tell the operator to look for a file that
    // is sitting right there.
    await writeTranscript(originTranscript(), [
      JSON.stringify({ type: 'ai-title', aiTitle: 'a session with no turns', sessionId: SESSION_ID }),
      JSON.stringify({ type: 'agent-name', agentName: 'a session with no turns', sessionId: SESSION_ID }),
    ])

    const response = await resume(makeApp())

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: expect.stringContaining('NOT RESUMABLE') })
    expect(response.json().error).toContain('No conversation found with session ID')
    expect(planLaunchMock).not.toHaveBeenCalled()
  })

  it('403s a fence refusal — an existing destination is never overwritten', async () => {
    await writeTranscript(homeTranscript(), [userLine('someone else\'s history')])
    const untouched = await sha256(homeTranscript())

    const response = await resume(makeApp())

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: expect.stringContaining('refusing to migrate') })
    expect(await sha256(homeTranscript())).toBe(untouched)
    expect(planLaunchMock).not.toHaveBeenCalled()
  })

  it('400s a malformed sessionId at the parser, before the event log or a path is touched', async () => {
    const response = await resume(makeApp(), '../../etc/passwd')

    expect(response.statusCode).toBe(400)
    expect(planMigrationMock).not.toHaveBeenCalled()
    expect(planLaunchMock).not.toHaveBeenCalled()
  })

  it('409s a harness with no resume story, the same as any other continuity refusal', async () => {
    planLaunchMock.mockRejectedValue(new LaunchContinuityUnavailableError('codex has no resume-by-id story'))

    const response = await resume(makeApp())

    expect(response.statusCode).toBe(409)
    // The copy already happened — planning the launch is what refused. That is
    // one duplicate transcript under `~/.claude`, which is create-only and
    // retryable (a second attempt reports `already-present`), and it is the
    // price of the order this route runs in.
    expect(await sha256(homeTranscript())).toBe(await sha256(originTranscript()))
  })

  describe('a runtime copy failure rides the 200 body — and nothing is spawned', () => {
    it('reports migration: copy-failed with kind: error, and never calls runLaunch', async () => {
      // The one outcome that needs a broken filesystem to reach for real
      // (`concierge/migrate.test.ts` produces it there, from a source deleted
      // between the plan and the copy), so it is injected here — the route's
      // own handling of it is what this test is about.
      runMigrationMock.mockResolvedValueOnce({ kind: 'copy-failed', message: 'EACCES: permission denied, copyfile' })

      const response = await resume(makeApp())

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.migration).toEqual({ kind: 'copy-failed', message: 'EACCES: permission denied, copyfile' })
      expect(body.kind).toBe('error')
      expect(body.message).toContain('EACCES')
      expect(body.message).toContain('not launched')
      // A `--resume` whose transcript never arrived exits immediately with the
      // same "No conversation found" error, so spawning it would be claiming an
      // act this route already knows cannot work.
      expect(runLaunchMock).not.toHaveBeenCalled()
    })

    it('but an already-present destination is success — the resume proceeds, ids being UUIDs', async () => {
      // Only reachable through the TOCTOU the fence cannot close (it refuses to
      // PLAN a copy onto an existing destination), so this one is injected too.
      runMigrationMock.mockResolvedValueOnce({ kind: 'already-present', at: homeTranscript() })

      const response = await resume(makeApp())

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        migration: { kind: 'already-present', at: homeTranscript() },
        kind: 'launched',
        pid: 5150,
      })
      expect(runLaunchMock).toHaveBeenCalledTimes(1)
    })

    it('and a not-needed migration launches too — the transcript began in this very repo', async () => {
      await rm(originTranscript())
      await writeTranscript(homeTranscript(), [userLine('this conversation began right here')])
      const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'), {
        resumeFrom: [
          createEventFactory().llmUsage({
            lane: 'conductor',
            branch: 'conductor',
            sessionId: SESSION_ID,
            worktreePath: repoPath,
          }),
        ],
      })
      const app = Fastify()
      registerConciergeLaunchRoute(
        app,
        { repoPath, repoName: 'repo', sessionDir, recorder, capabilityToken: CAPABILITY_TOKEN, port: PORT },
        { claudeProjectsRoot: projectsRoot },
      )

      const response = await resume(app)

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        migration: { kind: 'not-needed', at: homeTranscript() },
        kind: 'launched',
      })
    })
  })

  it('refuses a request with no capability token, before any migration is planned', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/api/concierge/launch',
      payload: { harness: 'claude', mode: 'resume', sessionId: SESSION_ID },
    })

    expect(response.statusCode).toBe(401)
    expect(planMigrationMock).not.toHaveBeenCalled()
  })
})
