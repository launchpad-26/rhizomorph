import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { SessionRecorder } from '../server/recorder.js'
import { readLabFootprint, readLabTelemetry, registerLabSeriesRoute } from './lab-series.js'
import { capabilityHeaders, TEST_CAPABILITY_TOKEN } from './test-support.js'

/**
 * The frame's two closed gaps (prd-55 ruling 6, #402), exercised against a
 * fixture session file and a fixture record — the same shape
 * `lab-transcript.test.ts` (wave 3) uses for its sibling route.
 */

const LANE = 'feature'
const CHECKPOINT_ID = 'ckpt-1'
const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:00:10.000Z'
const T2 = '2026-01-01T00:00:20.000Z'

function line(ts: string, text: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
}

describe('GET /api/lab/telemetry — the fold\'s own OTel readings, sliced by byte (prd-55 ruling 6, #402)', () => {
  let dir: string
  let sessionFile: string
  let byteAtLine: number[]
  let sessionSize: number

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-series-'))
    sessionFile = path.join(dir, 'session.jsonl')
    const lines = [line(T0, 'one'), line(T1, 'two'), line(T2, 'three')]
    let content = ''
    byteAtLine = [0]
    for (const l of lines) {
      content += `${l}\n`
      byteAtLine.push(Buffer.byteLength(content, 'utf8'))
    }
    await writeFile(sessionFile, content, 'utf8')
    sessionSize = Buffer.byteLength(content, 'utf8')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function record(): ReturnType<typeof createEventFactory> {
    const f = createEventFactory({ startTs: 1000 })
    f.forkCheckpoint({ lane: LANE, checkpointId: CHECKPOINT_ID, sessionFile, sessionCutByte: 0, sessionDigest: 'f'.repeat(64) })
    return f
  }

  function makeApp(events: RhizomorphEvent[]) {
    const app = Fastify()
    const recorder = new SessionRecorder('1000', sessionFilePath(dir, '1000'), { resumeFrom: events })
    registerLabSeriesRoute(app, { repoPath: '/repo', repoName: 'repo', sessionDir: dir, recorder, capabilityToken: TEST_CAPABILITY_TOKEN })
    return app
  }

  it("slices the lane's OTel readings up to the wall time the byte cut reached — never past it, never another lane, never sessionlog-origin", async () => {
    const f = record()
    f.llmCost({ lane: LANE, costUsd: 1 }, { ts: Date.parse(T0) + 1 }) // before the cut — IN
    f.llmCost({ lane: LANE, costUsd: 3 }, { ts: Date.parse(T1) }) // exactly at the cut — IN (<=, not <)
    f.llmCost({ lane: LANE, costUsd: 2 }, { ts: Date.parse(T1) + 1 }) // one ms past the cut — OUT
    f.llmUsage({ lane: LANE, requestId: 'otel-1' }, { ts: Date.parse(T0) + 1, source: 'otel' }) // IN
    f.llmUsage({ lane: LANE, requestId: 'sessionlog-1' }, { ts: Date.parse(T0) + 1 }) // default source is sessionlog — NOT an OTel reading — OUT
    f.llmCost({ lane: 'someone-else', costUsd: 9 }, { ts: Date.parse(T0) + 1 }) // a different lane — OUT

    // The cut is after lines 1–2 (T0, T1): the last timestamped line in the
    // prefix is T1, so that is the wall-clock boundary — not line 3's T2.
    const result = await readLabTelemetry({ events: f.all(), lane: LANE, atByte: byteAtLine[2]! })

    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.asOf).toBe(Date.parse(T1))
    expect(result.costs.map((c) => c.costUsd).sort((a, b) => a - b)).toEqual([1, 3])
    expect(result.usage).toHaveLength(1)
    expect(result.usage[0]!.origin).toBe('otel')
    expect(result.usage[0]!.requestId).toBe('otel-1')
  })

  it('byte 0 is an honest empty slice — nothing could have been recorded yet, and that is not a refusal', async () => {
    const f = record()
    f.llmCost({ lane: LANE, costUsd: 1 }, { ts: Date.parse(T0) })

    const result = await readLabTelemetry({ events: f.all(), lane: LANE, atByte: 0 })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.asOf).toBeNull()
    expect(result.usage).toEqual([])
    expect(result.costs).toEqual([])
    expect(result.tools).toEqual([])
    expect(result.activeTime).toEqual([])
  })

  it('a byte past the session\'s real length is refused by name, never clamped and never an empty success', async () => {
    const f = record()
    const result = await readLabTelemetry({ events: f.all(), lane: LANE, atByte: sessionSize + 1_000 })
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toMatch(/^BYTE BEYOND SESSION LENGTH for "feature"/)
    expect(result.reason).toContain(String(sessionSize))
  })

  it('a lane the fold has never checkpointed is refused by name, not answered with an empty success', async () => {
    const result = await readLabTelemetry({ events: [], lane: 'nobody', atByte: 0 })
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toMatch(/^NO SUCH LANE "nobody"/)
  })

  describe('the route', () => {
    it('is a gated read — a bare request is refused before the handler runs', async () => {
      const app = makeApp(record().all())
      const response = await app.inject({ method: 'GET', url: `/api/lab/telemetry?lane=${LANE}&atByte=0` })
      expect(response.statusCode).toBe(401)
      await app.close()
    })

    it('400 without a lane, and 400 without a valid atByte', async () => {
      const app = makeApp(record().all())
      const noLane = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: '/api/lab/telemetry?atByte=0' })
      expect(noLane.statusCode).toBe(400)
      expect((noLane.json() as { error: string }).error).toContain('"lane"')

      const noByte = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: `/api/lab/telemetry?lane=${LANE}` })
      expect(noByte.statusCode).toBe(400)
      expect((noByte.json() as { error: string }).error).toContain('"atByte"')

      const negative = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: `/api/lab/telemetry?lane=${LANE}&atByte=-1` })
      expect(negative.statusCode).toBe(400)

      const notANumber = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: `/api/lab/telemetry?lane=${LANE}&atByte=abc` })
      expect(notANumber.statusCode).toBe(400)
      await app.close()
    })

    it('200 for the live slice, through the wire', async () => {
      const f = record()
      f.llmCost({ lane: LANE, costUsd: 1 }, { ts: Date.parse(T0) + 1 })
      const app = makeApp(f.all())
      const response = await app.inject({
        method: 'GET',
        headers: capabilityHeaders(TEST_CAPABILITY_TOKEN),
        url: `/api/lab/telemetry?lane=${LANE}&atByte=${byteAtLine[2]}`,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ available: true, lane: LANE })
      await app.close()
    })

    it('200, never 404, for a lane the fold has never checkpointed and for a byte past the session\'s length', async () => {
      const app = makeApp(record().all())

      const unknownLane = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: '/api/lab/telemetry?lane=nobody&atByte=0' })
      expect(unknownLane.statusCode).toBe(200)
      expect(unknownLane.json()).toMatchObject({ available: false })

      const pastLength = await app.inject({
        method: 'GET',
        headers: capabilityHeaders(TEST_CAPABILITY_TOKEN),
        url: `/api/lab/telemetry?lane=${LANE}&atByte=${sessionSize + 1_000}`,
      })
      expect(pastLength.statusCode).toBe(200)
      expect(pastLength.json()).toMatchObject({ available: false })
      await app.close()
    })
  })
})

