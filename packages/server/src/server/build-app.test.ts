import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_CAPABILITIES } from '../collectors/git/index.js'
import { JUDGE_CAPABILITIES } from '../collectors/judge/index.js'
import { PI_CAPABILITIES } from '../collectors/pi/index.js'
import { SESSIONLOG_CAPABILITIES } from '../collectors/sessionlog/index.js'
import { TMUX_CAPABILITIES } from '../collectors/tmux/index.js'
import { WORKMUX_CAPABILITIES } from '../collectors/workmux/index.js'
import { readSessionEvents, RESUME_WINDOW_MS, sessionFilePath } from '../log/session-log.js'
import { capabilityHeaders } from '../api/test-support.js'
import { buildApp } from './build-app.js'
import { SessionRecorder } from './recorder.js'

describe('buildApp integration', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-app-test-'))
    recorder = new SessionRecorder('1000', sessionFilePath(dir, '1000'))
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
    })
  }

  it('GET /api/meta reports repo and session info', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      repoPath: '/repo',
      repoName: 'repo',
      sessionId: '1000',
      startedAt: 1000,
      // Additive boot facts (#180) — no boot recorded meta for this bare recorder, so this is
      // the honest fallback: never resumed, nothing recorded, the stock window.
      resumedCount: 0,
      eventCount: 0,
      resumeWindowMs: RESUME_WINDOW_MS,
      lastBootReason: 'first-run',
      // Additive prd15 ladder facts (wave 2a) — no `collector.disabled` has
      // ever been folded for this bare recorder, so every collector reads as
      // its own declared capabilities (never having polled is not the same
      // as being disabled); workmux's declared `attention: provided` is what
      // puts a from-scratch boot at L4 until a real poll says otherwise.
      capabilities: {
        git: GIT_CAPABILITIES,
        sessionlog: SESSIONLOG_CAPABILITIES,
        tmux: TMUX_CAPABILITIES,
        workmux: WORKMUX_CAPABILITIES,
        judge: JUDGE_CAPABILITIES,
        pi: PI_CAPABILITIES,
      },
      rung: 'L4',
      // Additive connection facts (prd19 wave 2, #255) — a bare recorder has
      // folded nothing, so every source reads no-flow (nulls and a zero, never
      // a stand-in for "fine") and there is no refusal to summarise. Kept
      // exhaustive on purpose: this assertion is what catches an additive
      // /api/meta field that forgot to tell anyone.
      connection: {
        git: { source: 'git', firstEventTs: null, lastEventTs: null, count: 0 },
        tmux: { source: 'tmux', firstEventTs: null, lastEventTs: null, count: 0 },
        workmux: { source: 'workmux', firstEventTs: null, lastEventTs: null, count: 0 },
        sessionlog: { source: 'sessionlog', firstEventTs: null, lastEventTs: null, count: 0 },
        otel: { source: 'otel', firstEventTs: null, lastEventTs: null, count: 0 },
        uninstrumentedSessions: [],
        refusals: { count: 0, instance: null, expectedInstance: null },
      },
    })
  })

  it('GET /api/sessions lists sessions written to disk, and /events reads the live one from the recorder', async () => {
    const started = createEvent('session.started', {
      sessionId: '1000',
      repoPath: '/repo',
      repoName: 'repo',
    }, { id: 'evt-1', ts: 1000 })
    await recorder.record(started)

    const app = makeApp()

    const sessionsResponse = await app.inject({ method: 'GET', url: '/api/sessions', headers: capabilityHeaders(app) })
    expect(sessionsResponse.statusCode).toBe(200)
    // #156: GET /api/sessions now also carries a derived title/label and
    // lane/landing/spend counts (see packages/server/src/log/listing.ts) —
    // asserted in full over there; this integration test only needs to know
    // the wiring reaches this route at all.
    expect(sessionsResponse.json()).toEqual({
      sessions: [
        expect.objectContaining({ id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: expect.any(Number) }),
      ],
    })

    const eventsResponse = await app.inject({ method: 'GET', url: '/api/sessions/1000/events', headers: capabilityHeaders(app) })
    expect(eventsResponse.statusCode).toBe(200)
    expect(eventsResponse.json()).toEqual({ events: [started] })

    // and it really did land on disk, not just in memory
    expect(await readSessionEvents(sessionFilePath(dir, '1000'))).toEqual([started])
  })

  it('GET /api/sessions/:id/events 404s for an unknown session', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/api/sessions/does-not-exist/events', headers: capabilityHeaders(app) })
    expect(response.statusCode).toBe(404)
  })

  it('GET /api/stream replays the session so far, then live-tails new injected events (SSE happy path)', async () => {
    const backlogEvent = createEvent('session.started', {
      sessionId: '1000',
      repoPath: '/repo',
      repoName: 'repo',
    }, { id: 'evt-1', ts: 1000 })
    await recorder.record(backlogEvent)

    const app = makeApp()
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/api/stream', payloadAsStream: true })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')

    const stream = response.stream()
    const chunks: string[] = []
    const gotBacklog = new Promise<void>((resolve) => {
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk.toString('utf8'))
        if (chunks.join('').includes('evt-1')) resolve()
      })
    })
    await gotBacklog

    expect(chunks.join('')).toContain('event: session.started')
    expect(chunks.join('')).toContain('"id":"evt-1"')

    // now a live event lands after the client connected
    const liveEvent = createEvent('collector.error', { collector: 'git', message: 'boom' }, {
      id: 'evt-2',
      ts: 2000,
    })

    const gotLive = new Promise<void>((resolve) => {
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk.toString('utf8'))
        if (chunks.join('').includes('evt-2')) resolve()
      })
    })
    await recorder.record(liveEvent)
    await gotLive

    expect(chunks.join('')).toContain('event: collector.error')
    expect(chunks.join('')).toContain('"id":"evt-2"')

    stream.destroy()
    await app.close()
  })

  it('refuses a rebound Host on the real routes — the guard suite proves the hook law, this proves buildApp wires it (#235)', async () => {
    const app = makeApp()

    const meta = await app.inject({ method: 'GET', url: '/api/meta', headers: { host: 'evil.example' } })
    expect(meta.statusCode).toBe(400)

    const stream = await app.inject({ method: 'GET', url: '/api/stream', headers: { host: 'evil.example' } })
    expect(stream.statusCode).toBe(400)

    const transcript = await app.inject({ method: 'GET', url: '/api/transcript/lane-1', headers: { host: 'evil.example' } })
    expect(transcript.statusCode).toBe(400)

    await app.close()
  })

  it('warns loudly and serves a placeholder HTML page instead of a bare 404 when no web build is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('npm run build --workspace packages/web')
    expect(response.body).not.toContain('Route GET:/ not found')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('npm run build --workspace packages/web')

    warn.mockRestore()
    await app.close()
  })

  it('warns loudly and serves the placeholder when webDistDir is configured but does not exist on disk', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missingDistDir = path.join(dir, 'no-such-dist')

    const app = buildApp({
      repoPath: '/repo',
      repoName: 'repo',
      sessionDir: dir,
      recorder,
      webDistDir: missingDistDir,
    })
    const response = await app.inject({ method: 'GET', url: '/dashboard' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('npm run build --workspace packages/web')
    expect(response.body).toContain(missingDistDir)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain(missingDistDir)

    warn.mockRestore()
    await app.close()
  })
})

