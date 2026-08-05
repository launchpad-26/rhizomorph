import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RESUME_WINDOW_MS, sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { recordSessionBootMeta } from './meta.js'

describe('GET /api/meta', () => {
  let repoPath: string
  let sessionDir: string

  const setup = async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-meta-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-meta-dir-'))
  }

  const teardown = async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  }

  it('carries startedAt (existing) plus the additive boot facts recorded for this recorder', async () => {
    await setup()
    try {
      const recorder = new SessionRecorder('1785739192605', sessionFilePath(sessionDir, '1785739192605'))
      recordSessionBootMeta(recorder, {
        resumedCount: 7,
        eventCount: 55_049,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'resumed',
      })

      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })
      const response = await app.inject({ method: 'GET', url: '/api/meta' })

      expect(response.statusCode).toBe(200)
      const body = response.json() as Record<string, unknown>
      expect(body).toMatchObject({
        repoPath,
        repoName: 'repo',
        sessionId: '1785739192605',
        startedAt: 1785739192605,
        resumedCount: 7,
        eventCount: 55_049,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'resumed',
      })
    } finally {
      await teardown()
    }
  })

  it('carries "writer-alive" — the agnosticism spike\'s liveness-guard reason — the same as any other lastBootReason', async () => {
    await setup()
    try {
      const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
      recordSessionBootMeta(recorder, {
        resumedCount: 0,
        eventCount: 0,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'writer-alive',
      })

      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })
      const body = (await (await app.inject({ method: 'GET', url: '/api/meta' })).json()) as Record<string, unknown>

      expect(body).toMatchObject({ lastBootReason: 'writer-alive' })
    } finally {
      await teardown()
    }
  })

  it("law: meta's boot fields agree with the exact recorder instance's recorded state, not a global default", async () => {
    await setup()
    try {
      const resumedRecorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
      recordSessionBootMeta(resumedRecorder, {
        resumedCount: 3,
        eventCount: 42,
        resumeWindowMs: 60_000,
        lastBootReason: 'resumed',
      })
      const freshRecorder = new SessionRecorder('2000', sessionFilePath(sessionDir, '2000'))
      recordSessionBootMeta(freshRecorder, {
        resumedCount: 0,
        eventCount: 0,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'first-run',
      })

      const resumedApp = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder: resumedRecorder })
      const freshApp = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder: freshRecorder })

      const resumedBody = (await (await resumedApp.inject({ method: 'GET', url: '/api/meta' })).json()) as Record<
        string,
        unknown
      >
      const freshBody = (await (await freshApp.inject({ method: 'GET', url: '/api/meta' })).json()) as Record<
        string,
        unknown
      >

      expect(resumedBody).toMatchObject({ sessionId: '1000', resumedCount: 3, eventCount: 42, resumeWindowMs: 60_000 })
      expect(freshBody).toMatchObject({ sessionId: '2000', resumedCount: 0, eventCount: 0, lastBootReason: 'first-run' })
    } finally {
      await teardown()
    }
  })

  it('falls back to an honest default (never resumed, the stock window) for a recorder no boot ever recorded meta for', async () => {
    await setup()
    try {
      const recorder = new SessionRecorder('3000', sessionFilePath(sessionDir, '3000'))
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

      const response = await app.inject({ method: 'GET', url: '/api/meta' })

      expect(response.statusCode).toBe(200)
      const body = response.json() as Record<string, unknown>
      expect(body).toMatchObject({
        sessionId: '3000',
        resumedCount: 0,
        resumeWindowMs: RESUME_WINDOW_MS,
        lastBootReason: 'first-run',
      })
    } finally {
      await teardown()
    }
  })

  it('the fallback eventCount matches the recorder\'s own buffer, not a fabricated zero', async () => {
    await setup()
    try {
      const recorder = new SessionRecorder('4000', sessionFilePath(sessionDir, '4000'))
      const { createEvent } = await import('@rhizomorph/core')
      await recorder.record(
        createEvent('session.started', { sessionId: '4000', repoPath, repoName: 'repo' }, { id: 'evt-1', ts: 4000 }),
      )
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

      const response = await app.inject({ method: 'GET', url: '/api/meta' })
      const body = response.json() as Record<string, unknown>
      expect(body.eventCount).toBe(1)
    } finally {
      await teardown()
    }
  })
})
