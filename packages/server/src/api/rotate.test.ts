import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AnyCollector, CollectorContext } from '@rhizomorph/core'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapshotDirFor } from '../log/paths.js'
import { readSessionEvents, RESUME_WINDOW_MS, sessionFilePath } from '../log/session-log.js'
import { readSessionLock, writeSessionLock } from '../log/session-lock.js'
import { writeSessionLabel } from '../log/label.js'
import { SessionRecorder } from '../server/recorder.js'
import { buildApp } from '../server/build-app.js'
import { createPollLoop } from '../server/poll-loop.js'
import { recordSessionBootMeta } from './meta.js'
import { CAPABILITY_TOKEN_HEADER } from './security.js'

/**
 * `POST /api/rotate` — a mutating route (prd16 ruling 2), end to end through
 * the app the dashboard button and `rhizomorph rotate` both talk to. The
 * rotation's own laws live in `recorder/rotate.test.ts`; what is asserted here
 * is the wiring the operator actually experiences: the boundary happens,
 * `/api/meta` explains it, and the freshly-closed session is in the picker's
 * listing immediately, with its label machinery intact.
 *
 * Every happy-path injection below carries the capability token, because since
 * #234 the route requires it — the gate's own tests are the first `describe`
 * block, and the rest of the file proves the route still does everything it
 * did once a caller is authorised.
 */

const FIRST = '1000'
const ROTATE_AT = 5000

