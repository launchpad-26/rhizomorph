import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFileName } from '../log/paths.js'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'

describe('GET /api/sessions and /api/sessions/:id/events', () => {
  let repoPath: string
  let sessionDir: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-sessions-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-sessions-dir-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  it('lists past sessions recorded to disk, oldest first', async () => {
    await mkdir(sessionDir, { recursive: true })
    const f1000 = createEventFactory({ startTs: 1000 })
    f1000.sessionStarted({ sessionId: '1000', repoPath, repoName: 'repo' })
    await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(f1000.all()), 'utf8')

    const f2000 = createEventFactory({ startTs: 2000 })
    f2000.sessionStarted({ sessionId: '2000', repoPath, repoName: 'repo' })
    await writeFile(path.join(sessionDir, sessionFileName(2000)), eventsToJsonl(f2000.all()), 'utf8')

    const recorder = new SessionRecorder('3000', sessionFilePath(sessionDir, '3000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({ method: 'GET', url: '/api/sessions' })
    expect(response.statusCode).toBe(200)
    const { sessions } = response.json() as { sessions: Array<{ id: string }> }
    expect(sessions.map((s) => s.id)).toEqual(['1000', '2000'])
  })

  it('serves the live session straight from the recorder buffer, never touching disk', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const f = createEventFactory({ startTs: 1000 })
    await recorder.record(f.sessionStarted({ sessionId: '1000', repoPath, repoName: 'repo' }))
    await recorder.record(f.agentStatus({ handle: 'a', status: 'working' }))

    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })
    const response = await app.inject({ method: 'GET', url: '/api/sessions/1000/events' })

    expect(response.statusCode).toBe(200)
    const { events } = response.json() as { events: Array<{ type: string }> }
    expect(events.map((e) => e.type)).toEqual(['session.started', 'agent.status'])
  })

  it('reads a past (non-live) session\'s events off disk', async () => {
    await mkdir(sessionDir, { recursive: true })
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted({ sessionId: '1000', repoPath, repoName: 'repo' })
    f.agentStatus({ handle: 'a', status: 'working' })
    await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')

    const recorder = new SessionRecorder('2000', sessionFilePath(sessionDir, '2000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({ method: 'GET', url: '/api/sessions/1000/events' })
    expect(response.statusCode).toBe(200)
    const { events } = response.json() as { events: Array<{ type: string }> }
    expect(events.map((e) => e.type)).toEqual(['session.started', 'agent.status'])
  })

  it('404s a session id that is neither live nor on disk', async () => {
    const recorder = new SessionRecorder('2000', sessionFilePath(sessionDir, '2000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({ method: 'GET', url: '/api/sessions/9999/events' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'no session with id "9999"' })
  })
})
