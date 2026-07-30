import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent } from '@observatory/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSessionEvents, sessionFilePath } from '../log/session-log.js'
import { buildApp } from './build-app.js'
import { SessionRecorder } from './recorder.js'

describe('buildApp integration', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'observatory-app-test-'))
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
    const response = await app.inject({ method: 'GET', url: '/api/meta' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      repoPath: '/repo',
      repoName: 'repo',
      sessionId: '1000',
      startedAt: 1000,
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

    const sessionsResponse = await app.inject({ method: 'GET', url: '/api/sessions' })
    expect(sessionsResponse.statusCode).toBe(200)
    expect(sessionsResponse.json()).toEqual({
      sessions: [{ id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: expect.any(Number) }],
    })

    const eventsResponse = await app.inject({ method: 'GET', url: '/api/sessions/1000/events' })
    expect(eventsResponse.statusCode).toBe(200)
    expect(eventsResponse.json()).toEqual({ events: [started] })

    // and it really did land on disk, not just in memory
    expect(await readSessionEvents(sessionFilePath(dir, '1000'))).toEqual([started])
  })

  it('GET /api/sessions/:id/events 404s for an unknown session', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'GET', url: '/api/sessions/does-not-exist/events' })
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
})