describe('POST /api/rotate', () => {
  let repoPath: string
  let sessionDir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rotate-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rotate-dir-'))
    recorder = new SessionRecorder(FIRST, sessionFilePath(sessionDir, FIRST))
    await recorder.record(
      createEvent(
        'session.started',
        { sessionId: FIRST, repoPath, repoName: 'repo' },
        { id: 'evt-000001', ts: Number(FIRST) },
      ),
    )
    await writeSessionLock(sessionDir, FIRST, process.pid, Number(FIRST))
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  function makeApp(overrides: { readOnly?: boolean } = {}) {
    return buildApp({
      repoPath,
      repoName: 'repo',
      sessionDir,
      recorder,
      now: () => ROTATE_AT,
      ...overrides,
    })
  }

  /** The header a caller who was actually served the page would carry (ADR-0012). */
  function authorised(app: ReturnType<typeof makeApp>): Record<string, string> {
    return { [CAPABILITY_TOKEN_HEADER]: app.capabilityToken }
  }

  /**
   * #234's first defect. `POST /api/rotate` forks nothing, but it ends the
   * operator's recording — and the app-wide guard deliberately admits a
   * request with no `Origin` (`server/mutation-guard.ts`), which is every
   * non-browser caller. So before this issue, a bare `curl` from any local
   * process could close the session out from under the dashboard.
   *
   * These assert the refusal AND that nothing happened behind it: the session
   * is untouched, the lock is still held, and no `session.closed` was written.
   * A 401 that still rotated would be worse than no gate at all.
   */
  describe('requires the capability token (#234)', () => {
    it('refuses a tokenless request — the bare curl this issue is about — and rotates nothing', async () => {
      const app = makeApp()

      const response = await app.inject({ method: 'POST', url: '/api/rotate' })

      expect(response.statusCode).toBe(401)
      expect((response.json() as { error: string }).error).toContain(CAPABILITY_TOKEN_HEADER)

      expect(recorder.sessionId).toBe(FIRST)
      expect(await readSessionLock(sessionDir, FIRST)).not.toBeNull()
      expect((await readSessionEvents(sessionFilePath(sessionDir, FIRST))).map((e) => e.type)).toEqual([
        'session.started',
      ])
      expect(await readSessionLock(sessionDir, String(ROTATE_AT))).toBeNull()
    })

    it('refuses a wrong token just as flatly — a guess is not a capability', async () => {
      const app = makeApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/rotate',
        headers: { [CAPABILITY_TOKEN_HEADER]: 'not-the-real-token' },
      })

      expect(response.statusCode).toBe(401)
      expect(recorder.sessionId).toBe(FIRST)
    })

    it('lets the correctly-tokened request through — the gate is a gate, not a wall', async () => {
      const app = makeApp()

      const response = await app.inject({ method: 'POST', url: '/api/rotate', headers: authorised(app) })

      expect(response.statusCode).toBe(200)
      expect(recorder.sessionId).toBe(String(ROTATE_AT))
    })
  })

  it('closes the running session, opens a fresh one, and reports both', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'POST', url: '/api/rotate', headers: authorised(app) })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      closed: {
        sessionId: FIRST,
        filePath: sessionFilePath(sessionDir, FIRST),
        eventCount: 2,
        closedAt: ROTATE_AT,
      },
      opened: {
        sessionId: String(ROTATE_AT),
        filePath: sessionFilePath(sessionDir, String(ROTATE_AT)),
        startedAt: ROTATE_AT,
      },
    })

    expect((await readSessionEvents(sessionFilePath(sessionDir, FIRST))).at(-1)?.type).toBe('session.closed')
    expect(await readSessionLock(sessionDir, FIRST)).toBeNull()
    expect(await readSessionLock(sessionDir, String(ROTATE_AT))).not.toBeNull()
  })

  it('never rotates on a GET — the boundary takes a POST, so no link or prefetch can cross it', async () => {
    const app = makeApp()
    // With no web build configured this falls through to the shell's own
    // catch-all page; what matters is that nothing was recorded or closed.
    await app.inject({ method: 'GET', url: '/api/rotate' })

    expect(recorder.sessionId).toBe(FIRST)
    expect((await readSessionEvents(sessionFilePath(sessionDir, FIRST))).map((e) => e.type)).toEqual([
      'session.started',
    ])
  })

  it('/api/meta then names the NEW session, and says the operator rotated', async () => {
    recordSessionBootMeta(recorder, {
      resumedCount: 3,
      resumeWindowMs: 90 * 60_000,
      lastBootReason: 'resumed',
    })
    const app = makeApp()

    const before = (await app.inject({ method: 'GET', url: '/api/meta' })).json() as Record<string, unknown>
    expect(before).toMatchObject({ sessionId: FIRST, lastBootReason: 'resumed', resumedCount: 3 })

    await app.inject({ method: 'POST', url: '/api/rotate', headers: authorised(app) })

    const after = (await app.inject({ method: 'GET', url: '/api/meta' })).json() as Record<string, unknown>
    expect(after).toMatchObject({
      sessionId: String(ROTATE_AT),
      startedAt: ROTATE_AT,
      lastBootReason: 'rotated',
      // Nothing resumed this session.
      resumedCount: 0,
      // …and the count is the LIVE one (#592), which after a rotation is the
      // new log's own `session.started` and nothing else. The frozen 0 this
      // used to assert is exactly the defect: it stayed 0 forever while the
      // new session's log grew.
      eventCount: 1,
      // …but the window this run measures against did not change.
      resumeWindowMs: 90 * 60_000,
    })
  })

  it('falls back to the stock resume window when the boot never recorded one', async () => {
    const app = makeApp()
    await app.inject({ method: 'POST', url: '/api/rotate', headers: authorised(app) })

    const meta = (await app.inject({ method: 'GET', url: '/api/meta' })).json() as Record<string, unknown>
    expect(meta).toMatchObject({ lastBootReason: 'rotated', resumeWindowMs: RESUME_WINDOW_MS })
  })

  it('puts the freshly-closed session in the picker immediately, label machinery intact', async () => {
    await writeSessionLabel(sessionDir, FIRST, 'the morning run', ROTATE_AT - 1)
    const app = makeApp()

    await app.inject({ method: 'POST', url: '/api/rotate', headers: authorised(app) })

    const listing = (await app.inject({ method: 'GET', url: '/api/sessions', headers: authorised(app) })).json() as {
      sessions: Array<Record<string, unknown>>
    }
    expect(listing.sessions.map((session) => session.id)).toEqual([FIRST, String(ROTATE_AT)])
    // The closed one is read off the directory, and its operator label still wins.
    expect(listing.sessions[0]).toMatchObject({ id: FIRST, label: 'the morning run', title: 'the morning run' })
    // The live one is the new session, titled from its own events.
    expect(listing.sessions[1]).toMatchObject({ id: String(ROTATE_AT), label: null })
    expect(typeof listing.sessions[1]?.title).toBe('string')

    // And it replays: the closed log is served from disk, close event included.
    const events = (await app.inject({ method: 'GET', url: `/api/sessions/${FIRST}/events`, headers: authorised(app) })).json() as {
      events: Array<{ type: string }>
    }
    expect(events.events.map((event) => event.type)).toEqual(['session.started', 'session.closed'])
  })

  it('refuses to rotate a replayed record — a finished recording is not ours to end', async () => {
    const app = makeApp({ readOnly: true })
    const response = await app.inject({ method: 'POST', url: '/api/rotate', headers: authorised(app) })

    expect(response.statusCode).toBe(409)
    expect((response.json() as { error: string }).error).toContain('replaying a session record')

    // Nothing happened: same session, same lock, no close line.
    expect(recorder.sessionId).toBe(FIRST)
    expect(await readSessionLock(sessionDir, FIRST)).not.toBeNull()
    expect((await readSessionEvents(sessionFilePath(sessionDir, FIRST))).map((e) => e.type)).toEqual([
      'session.started',
    ])
  })
})

