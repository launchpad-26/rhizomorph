import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { repoSlug, sessionDirFor } from '../log/paths.js'
import { decideSessionBoot, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import { writeSessionLock } from '../log/session-lock.js'
import { buildApp } from '../server/build-app.js'
import type { ServerContext } from '../server/context.js'
import type { PollLoop, PollLoopResetOptions } from '../server/poll-loop.js'
import { SessionRecorder } from '../server/recorder.js'
import { CAPABILITY_TOKEN_HEADER } from './security.js'

/**
 * `POST /api/retarget` (#389) — the route prd20 ruling 5's four halves
 * assemble into.
 *
 * The tests below are about the ORDER, because every part in isolation is
 * already pinned by its own issue's suite (`recorder/rotate.test.ts`,
 * `server/retarget-validation.test.ts`, `server/build-app.test.ts`,
 * `server/poll-loop.test.ts`). What only this level can say is that validation
 * happened before the release, that the poll loop was down across the seal and
 * came back pointed at the NEW repo, and that a refusal left the operator
 * exactly where they were.
 */

const TOKEN = 'test-capability-token'
const CLOCK = 5000

/**
 * What the loop was asked to do, and what the context said at the moment it
 * was asked. The second half is the ordering assertion: `reset` reading a
 * context that still named the old repo — or a recorder still on the old
 * session — is the silent bug this route exists to not have, since a loop
 * polling a real repo looks entirely healthy either way.
 */
interface LoopCall {
  phase: 'stop' | 'reset' | 'start'
  ctxRepoPath: string
  ctxSessionDir: string
  sessionId: string
  resetRepoPath?: string | undefined
}

describe('POST /api/retarget', () => {
  let root: string
  let dataRoot: string
  let watched: string
  let adopted: string
  let recorder: SessionRecorder
  let ctx: ServerContext
  let loopLog: LoopCall[]

  function git(cwd: string, args: string[]): void {
    execFileSync('git', args, { cwd, encoding: 'utf8' })
  }

  async function makeRepo(dir: string): Promise<string> {
    await mkdir(dir, { recursive: true })
    git(dir, ['init', '-b', 'main'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'Test'])
    await writeFile(path.join(dir, 'tracked.txt'), 'v1\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-m', 'initial commit'])
    return dir
  }

  /** Stands in for `cli/run.ts`'s real loop, recording each phase and what it saw. */
  function spyLoop(log: LoopCall[]): PollLoop {
    const snap = (phase: LoopCall['phase'], resetRepoPath?: string): void => {
      log.push({
        phase,
        ctxRepoPath: ctx.repoPath,
        ctxSessionDir: ctx.sessionDir,
        sessionId: recorder.sessionId,
        resetRepoPath,
      })
    }
    return {
      start: () => snap('start'),
      stop: async () => snap('stop'),
      tick: async () => {},
      reset: async (options: PollLoopResetOptions = {}) => snap('reset', options.repoPath),
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-retarget-route-test-'))
    dataRoot = path.join(root, 'data')
    watched = await makeRepo(path.join(root, 'watched'))
    adopted = await makeRepo(path.join(root, 'adopted'))
    loopLog = []

    const sessionDir = sessionDirFor(watched, dataRoot)
    recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    await recorder.record(
      createEvent(
        'session.started',
        { sessionId: '1000', repoPath: watched, repoName: 'watched' },
        { id: 'evt-1', ts: 1000 },
      ),
    )
    await writeSessionLock(sessionDir, '1000', process.pid, 1000)

    ctx = {
      repoPath: watched,
      repoName: 'watched',
      sessionDir,
      recorder,
      capabilityToken: TOKEN,
      now: () => CLOCK,
      pollLoop: spyLoop(loopLog),
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function post(app: ReturnType<typeof buildApp>, body: unknown, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/retarget',
      headers: { 'content-type': 'application/json', [CAPABILITY_TOKEN_HEADER]: TOKEN, ...headers },
      payload: JSON.stringify(body),
    })
  }

  it('closes over there, opens over here, and says which is which', async () => {
    const app = buildApp(ctx)
    const response = await post(app, { path: adopted })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.from).toEqual({
      repoPath: watched,
      repoName: 'watched',
      repoSlug: repoSlug(watched),
      sessionDir: sessionDirFor(watched, dataRoot),
    })
    expect(body.to).toEqual({
      repoPath: adopted,
      repoName: 'adopted',
      repoSlug: repoSlug(adopted),
      sessionDir: sessionDirFor(adopted, dataRoot),
    })
    expect(body.closed.sessionId).toBe('1000')
    expect(body.opened.sessionId).toBe(String(CLOCK))

    await app.close()
  })

  it('the two logs name each other across the seam', async () => {
    const app = buildApp(ctx)
    await post(app, { path: adopted })

    const closed = await readSessionEvents(sessionFilePath(sessionDirFor(watched, dataRoot), '1000'))
    expect(closed.at(-1)?.payload).toMatchObject({
      reason: 'retargeted',
      successor: { repoSlug: repoSlug(adopted) },
    })

    const opened = await readSessionEvents(sessionFilePath(sessionDirFor(adopted, dataRoot), String(CLOCK)))
    expect(opened[0]?.payload).toMatchObject({
      repoPath: adopted,
      predecessor: { repoSlug: repoSlug(watched), sessionId: '1000' },
    })

    await app.close()
  })

  it('every route answers for the adopted repo from the very next request', async () => {
    const app = buildApp(ctx)
    await post(app, { path: adopted })

    const meta = (await app.inject({ method: 'GET', url: '/api/meta' })).json()
    expect(meta).toMatchObject({ repoPath: adopted, repoName: 'adopted', sessionId: String(CLOCK) })
    // …and the provenance bar is told the honest word. Recording this as
    // `rotated` would say the predecessor is the previous log in THIS repo's
    // replay picker, and it is not — it is under the old repo's slug.
    expect(meta.lastBootReason).toBe('retargeted')

    // The replay picker really did move with it: only the adopted repo's own
    // recordings, never the closed one from over there.
    const sessions = (await app.inject({ method: 'GET', url: '/api/sessions', headers: { [CAPABILITY_TOKEN_HEADER]: TOKEN } })).json()
    expect(sessions.sessions.map((s: { id: string }) => s.id)).toEqual([String(CLOCK)])

    await app.close()
  })

  describe('the poll loop is down across the seal, and comes back pointed at the NEW repo', () => {
    it('stops, then resets and starts — in that order and no other', async () => {
      const app = buildApp(ctx)
      await post(app, { path: adopted })

      expect(loopLog.map((call) => call.phase)).toEqual(['stop', 'reset', 'start'])
      await app.close()
    })

    it('the stop happens while the OLD session is still open — nothing ticks into the seal', async () => {
      const app = buildApp(ctx)
      await post(app, { path: adopted })

      const stopped = loopLog[0]
      expect(stopped?.sessionId).toBe('1000')
      expect(stopped?.ctxRepoPath).toBe(watched)
      await app.close()
    })

    it('the reset happens after the re-point, so the rebuilt loop reads the adopted repo', async () => {
      const app = buildApp(ctx)
      await post(app, { path: adopted })

      // Resetting before the re-point would hand the loop the repo just left
      // and land the new session's snapshots in the closed session's dir —
      // silently, since a loop polling a real repo looks entirely healthy.
      const reset = loopLog[1]
      expect(reset?.resetRepoPath).toBe(adopted)
      expect(reset?.ctxRepoPath).toBe(adopted)
      expect(reset?.ctxSessionDir).toBe(sessionDirFor(adopted, dataRoot))
      expect(reset?.sessionId).toBe(String(CLOCK))
      await app.close()
    })
  })

  it('the lock moves: none left in the old repo, one held in the new', async () => {
    const app = buildApp(ctx)
    await post(app, { path: adopted })

    expect((await readdir(sessionDirFor(watched, dataRoot))).filter((n) => n.endsWith('.lock.json'))).toEqual([])
    expect((await readdir(sessionDirFor(adopted, dataRoot))).filter((n) => n.endsWith('.lock.json'))).toEqual([
      `session-${CLOCK}.lock.json`,
    ])

    await app.close()
  })

  describe('a refusal leaves the operator exactly where they were', () => {
    async function expectUntouched(app: ReturnType<typeof buildApp>): Promise<void> {
      // Nothing closed, nothing re-pointed, nothing stopped and left down.
      const events = await readSessionEvents(sessionFilePath(sessionDirFor(watched, dataRoot), '1000'))
      expect(events.map((e) => e.type)).toEqual(['session.started'])
      expect(ctx.repoPath).toBe(watched)
      expect(recorder.sessionId).toBe('1000')
      expect(loopLog).toEqual([])
      expect((await app.inject({ method: 'GET', url: '/api/meta' })).json()).toMatchObject({ repoPath: watched })
      // …and the lock is still ours, so the recording cannot be taken either.
      expect((await decideSessionBoot(sessionDirFor(watched, dataRoot), CLOCK)).reason).toBe('writer-alive')
    }

    it('409s a path that does not exist', async () => {
      const app = buildApp(ctx)
      const response = await post(app, { path: path.join(root, 'never-cloned') })

      expect(response.statusCode).toBe(409)
      expect(response.json().code).toBe('not-found')
      await expectUntouched(app)
      await app.close()
    })

    it('409s a directory that is not a git work tree — the running-instrument-watching-nothing case', async () => {
      await mkdir(path.join(root, 'just-a-folder'), { recursive: true })
      const app = buildApp(ctx)
      const response = await post(app, { path: path.join(root, 'just-a-folder') })

      expect(response.statusCode).toBe(409)
      expect(response.json().code).toBe('not-a-repo')
      await expectUntouched(app)
      await app.close()
    })

    it('409s a repo another live rhizomorph already holds', async () => {
      // A recording AND its live lock: `decideSessionBoot` reads the session
      // dir's newest log first, so a bare lock file with no session beside it
      // is `first-run`, not a writer. The second instance ruling 5 forbids is
      // one that is actually recording.
      const theirs = sessionDirFor(adopted, dataRoot)
      const theirRecorder = new SessionRecorder('900', sessionFilePath(theirs, '900'))
      await theirRecorder.record(
        createEvent(
          'session.started',
          { sessionId: '900', repoPath: adopted, repoName: 'adopted' },
          { id: 'evt-900', ts: 900 },
        ),
      )
      await writeSessionLock(theirs, '900', process.pid, 900)
      const app = buildApp(ctx)
      const response = await post(app, { path: adopted })

      expect(response.statusCode).toBe(409)
      expect(response.json().code).toBe('writer-alive')
      expect(response.json().error).toContain('the second instance prd-20 ruling 5 forbids')
      await expectUntouched(app)
      await app.close()
    })

    it('409s the repo we are already watching, and points at rotate instead', async () => {
      // Asked before the lock is ever read: our OWN live lock is in that
      // session dir, so the validator's honest answer would name our own pid.
      const app = buildApp(ctx)
      const response = await post(app, { path: watched })

      expect(response.statusCode).toBe(409)
      expect(response.json().code).toBe('already-watching')
      expect(response.json().error).toContain('rhizomorph rotate')
      expect(response.json().error).not.toContain(String(process.pid))
      await expectUntouched(app)
      await app.close()
    })

    it('409s a replay server — a finished record has no live recording to move', async () => {
      const app = buildApp({ ...ctx, readOnly: true })
      const response = await post(app, { path: adopted })

      expect(response.statusCode).toBe(409)
      expect(response.json().error).toContain('replaying a session record')
      await app.close()
    })

    it('400s a body with no usable path, and touches nothing', async () => {
      const app = buildApp(ctx)
      for (const body of [{}, { path: '' }, { path: '   ' }, { path: 7 }, [], 'nope']) {
        const response = await post(app, body)
        expect(response.statusCode, JSON.stringify(body)).toBe(400)
      }
      await expectUntouched(app)
      await app.close()
    })
  })

  describe('the gate (prd-20 ruling 2 / #234)', () => {
    it('401s without the capability token — a bare curl cannot move the instrument', async () => {
      const app = buildApp(ctx)
      const response = await app.inject({
        method: 'POST',
        url: '/api/retarget',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ path: adopted }),
      })

      expect(response.statusCode).toBe(401)
      // The refusal is the gate, not the validation: nothing was even looked
      // at, and the loop was never touched.
      const events = await readSessionEvents(sessionFilePath(sessionDirFor(watched, dataRoot), '1000'))
      expect(events.map((e) => e.type)).toEqual(['session.started'])
      expect(loopLog).toEqual([])
      await app.close()
    })

    it('401s a wrong token', async () => {
      const app = buildApp(ctx)
      const response = await post(app, { path: adopted }, { [CAPABILITY_TOKEN_HEADER]: 'not-the-token' })
      expect(response.statusCode).toBe(401)
      expect(ctx.repoPath).toBe(watched)
      await app.close()
    })
  })

  it('resolves a relative path against this process, and adopts it', async () => {
    const app = buildApp(ctx)
    const relative = path.relative(process.cwd(), adopted)
    const response = await post(app, { path: relative })

    expect(response.statusCode).toBe(200)
    expect(response.json().to.repoPath).toBe(adopted)

    await app.close()
  })

  it('retargets again, and back — the boundary is repeatable, not a one-shot', async () => {
    const app = buildApp(ctx)
    expect((await post(app, { path: adopted })).statusCode).toBe(200)

    // The clock is pinned, so the second boundary's id is one past the first's
    // (`nextSessionStart`) rather than the same millisecond again.
    const back = await post(app, { path: watched })
    expect(back.statusCode).toBe(200)
    expect(back.json().to.repoPath).toBe(watched)
    expect(back.json().closed.sessionId).toBe(String(CLOCK))
    expect(ctx.repoPath).toBe(watched)

    await app.close()
  })

  it('a server with no poll loop retargets anyway — the loop is optional, the boundary is not', async () => {
    const { pollLoop: _dropped, ...loopless } = ctx
    const app = buildApp(loopless)
    const response = await post(app, { path: adopted })

    expect(response.statusCode).toBe(200)
    expect(loopless.repoPath).toBe(adopted)

    await app.close()
  })
})