/**
 * RE-POINTABILITY (prd20 ruling 5, retarget spike Q1/gap e). `buildApp` used
 * to spread its context into a copy (`{ ...ctx, capabilityToken }`), so any
 * "just mutate the context after boot" approach failed silently — the routes
 * kept reading the object as it looked at registration. This is the test
 * that would have caught that: it mutates the SAME object handed to
 * `buildApp`, after the app is already built and serving, and shows the next
 * request sees it.
 */
describe('buildApp: the context is never copied, so a later mutation is visible to every route', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-app-repoint-test-'))
    recorder = new SessionRecorder('1000', sessionFilePath(dir, '1000'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('mutating repoPath/repoName/sessionDir on the context object updates what /api/meta reports, with no app rebuild', async () => {
    const ctx = { repoPath: '/repo/old', repoName: 'old', sessionDir: dir, recorder }
    const app = buildApp(ctx)

    const before = await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })
    expect(before.json()).toMatchObject({ repoPath: '/repo/old', repoName: 'old' })

    // The retarget mutation itself — no re-registration, no new buildApp call.
    ctx.repoPath = '/repo/new'
    ctx.repoName = 'new'

    const after = await app.inject({ method: 'GET', url: '/api/meta', headers: capabilityHeaders(app) })
    expect(after.json()).toMatchObject({ repoPath: '/repo/new', repoName: 'new' })
  })

  it('mutating sessionDir on the context object re-points /api/sessions at the new directory, with no app rebuild', async () => {
    const oldSessionDir = dir
    const newSessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-app-repoint-new-'))
    try {
      await recorder.record(
        createEvent('session.started', { sessionId: '1000', repoPath: '/repo/old', repoName: 'old' }, {
          id: 'evt-1',
          ts: 1000,
        }),
      )
      const ctx = { repoPath: '/repo/old', repoName: 'old', sessionDir: oldSessionDir, recorder }
      const app = buildApp(ctx)

      const before = (await app.inject({ method: 'GET', url: '/api/sessions', headers: capabilityHeaders(app) })).json() as {
        sessions: unknown[]
      }
      expect(before.sessions).toHaveLength(1)

      // The retarget mutation: a new repo's session dir, with nothing recorded in it yet.
      ctx.sessionDir = newSessionDir

      const after = (await app.inject({ method: 'GET', url: '/api/sessions', headers: capabilityHeaders(app) })).json() as {
        sessions: unknown[]
      }
      expect(after.sessions).toHaveLength(0)
    } finally {
      await rm(newSessionDir, { recursive: true, force: true })
    }
  })
})
