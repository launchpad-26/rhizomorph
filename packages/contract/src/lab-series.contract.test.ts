import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { readLabFootprint, readLabTelemetry } from '@rhizomorph/web/lab/frame'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/lab/telemetry` and `/api/lab/footprint`'s contract test (prd-55
 * ruling 6 / #402). The REAL served page, the REAL `capabilityRead`, the REAL
 * `readLabTelemetry`/`readLabFootprint` (`web/src/lab/frame/Frame.tsx`), the
 * REAL routes over a REAL record and a REAL session file — `h.fetch` routed
 * in as `globalThis.fetch`. One file proves both routes, live/empty/refused,
 * the same discipline `lab-transcript.contract.test.ts` (wave 3) set for its
 * sibling: `contract-coverage-law.test.ts` gives each route its own
 * `EXPECTED_READS` row, both naming this one file.
 *
 * The session file carries two lines, timestamped ten seconds apart, so a cut
 * after the first proves the byte-not-wall-clock slice: a reading recorded
 * exactly at the first line's timestamp is IN, one recorded after the second
 * line's is OUT, and a cut before either line is an honest empty slice.
 */

const LANE = 'feature'
const CHECKPOINT_ID = 'ckpt-1'
const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:00:10.000Z'
const FEATURE_WORKTREE = '/repo-wt/feature'
const QUIET_WORKTREE = '/repo-wt/quiet'

const CAPABILITY_HEADER = 'x-rhizomorph-capability'

function line(ts: string, text: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
}

/** The token the server really stamped into the really-served page — for the direct `inject` checks that need to pass the gate. */
function stampedToken(): string {
  return document.querySelector('meta[name="rhizomorph-capability"]')?.getAttribute('content') ?? ''
}

describe("contract: the frame reads telemetry and footprint from the lab's own routes, gated (prd-55 ruling 6, #402; prd-29 ruling 1)", () => {
  let h: ContractHarness
  let restoreFetch: () => void
  let root: string
  let sessionFile: string
  let byteAtLine1: number
  let sessionSize: number

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-contract-lab-series-'))
    sessionFile = path.join(root, 'session.jsonl')
    const l1 = line(T0, 'one')
    const l2 = line(T1, 'two')
    byteAtLine1 = Buffer.byteLength(`${l1}\n`, 'utf8')
    const content = `${l1}\n${l2}\n`
    sessionSize = Buffer.byteLength(content, 'utf8')
    await writeFile(sessionFile, content, 'utf8')

    h = await buildContractHarness({
      events: (repoPath): RhizomorphEvent[] => {
        const f = createEventFactory({ startTs: 1000 })
        f.sessionStarted({ sessionId: '1000', repoPath, repoName: 'repo' })
        f.forkCheckpoint({ lane: LANE, checkpointId: CHECKPOINT_ID, sessionFile, sessionCutByte: 0, sessionDigest: 'f'.repeat(64) })
        // Exactly at the first line's own timestamp — IN once the cut reaches it.
        f.llmCost({ lane: LANE, costUsd: 1 }, { ts: Date.parse(T0) })
        // A millisecond after the second line's — OUT of every cut this file tries.
        f.llmCost({ lane: LANE, costUsd: 2 }, { ts: Date.parse(T1) + 1 })
        f.worktreeDiscovered({ path: FEATURE_WORKTREE, branch: LANE, head: 'sha-feature', isMain: false })
        f.worktreeDirty({ path: FEATURE_WORKTREE, branch: LANE, files: [{ path: 'src/a.ts', status: 'modified' }] })
        f.worktreeDiscovered({ path: QUIET_WORKTREE, branch: 'quiet', head: 'sha-quiet', isMain: false })
        return f.all()
      },
    })
    restoreFetch = routeGlobalFetchThroughHarness(h.fetch)
  })

  afterEach(async () => {
    restoreFetch()
    await h.close()
    await rm(root, { recursive: true, force: true })
  })

  describe('telemetry', () => {
    it('a live slice: sliced by the wall time the byte cut reached, through the real gate', async () => {
      const reading = await readLabTelemetry(LANE, byteAtLine1)
      expect(reading.status).toBe('ready')
      if (reading.status !== 'ready') return
      expect(reading.asOf).toBe(Date.parse(T0))
      expect(reading.readingCount).toBe(1)
    })

    it('byte 0 is an honest empty slice, not a refusal', async () => {
      const reading = await readLabTelemetry(LANE, 0)
      expect(reading.status).toBe('ready')
      if (reading.status !== 'ready') return
      expect(reading.asOf).toBeNull()
      expect(reading.readingCount).toBe(0)
    })

    it("a byte past the session's real length is refused by name — the reading swallows it as `unavailable`, never a thrown error", async () => {
      const reading = await readLabTelemetry(LANE, sessionSize + 1_000)
      expect(reading.status).toBe('unavailable')
      if (reading.status !== 'unavailable') return
      expect(reading.reason).toMatch(/^BYTE BEYOND SESSION LENGTH for "feature"/)

      const direct = await h.app.inject({
        method: 'GET',
        url: `/api/lab/telemetry?lane=${LANE}&atByte=${sessionSize + 1_000}`,
        headers: { [CAPABILITY_HEADER]: stampedToken() },
      })
      expect(direct.statusCode).toBe(200)
      expect((direct.json() as { available: boolean }).available).toBe(false)
    })

    it('a tampered token is refused by the real gate — the reading swallows it as an error naming the 401, and the server itself answers 401', async () => {
      tamperCapabilityToken()

      const reading = await readLabTelemetry(LANE, byteAtLine1)
      expect(reading.status).toBe('error')
      if (reading.status !== 'error') return
      expect(reading.message).toMatch(/the telemetry route answered 401/)

      const direct = await h.app.inject({
        method: 'GET',
        url: `/api/lab/telemetry?lane=${LANE}&atByte=${byteAtLine1}`,
        headers: { [CAPABILITY_HEADER]: '0'.repeat(64) },
      })
      expect(direct.statusCode).toBe(401)
    })

    it('a page served without the token still reaches the wire bare — the reading names the 401, and the server answers its own honest 401 (ADR-0012 dev gap)', async () => {
      stripCapabilityToken()

      const reading = await readLabTelemetry(LANE, byteAtLine1)
      expect(reading.status).toBe('error')
      if (reading.status !== 'error') return
      expect(reading.message).toMatch(/the telemetry route answered 401/)

      const direct = await h.app.inject({ method: 'GET', url: `/api/lab/telemetry?lane=${LANE}&atByte=${byteAtLine1}` })
      expect(direct.statusCode).toBe(401)
    })
  })

  describe('footprint', () => {
    it('a live intersection: selectFilesTouchedByBranch ∩ selectCollisionMap, through the real gate', async () => {
      const reading = await readLabFootprint(LANE)
      expect(reading.status).toBe('ready')
      if (reading.status !== 'ready') return
      expect(reading.files).toEqual(['src/a.ts'])
    })

    it('a known branch that has touched nothing yet answers an honest empty footprint, not a refusal', async () => {
      const reading = await readLabFootprint('quiet')
      expect(reading.status).toBe('ready')
      if (reading.status !== 'ready') return
      expect(reading.files).toEqual([])
    })

    it('a lane the fold has never seen as a branch is refused by name — the reading swallows it as `unavailable`, never a thrown error', async () => {
      const reading = await readLabFootprint('ghost')
      expect(reading.status).toBe('unavailable')
      if (reading.status !== 'unavailable') return
      expect(reading.reason).toMatch(/^NO SUCH LANE "ghost"/)

      const direct = await h.app.inject({ method: 'GET', url: '/api/lab/footprint?lane=ghost', headers: { [CAPABILITY_HEADER]: stampedToken() } })
      expect(direct.statusCode).toBe(200)
      expect((direct.json() as { available: boolean }).available).toBe(false)
    })

    it('a tampered token is refused by the real gate — the reading swallows it as an error naming the 401, and the server itself answers 401', async () => {
      tamperCapabilityToken()

      const reading = await readLabFootprint(LANE)
      expect(reading.status).toBe('error')
      if (reading.status !== 'error') return
      expect(reading.message).toMatch(/the footprint route answered 401/)

      const direct = await h.app.inject({ method: 'GET', url: `/api/lab/footprint?lane=${LANE}`, headers: { [CAPABILITY_HEADER]: '0'.repeat(64) } })
      expect(direct.statusCode).toBe(401)
    })

    it('a page served without the token still reaches the wire bare — the reading names the 401, and the server answers its own honest 401 (ADR-0012 dev gap)', async () => {
      stripCapabilityToken()

      const reading = await readLabFootprint(LANE)
      expect(reading.status).toBe('error')
      if (reading.status !== 'error') return
      expect(reading.message).toMatch(/the footprint route answered 401/)

      const direct = await h.app.inject({ method: 'GET', url: `/api/lab/footprint?lane=${LANE}` })
      expect(direct.statusCode).toBe(401)
    })
  })
})
