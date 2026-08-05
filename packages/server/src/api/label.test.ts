import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSessionLabel } from '../log/label.js'
import { sessionFileName } from '../log/paths.js'
import { readSessionEvents, sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'

/**
 * `POST /api/label` — the recordings library's rename-in-place, end to end
 * through the app the library's rename control talks to. What is asserted
 * here is the wiring an operator experiences: a rename writes only the
 * sidecar (never `session-<id>.jsonl`), `GET /api/sessions` reflects it
 * immediately, and a record being replayed refuses rather than pretending to
 * save.
 */
describe('POST /api/label', () => {
  let repoPath: string
  let sessionDir: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-label-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-label-dir-'))
    await mkdir(sessionDir, { recursive: true })
    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted({ sessionId: '1000', repoPath, repoName: 'repo' })
    await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  function makeApp(overrides: { readOnly?: boolean } = {}) {
    const recorder = new SessionRecorder('2000', sessionFilePath(sessionDir, '2000'))
    return buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => 9999, ...overrides })
  }

  it('writes the label sidecar and answers with what was saved', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/label',
      payload: { sessionId: '1000', label: '  the morning run  ' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ sessionId: '1000', label: 'the morning run' })
    expect(await readSessionLabel(sessionDir, '1000')).toBe('the morning run')
  })

  it('never touches the event log itself — the append-only law', async () => {
    const before = await readSessionEvents(sessionFilePath(sessionDir, '1000'))
    const app = makeApp()

    await app.inject({ method: 'POST', url: '/api/label', payload: { sessionId: '1000', label: 'renamed' } })

    const after = await readSessionEvents(sessionFilePath(sessionDir, '1000'))
    expect(after).toEqual(before)
  })

  it('shows up in the listing immediately, winning over the auto-title', async () => {
    const app = makeApp()
    await app.inject({ method: 'POST', url: '/api/label', payload: { sessionId: '1000', label: 'the morning run' } })

    const listing = (await app.inject({ method: 'GET', url: '/api/sessions' })).json() as {
      sessions: Array<Record<string, unknown>>
    }
    expect(listing.sessions[0]).toMatchObject({ id: '1000', label: 'the morning run', title: 'the morning run' })
  })

  it('404s a session id that is neither live nor on disk', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/label',
      payload: { sessionId: 'nowhere', label: 'x' },
    })
    expect(response.statusCode).toBe(404)
    expect((response.json() as { error: string }).error).toContain('no session with id "nowhere"')
  })

  it('refuses an empty label rather than writing a no-op sidecar', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/label',
      payload: { sessionId: '1000', label: '   ' },
    })
    expect(response.statusCode).toBe(400)
    expect(await readSessionLabel(sessionDir, '1000')).toBeNull()
  })

  it('refuses a missing sessionId', async () => {
    const app = makeApp()
    const response = await app.inject({ method: 'POST', url: '/api/label', payload: { label: 'x' } })
    expect(response.statusCode).toBe(400)
  })

  it('never labels on a GET', async () => {
    const app = makeApp()
    await app.inject({ method: 'GET', url: '/api/label' })
    expect(await readSessionLabel(sessionDir, '1000')).toBeNull()
  })

  it('refuses to label a replayed record — nowhere durable to save it', async () => {
    const app = makeApp({ readOnly: true })
    const response = await app.inject({
      method: 'POST',
      url: '/api/label',
      payload: { sessionId: '1000', label: 'x' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.json() as { error: string }).error).toContain('replaying a session record')
    expect(await readSessionLabel(sessionDir, '1000')).toBeNull()
  })
})