/** Emits a `collector.error`-shaped "discovery" event ONLY on a snapshot miss — the same "discover once, then go quiet" shape every real discovery collector uses. */
const discoveryCollector: AnyCollector = {
  name: 'discovery',
  initialSnapshot: () => ({ seen: false }),
  poll: (prev: { seen: boolean }, ctx: CollectorContext) => {
    if (prev.seen) return { nextSnapshot: prev, events: [] }
    return {
      nextSnapshot: { seen: true },
      events: [ctx.emit('collector.error', { collector: 'discovery', message: 'discovered the-one-worktree' })],
    }
  },
}

const nullExec = async () => ({ stdout: '', stderr: '', code: 0, failed: false })

/**
 * gaps (a) and (b) from the retarget spike: `POST /api/rotate` used to hold no
 * reference to the poll loop at all, so a rotated session opened with every
 * collector's snapshot still warm (no discovery events for anything that
 * already existed) and any snapshot the poll loop later persisted kept
 * landing in the CLOSED session's directory. `ctx.pollLoop` (#387/#388) is
 * what lets this route reach in and fix both.
 */
describe("POST /api/rotate resets the poll loop's warm snapshots (prd20 retarget spike, gaps a+b)", () => {
  let repoPath: string
  let sessionDir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rotate-poll-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rotate-poll-dir-'))
    recorder = new SessionRecorder(FIRST, sessionFilePath(sessionDir, FIRST))
    await recorder.record(
      createEvent(
        'session.started',
        { sessionId: FIRST, repoPath, repoName: 'repo' },
        { id: 'evt-000001', ts: Number(FIRST) },
      ),
    )
    await writeSessionLock(sessionDir, FIRST, process.pid, Number(FIRST))
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  it('gap (a): the rotated log gets a fresh discovery event on the next tick — a warm snapshot would have stayed silent', async () => {
    const pollLoop = createPollLoop({ repoPath, collectors: [discoveryCollector], recorder, exec: nullExec })
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => ROTATE_AT, pollLoop })

    await pollLoop.tick() // discovers once, in the OLD session
    // Tokened because #234's gate landed on this branch after these tests were
    // written; the gate itself is pinned by its own describe above, and what
    // this test is about is the reset, which never happens on a 401.
    await app.inject({
      method: 'POST',
      url: '/api/rotate',
      headers: { [CAPABILITY_TOKEN_HEADER]: app.capabilityToken },
    })
    await pollLoop.tick() // the NEW session's first tick

    const newSessionEvents = await readSessionEvents(sessionFilePath(sessionDir, String(ROTATE_AT)))
    const discoveries = newSessionEvents.filter(
      (e) => e.type === 'collector.error' && 'message' in e.payload && e.payload.message === 'discovered the-one-worktree',
    )
    // Without the reset, this collector's snapshot already has `seen: true`
    // carried over from the closed session, and the new log would show none.
    expect(discoveries).toHaveLength(1)
  })

  it('gap (b): the next persisted snapshot lands in the NEW session\'s own directory, never the closed one\'s', async () => {
    const pollLoop = createPollLoop({ repoPath, collectors: [discoveryCollector], recorder, exec: nullExec })
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => ROTATE_AT, pollLoop })

    // No snapshotStore configured at boot in this test (mirrors a plain
    // `createPollLoop` call with none) — the reset itself is what supplies one.
    await pollLoop.tick()
    await app.inject({
      method: 'POST',
      url: '/api/rotate',
      headers: { [CAPABILITY_TOKEN_HEADER]: app.capabilityToken },
    })
    await pollLoop.tick()

    const newSnapshotDir = snapshotDirFor(sessionDir, String(ROTATE_AT))
    const oldSnapshotDir = snapshotDirFor(sessionDir, FIRST)
    expect(await readdir(newSnapshotDir)).toEqual([expect.stringContaining('discovery')])
    await expect(readdir(oldSnapshotDir)).rejects.toThrow()
  })

  it('leaves the poll loop untouched when this server has none (e.g. a replay) — `ctx.pollLoop` is optional', async () => {
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => ROTATE_AT })
    const response = await app.inject({
      method: 'POST',
      url: '/api/rotate',
      headers: { [CAPABILITY_TOKEN_HEADER]: app.capabilityToken },
    })
    expect(response.statusCode).toBe(200)
  })
})
