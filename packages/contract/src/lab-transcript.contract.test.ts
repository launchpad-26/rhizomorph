import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import type { TranscriptEntry } from '@rhizomorph/web/drawer/useTranscript'
import { readLabTranscript } from '@rhizomorph/web/lab/trace'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/lab/transcript`'s contract test (prd-55 ruling 6 / S3′, #384). The
 * REAL served page, the REAL `capabilityRead`, the REAL `readLabTranscript`
 * (`web/src/lab/trace/TraceDiff.tsx`), the REAL route over a REAL record and
 * REAL session files — `h.fetch` routed in as `globalThis.fetch`.
 *
 * The fixture is the lab's own layout, made per test under a temp root: the
 * parent's session where its checkpoint says it is, cut after four turns with
 * a fifth beyond the cut; two arms dispatched from that checkpoint, each with
 * its restored session under `<root>/<slug(worktree)>/` — the parent's cut
 * prefix with the worktree path and session id rewritten, the text
 * `lab/restore.ts`'s `synthesizeSession` writes. Arm 1 holds exactly the
 * restored lines (not launched); arm 2 has gone on. No projects root is
 * configured anywhere: the route finds both arms off the record alone, the
 * root being the grandparent of the checkpoint's `sessionFile`.
 *
 * Worktree paths are the collector fixtures' own convention (`/repo-wt/<lane>`,
 * `/data/lab/worktrees/<arm>`): slugged, never opened. The slug is the
 * collector's own rule (`worktreePathToProjectSlug`: every non-alphanumeric
 * to `-`), restated because the server package does not export it; a drift
 * there fails this file loudly (NO RESTORED SESSION), never silently.
 *
 * The refusal shape is `swallows`: `readLabTranscript` resolves to
 * `{ status: 'error' }` for a 401 rather than throwing, so the gate's refusal
 * is proven by the reading AND by a direct `h.app.inject` 401 on the same URL
 * — the coverage law's own rule for that shape.
 */

const PARENT_LANE = 'feature'
const PARENT_WORKTREE = '/repo-wt/feature'
const PARENT_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const CHECKPOINT_ID = 'ckpt-1'

interface Arm {
  handle: string
  worktree: string
  sessionId: string
  arm: number
}

const NOT_LAUNCHED_ARM: Arm = { handle: 'fork-1-arm-1', worktree: '/data/lab/worktrees/fork-1-arm-1', sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', arm: 1 }
const LAUNCHED_ARM: Arm = { handle: 'fork-1-arm-2', worktree: '/data/lab/worktrees/fork-1-arm-2', sessionId: 'cccccccc-0000-4000-8000-000000000003', arm: 2 }

/** The route's own words (`api/lab-transcript.ts`'s `NOT_LAUNCHED_NOTE`), asserted end to end rather than imported — the web bundle may not reach the server. */
const NOT_LAUNCHED = "not launched — its restored session ends where the parent's was cut"

const CAPABILITY_HEADER = 'x-rhizomorph-capability'

function slug(worktreePath: string): string {
  return worktreePath.replace(/[^a-zA-Z0-9]/g, '-')
}

function userLine(text: string, sessionId = PARENT_SESSION_ID): string {
  return JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: text } })
}

function assistantLine(text: string, sessionId = PARENT_SESSION_ID): string {
  return JSON.stringify({ type: 'assistant', sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

/** The parent's conversation up to the fork — four turns, the second naming a file under its worktree. */
const PARENT_LINES = [
  userLine('fix the summariser'),
  assistantLine(`reading ${PARENT_WORKTREE}/src/summarise.ts`),
  assistantLine('the floor is wrong'),
  userLine('go on'),
]

/** `synthesizeSession`'s textual rewrite of the parent's prefix: the worktree path and the session id, nothing else. */
function restored(arm: Arm): string[] {
  return PARENT_LINES.map((line) => line.split(PARENT_WORKTREE).join(arm.worktree).split(PARENT_SESSION_ID).join(arm.sessionId))
}

function prose(entry: TranscriptEntry): string {
  return entry.blocks.map((block) => (block.kind === 'text' ? block.text : '')).join('')
}

/** The token the server really stamped into the really-served page — for the direct `inject` checks that need to pass the gate. */
function stampedToken(): string {
  return document.querySelector('meta[name="rhizomorph-capability"]')?.getAttribute('content') ?? ''
}

describe('contract: the lab reads its own transcripts, gated (prd-55 ruling 6 / S3′, #384; prd-29 ruling 1)', () => {
  let h: ContractHarness
  let restoreFetch: () => void
  let root: string
  let parentSessionFile: string
  let cutByte: number

  async function writeArm(arm: Arm, lines: readonly string[]): Promise<void> {
    const dir = path.join(root, slug(arm.worktree))
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${arm.sessionId}.jsonl`), lines.map((line) => `${line}\n`).join(''), 'utf8')
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-contract-lab-transcript-'))
    const parentDir = path.join(root, slug(PARENT_WORKTREE))
    await mkdir(parentDir, { recursive: true })
    parentSessionFile = path.join(parentDir, `${PARENT_SESSION_ID}.jsonl`)
    const prefix = PARENT_LINES.map((line) => `${line}\n`).join('')
    cutByte = Buffer.byteLength(prefix, 'utf8')
    const digest = createHash('sha256').update(prefix, 'utf8').digest('hex')
    await writeFile(parentSessionFile, `${prefix}${assistantLine('the parent continues past the fork')}\n`, 'utf8')
    await writeArm(NOT_LAUNCHED_ARM, restored(NOT_LAUNCHED_ARM))
    await writeArm(LAUNCHED_ARM, [...restored(LAUNCHED_ARM), assistantLine('arm 2 goes elsewhere', LAUNCHED_ARM.sessionId)])

    h = await buildContractHarness({
      events: (repoPath): RhizomorphEvent[] => {
        const f = createEventFactory({ startTs: 1000 })
        f.sessionStarted({ sessionId: '1000', repoPath, repoName: 'repo' })
        f.forkCheckpoint({ lane: PARENT_LANE, checkpointId: CHECKPOINT_ID, sessionFile: parentSessionFile, sessionCutByte: cutByte, sessionDigest: digest })
        for (const arm of [NOT_LAUNCHED_ARM, LAUNCHED_ARM]) {
          f.forkDispatched({
            forkId: 'fork-1',
            parentLane: PARENT_LANE,
            checkpointId: CHECKPOINT_ID,
            arm: arm.arm,
            treatment: { model: 'opus', promptDigest: null },
            laneHandle: arm.handle,
            worktreePath: arm.worktree,
          })
        }
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

  it("the parent, end to end: read from its checkpoint's session file to the cut, digest-checked, through the real gate", async () => {
    const reading = await readLabTranscript(PARENT_LANE, { arm: NOT_LAUNCHED_ARM.handle })

    expect(reading.status).toBe('ready')
    if (reading.status !== 'ready') return
    expect(reading.side).toBe('parent')
    expect(reading.entries.map(prose)).toEqual([
      'fix the summariser',
      `reading ${PARENT_WORKTREE}/src/summarise.ts`,
      'the floor is wrong',
      'go on',
    ])
    expect(reading.entries.map(prose)).not.toContain('the parent continues past the fork')
  })

  it('an arm, end to end: read from the session under its own worktree, resolved from the dispatch record with no root configured', async () => {
    const reading = await readLabTranscript(LAUNCHED_ARM.handle)

    expect(reading.status).toBe('ready')
    if (reading.status !== 'ready') return
    expect(reading.side).toBe('arm')
    expect(reading.launched).toBe(true)
    expect(reading.note).toBeNull()
    expect(reading.entries.map(prose)).toEqual([
      'fix the summariser',
      `reading ${LAUNCHED_ARM.worktree}/src/summarise.ts`,
      'the floor is wrong',
      'go on',
      'arm 2 goes elsewhere',
    ])
  })

  it("an arm whose restored session has not grown past the cut answers the route's own words at 200 — never 404", async () => {
    const reading = await readLabTranscript(NOT_LAUNCHED_ARM.handle)

    expect(reading.status).toBe('ready')
    if (reading.status !== 'ready') return
    expect(reading.side).toBe('arm')
    expect(reading.launched).toBe(false)
    expect(reading.note).toBe(NOT_LAUNCHED)
    expect(reading.entries).toHaveLength(PARENT_LINES.length)

    const direct = await h.app.inject({
      method: 'GET',
      url: `/api/lab/transcript?lane=${NOT_LAUNCHED_ARM.handle}`,
      headers: { [CAPABILITY_HEADER]: stampedToken() },
    })
    expect(direct.statusCode).toBe(200)
  })

  it("one byte changed before the cut: the parent is refused with the digest reason, verbatim, and whether the arm launched can no longer be told", async () => {
    const bytes = await readFile(parentSessionFile)
    bytes[10] = bytes[10] === 0x61 ? 0x62 : 0x61
    await writeFile(parentSessionFile, bytes)

    const parent = await readLabTranscript(PARENT_LANE, { arm: NOT_LAUNCHED_ARM.handle })
    expect(parent.status).toBe('unavailable')
    if (parent.status !== 'unavailable') return
    expect(parent.reason).toMatch(/^SESSION DIGEST REFUSED for "feature"/)
    expect(parent.reason).toContain(CHECKPOINT_ID)

    const arm = await readLabTranscript(NOT_LAUNCHED_ARM.handle)
    expect(arm.status).toBe('ready')
    if (arm.status !== 'ready') return
    expect(arm.launched).toBeNull()
    expect(arm.note).toMatch(/^whether "fork-1-arm-1" launched cannot be told/)
  })

  it("a lane the record never named is the route's own 404, and the reading carries its reason rather than a bare status", async () => {
    const reading = await readLabTranscript('nobody')
    expect(reading.status).toBe('unavailable')
    if (reading.status !== 'unavailable') return
    expect(reading.reason).toMatch(/^NO SUCH LANE "nobody" in the lab's record/)

    const direct = await h.app.inject({ method: 'GET', url: '/api/lab/transcript?lane=nobody', headers: { [CAPABILITY_HEADER]: stampedToken() } })
    expect(direct.statusCode).toBe(404)
  })

  it('a tampered token is refused by the real gate — the reading swallows it as an error naming the 401, and the server itself answers 401', async () => {
    tamperCapabilityToken()

    const reading = await readLabTranscript(LAUNCHED_ARM.handle)
    expect(reading.status).toBe('error')
    if (reading.status !== 'error') return
    expect(reading.message).toMatch(/the lab transcript route answered 401/)

    const direct = await h.app.inject({
      method: 'GET',
      url: `/api/lab/transcript?lane=${LAUNCHED_ARM.handle}`,
      headers: { [CAPABILITY_HEADER]: '0'.repeat(64) },
    })
    expect(direct.statusCode).toBe(401)
  })

  it('a page served without the token still reaches the wire bare — the reading names the 401, and the server answers its own honest 401 (ADR-0012 dev gap)', async () => {
    stripCapabilityToken()

    const reading = await readLabTranscript(LAUNCHED_ARM.handle)
    expect(reading.status).toBe('error')
    if (reading.status !== 'error') return
    expect(reading.message).toMatch(/the lab transcript route answered 401/)

    const direct = await h.app.inject({ method: 'GET', url: `/api/lab/transcript?lane=${LAUNCHED_ARM.handle}` })
    expect(direct.statusCode).toBe(401)
  })
})
