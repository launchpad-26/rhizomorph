import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFileName } from '../log/paths.js'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import type { LaneIndexEntryResponse } from './lane-index.js'
import { capabilityHeaders } from './test-support.js'

/**
 * The lane index's two reads (prd-31 ruling 5 · #556), gated (prd-29 ruling 7
 * / #58). The route's own job is small — the assembly is `log/lane-index.ts`'s
 * and tested there — so these assert the three things only the route can be
 * wrong about: that it answers at all with the token, that a lane resolves by
 * every name it has, and that an unknown handle is a 404 which says **what was
 * searched** rather than a bare "not found". The token gate itself (401
 * without it, no 401 with it) is covered once for all fourteen gated reads by
 * `gated-reads.test.ts`, not repeated per route here.
 */

const LANE = '556-run-view'
const WORKTREE = '/repo-wt/556-run-view'

function laneEvents(sessionId: string, opts: { removed?: boolean } = {}): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: Number(sessionId), stepMs: 10, idPrefix: `s${sessionId}` })
  const events = [
    f.sessionStarted({ sessionId, repoPath: '/repo', repoName: 'repo', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
    f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-1', isMain: false }),
    f.llmUsage({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: `claude-${sessionId}`,
      model: 'test-model-unpriced',
      tokens: { input: 1, output: 900, cacheRead: 3, cacheCreation: 1 },
    }),
  ]
  return opts.removed === true ? [...events, f.worktreeRemoved({ path: WORKTREE })] : events
}

describe('GET /api/lane-index', () => {
  let sessionDir: string

  beforeEach(async () => {
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lane-index-'))
  })
  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true })
  })

  async function appWith(sessions: Record<string, RhizomorphEvent[]>) {
    for (const [id, events] of Object.entries(sessions)) {
      await writeFile(path.join(sessionDir, sessionFileName(Number(id))), eventsToJsonl(events), 'utf8')
    }
    const recorder = new SessionRecorder('9000', sessionFilePath(sessionDir, '9000'))
    return buildApp({ repoPath: '/repo', repoName: 'repo', sessionDir, recorder })
  }

  it('lists every lane every recording names', async () => {
    const app = await appWith({ '1000': laneEvents('1000'), '2000': laneEvents('2000', { removed: true }) })

    const response = await app.inject({ method: 'GET', url: '/api/lane-index', headers: capabilityHeaders(app) })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { lanes: { handle: string; sessions: unknown[] }[] }
    expect(body.lanes.map((lane) => lane.handle)).toEqual([LANE])
    expect(body.lanes[0]?.sessions).toHaveLength(2)
  })

  it('answers one lane by handle, with the recordings it spans', async () => {
    const app = await appWith({ '1000': laneEvents('1000'), '2000': laneEvents('2000', { removed: true }) })

    const response = await app.inject({
      method: 'GET',
      url: `/api/lane-index/${LANE}`,
      headers: capabilityHeaders(app),
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as LaneIndexEntryResponse
    expect(body.lane.handle).toBe(LANE)
    expect(body.lane.sessions.map((slice) => slice.sessionId)).toEqual(['1000', '2000'])
    expect(body.lane.worktreeRemoved).toBe(true)
    expect(body.unreadableSessionIds).toEqual([])
  })

  it('answers the same lane by its issue number', async () => {
    const app = await appWith({ '1000': laneEvents('1000') })

    const response = await app.inject({
      method: 'GET',
      url: '/api/lane-index/556',
      headers: capabilityHeaders(app),
    })
    expect(response.statusCode).toBe(200)
    expect((response.json() as LaneIndexEntryResponse).lane.handle).toBe(LANE)
  })

  it('404s an unknown handle with WHAT WAS SEARCHED, never a bare not-found', async () => {
    const app = await appWith({ '1000': laneEvents('1000') })

    const response = await app.inject({
      method: 'GET',
      url: '/api/lane-index/never-existed',
      headers: capabilityHeaders(app),
    })
    expect(response.statusCode).toBe(404)
    const { error } = response.json() as { error: string }
    expect(error).toContain('never-existed')
    expect(error).toContain('handle, branch, worktree name and issue number')
    // The size of the haystack is part of the answer: "searched 1 lane" and
    // "searched 200" send a reader in different directions.
    expect(error).toContain('1 lane')
  })

  it('is calm on a session directory with nothing in it', async () => {
    const app = await appWith({})

    const list = await app.inject({ method: 'GET', url: '/api/lane-index', headers: capabilityHeaders(app) })
    expect(list.json()).toEqual({ lanes: [], unreadableSessionIds: [] })

    const one = await app.inject({
      method: 'GET',
      url: `/api/lane-index/${LANE}`,
      headers: capabilityHeaders(app),
    })
    expect(one.statusCode).toBe(404)
    expect((one.json() as { error: string }).error).toContain('no lanes at all')
  })

  it('has no verb but GET — the read-only constitution, stated in routing', async () => {
    const app = await appWith({ '1000': laneEvents('1000') })
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const response = await app.inject({ method, url: `/api/lane-index/${LANE}`, headers: capabilityHeaders(app) })
      expect(response.statusCode).toBe(404)
    }
  })
})