describe('GET /api/lab/footprint — selectFilesTouchedByBranch ∩ selectCollisionMap, for a lane (prd-55 ruling 6, #402)', () => {
  const MAIN_PATH = '/repo-wt/main'
  const FEATURE_PATH = '/repo-wt/feature'
  const OTHER_PATH = '/repo-wt/other'
  const QUIET_PATH = '/repo-wt/quiet'

  function record(): ReturnType<typeof createEventFactory> {
    const f = createEventFactory({ startTs: 1000 })
    f.worktreeDiscovered({ path: MAIN_PATH, branch: 'main', head: 'sha-main', isMain: true })
    f.worktreeDiscovered({ path: FEATURE_PATH, branch: 'feature', head: 'sha-feature', isMain: false })
    f.worktreeDiscovered({ path: OTHER_PATH, branch: 'other', head: 'sha-other', isMain: false })
    f.worktreeDiscovered({ path: QUIET_PATH, branch: 'quiet', head: 'sha-quiet', isMain: false })
    // Both `feature` and `other` have their hands on shared.ts; only `feature`
    // touches its own file — the fixture shape a real intersection needs.
    f.worktreeDirty({
      path: FEATURE_PATH,
      branch: 'feature',
      files: [
        { path: 'src/shared.ts', status: 'modified' },
        { path: 'src/feature-only.ts', status: 'modified' },
      ],
    })
    f.worktreeDirty({ path: OTHER_PATH, branch: 'other', files: [{ path: 'src/shared.ts', status: 'modified' }] })
    return f
  }

  function makeApp(events: RhizomorphEvent[]) {
    const dir = tmpdir()
    const app = Fastify()
    const recorder = new SessionRecorder('1000', sessionFilePath(dir, '1000'), { resumeFrom: events })
    registerLabSeriesRoute(app, { repoPath: '/repo', repoName: 'repo', sessionDir: dir, recorder, capabilityToken: TEST_CAPABILITY_TOKEN })
    return app
  }

  it("returns the lane's touched files intersected with the collision map, each carrying who else has hands on it", () => {
    const result = readLabFootprint({ events: record().all(), lane: 'feature' })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.files).toEqual(['src/feature-only.ts', 'src/shared.ts'])
    expect(result.collisions['src/shared.ts']?.branchCount).toBe(2)
    expect(result.collisions['src/shared.ts']?.branches).toEqual(['feature', 'other'])
    expect(result.collisions['src/feature-only.ts']?.branchCount).toBe(1)
  })

  it('a known branch that has touched nothing yet answers an honest empty footprint, not a refusal', () => {
    const result = readLabFootprint({ events: record().all(), lane: 'quiet' })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.files).toEqual([])
    expect(result.collisions).toEqual({})
  })

  it('a lane the fold has never seen as a branch is refused by name, not answered with an empty success', () => {
    const result = readLabFootprint({ events: record().all(), lane: 'ghost' })
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toMatch(/^NO SUCH LANE "ghost"/)
  })

  describe('the route', () => {
    it('is a gated read — a bare request is refused before the handler runs', async () => {
      const app = makeApp(record().all())
      const response = await app.inject({ method: 'GET', url: '/api/lab/footprint?lane=feature' })
      expect(response.statusCode).toBe(401)
      await app.close()
    })

    it('400 without a lane', async () => {
      const app = makeApp(record().all())
      const response = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: '/api/lab/footprint' })
      expect(response.statusCode).toBe(400)
      expect((response.json() as { error: string }).error).toContain('"lane"')
      await app.close()
    })

    it('200 for a real footprint, through the wire', async () => {
      const app = makeApp(record().all())
      const response = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: '/api/lab/footprint?lane=feature' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ available: true, lane: 'feature', files: ['src/feature-only.ts', 'src/shared.ts'] })
      await app.close()
    })

    it('200, never 404, for a lane the fold has never seen as a branch', async () => {
      const app = makeApp(record().all())
      const response = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: '/api/lab/footprint?lane=ghost' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ available: false })
      await app.close()
    })
  })
})
