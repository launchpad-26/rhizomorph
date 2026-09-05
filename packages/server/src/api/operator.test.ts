import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { CAPABILITY_TOKEN_HEADER } from './security.js'

/**
 * `POST /api/operator/:act` — one door, three acts (prd17 ruling 1, #276).
 * What is asserted here is the wiring an operator's act experiences: each of
 * `ack` / `verdict` / `note` is appended as its own event, carrying the
 * coordinate it was decided against exactly as the client posted it — never
 * defaulted, never dropped — and each is rejected on its own terms when its
 * own required field is missing, not merely when the fields every act shares
 * are missing.
 */
describe('POST /api/operator/:act', () => {
  let repoPath: string
  let sessionDir: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-operator-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-operator-dir-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  function makeApp(overrides: { readOnly?: boolean; capabilityToken?: string } = {}) {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    return { app: buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => 9999, ...overrides }), recorder }
  }

  /** The header a legitimate caller sends — the token `buildApp` minted for this exact app. */
  function authHeaders(app: FastifyInstance): Record<string, string> {
    return { [CAPABILITY_TOKEN_HEADER]: app.capabilityToken }
  }

  describe('ack', () => {
    it('appends operator.ack, carrying the coordinate exactly as posted', async () => {
      const { app, recorder } = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/api/operator/ack',
        headers: authHeaders(app),
        payload: { sessionId: 'sess-a', offset: 42, subject: 'summons:feature:awaiting-reply' },
      })

      expect(response.statusCode).toBe(200)
      const events = recorder.eventsSoFar()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: 'operator.ack',
        source: 'operator',
        payload: { sessionId: 'sess-a', offset: 42, subject: 'summons:feature:awaiting-reply' },
      })
    })

    it('rejects a missing offset — the coordinate is required, not defaulted', async () => {
      const { app, recorder } = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/api/operator/ack',
        headers: authHeaders(app),
        payload: { sessionId: 'sess-a', subject: 'summons:feature:awaiting-reply' },
      })

      expect(response.statusCode).toBe(400)
      expect(recorder.eventsSoFar()).toHaveLength(0)
    })
  })

  describe('verdict', () => {
    it('appends operator.verdict, carrying the verdict text', async () => {
      const { app, recorder } = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/api/operator/verdict',
        headers: authHeaders(app),
        payload: { sessionId: 'sess-a', offset: 13, subject: '219', verdict: 'approved' },
      })

      expect(response.statusCode).toBe(200)
      expect(recorder.eventsSoFar()[0]).toMatchObject({
        type: 'operator.verdict',
        payload: { sessionId: 'sess-a', offset: 13, subject: '219', verdict: 'approved' },
      })
    })

    it('rejects a verdict payload with no verdict string — the field an ack payload does not carry', async () => {
      const { app, recorder } = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/api/operator/verdict',
        headers: authHeaders(app),
        payload: { sessionId: 'sess-a', offset: 13, subject: '219' },
      })

      expect(response.statusCode).toBe(400)
      expect(recorder.eventsSoFar()).toHaveLength(0)
    })
  })

  describe('note', () => {
    it('appends operator.note, carrying the note text', async () => {
      const { app, recorder } = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/api/operator/note',
        headers: authHeaders(app),
        payload: { sessionId: 'sess-a', offset: 14, subject: '219', text: 'Looks correct; landing.' },
      })

      expect(response.statusCode).toBe(200)
      expect(recorder.eventsSoFar()[0]).toMatchObject({
        type: 'operator.note',
        payload: { sessionId: 'sess-a', offset: 14, subject: '219', text: 'Looks correct; landing.' },
      })
    })

    it('rejects an empty note — the sibling case, checked on its own terms', async () => {
      const { app, recorder } = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/api/operator/note',
        headers: authHeaders(app),
        payload: { sessionId: 'sess-a', offset: 14, subject: '219', text: '' },
      })

      expect(response.statusCode).toBe(400)
      expect(recorder.eventsSoFar()).toHaveLength(0)
    })
  })

  /**
   * THE MUTATION THIS ROUTE MUST SURVIVE (issue #276's own "what mutation
   * would this test survive?"): hard-coding `offset: 0` in the handler would
   * leave every payload-shape test above green, because none of them posts
   * `offset: 0`. This asserts the recorded offset moved WITH a non-zero post.
   */
  it('records the offset the client posted, not a fixed one — survives a hard-coded offset: 0', async () => {
    const { app, recorder } = makeApp()
    await app.inject({
      method: 'POST',
      url: '/api/operator/ack',
      headers: authHeaders(app),
      payload: { sessionId: 'sess-a', offset: 777, subject: 'x' },
    })

    const event = recorder.eventsSoFar()[0] as { payload: { offset: number } }
    expect(event.payload.offset).toBe(777)
  })

  it('accepts offset 0 — the first line of a record is a real place to have decided', async () => {
    const { app, recorder } = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/operator/ack',
      headers: authHeaders(app),
      payload: { sessionId: 'sess-a', offset: 0, subject: 'x' },
    })

    expect(response.statusCode).toBe(200)
    expect((recorder.eventsSoFar()[0] as { payload: { offset: number } }).payload.offset).toBe(0)
  })

  it('404s an act this door does not know — no fourth act, no silent fallthrough', async () => {
    const { app, recorder } = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/operator/approve',
      headers: authHeaders(app),
      payload: { sessionId: 'sess-a', offset: 0, subject: 'x' },
    })

    expect(response.statusCode).toBe(404)
    expect(recorder.eventsSoFar()).toHaveLength(0)
  })

  it('refuses on a replayed record — no live recording to append an operator act to', async () => {
    const { app, recorder } = makeApp({ readOnly: true })
    const response = await app.inject({
      method: 'POST',
      url: '/api/operator/ack',
      headers: authHeaders(app),
      payload: { sessionId: 'sess-a', offset: 0, subject: 'x' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.json() as { error: string }).error).toContain('replaying a session record')
    expect(recorder.eventsSoFar()).toHaveLength(0)
  })

  describe('the 2026-08-06 audit: capability token', () => {
    it('refuses a request with no token at all — 401, before an act is even parsed', async () => {
      const { app, recorder } = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/api/operator/ack',
        payload: { sessionId: 'sess-a', offset: 0, subject: 'x' },
      })

      expect(response.statusCode).toBe(401)
      expect(recorder.eventsSoFar()).toHaveLength(0)
    })

    it('refuses a request bearing the wrong token', async () => {
      const { app, recorder } = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/api/operator/ack',
        headers: { [CAPABILITY_TOKEN_HEADER]: 'not-the-real-token' },
        payload: { sessionId: 'sess-a', offset: 0, subject: 'x' },
      })

      expect(response.statusCode).toBe(401)
      expect(recorder.eventsSoFar()).toHaveLength(0)
    })
  })
})
