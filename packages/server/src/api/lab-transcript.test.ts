import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { sessionFilePath } from '../log/session-log.js'
import { SessionRecorder } from '../server/recorder.js'
import {
  type LabArmTranscript,
  type LabParentTranscript,
  LabTranscriptRequestError,
  NOT_LAUNCHED_NOTE,
  readLabTranscript,
  registerLabTranscriptRoute,
} from './lab-transcript.js'
import { CAPABILITY_TOKEN_HEADER } from './security.js'
import { capabilityHeaders, TEST_CAPABILITY_TOKEN } from './test-support.js'
import { TRANSCRIPT_CHUNK_BYTES, type TranscriptEntry } from './transcript.js'

/**
 * The lab's own transcript route (prd-55 ruling 6 / S3′, #384), exercised
 * against a fixture RECORD and fixture FILES laid out exactly as the lab lays
 * them out: the parent's session where its checkpoint says it is, the arm's
 * under `<projects root>/<slug(worktree)>/`, the arm's restored lines being
 * the parent's cut prefix with its paths and session id rewritten — the
 * textual shape `lab/restore.ts`'s `synthesizeSession` produces.
 *
 * Paths are the collector fixtures' own convention (`/repo-wt/<lane>`,
 * `/data/lab/worktrees/<arm>`): they are slugged, never opened, so they can
 * stay POSIX-shaped on every platform. Every file that IS opened lives under
 * a temp directory made per test.
 */

const PARENT_LANE = 'feature'
const PARENT_WORKTREE = '/repo-wt/feature'
const PARENT_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const CHECKPOINT_ID = 'ckpt-1'
const ARM_HANDLE = 'fork-1-arm-1'
const ARM_WORKTREE = '/data/lab/worktrees/fork-1-arm-1'
const ARM_SESSION_ID = 'bbbbbbbb-0000-4000-8000-000000000002'

function userLine(text: string, sessionId = PARENT_SESSION_ID): string {
  return JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: text } })
}

function assistantLine(text: string, sessionId = PARENT_SESSION_ID): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
  })
}

/** What a line's text blocks say, joined. */
function proseOf(entry: TranscriptEntry | undefined): string {
  return (entry?.blocks ?? [])
    .map((block) => (block.kind === 'text' ? block.text : null))
    .filter((text): text is string => text !== null)
    .join('\n')
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The parent's conversation up to the fork — four turns, the third naming a file under its worktree. */
const PARENT_LINES = [
  userLine('fix the summariser'),
  assistantLine(`reading ${PARENT_WORKTREE}/src/summarise.ts`),
  assistantLine('the floor is wrong'),
  userLine('go on'),
]

/** `synthesizeSession`'s textual rewrite of the parent's prefix: the worktree path and the session id, nothing else. */
function restoredLines(parentLines: readonly string[]): string[] {
  return parentLines.map((line) => line.split(PARENT_WORKTREE).join(ARM_WORKTREE).split(PARENT_SESSION_ID).join(ARM_SESSION_ID))
}

interface WrittenParent {
  sessionFile: string
  cutByte: number
  digest: string
}

describe('GET /api/lab/transcript — the lab reads its own transcripts (prd-55 ruling 6, #384)', () => {
  let projectsRoot: string
  let sessionDir: string

  beforeEach(async () => {
    projectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-transcript-projects-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-transcript-sessions-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(projectsRoot, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  /** The parent's session file where the collector would find it, cut after `lines`, with `afterCut` appended beyond the cut. */
  async function writeParent(lines: readonly string[], afterCut: readonly string[] = []): Promise<WrittenParent> {
    const dir = path.join(projectsRoot, worktreePathToProjectSlug(PARENT_WORKTREE))
    await mkdir(dir, { recursive: true })
    const sessionFile = path.join(dir, `${PARENT_SESSION_ID}.jsonl`)
    const prefix = lines.map((line) => `${line}\n`).join('')
    await writeFile(sessionFile, prefix + afterCut.map((line) => `${line}\n`).join(''), 'utf8')
    return { sessionFile, cutByte: Buffer.byteLength(prefix, 'utf8'), digest: sha256(prefix) }
  }

  /** The arm's session file where `synthesizeSession` writes it — under its OWN worktree's project directory. */
  async function writeArm(lines: readonly string[], sessionId = ARM_SESSION_ID, root = projectsRoot): Promise<string> {
    const dir = path.join(root, worktreePathToProjectSlug(ARM_WORKTREE))
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${sessionId}.jsonl`)
    await writeFile(file, lines.map((line) => `${line}\n`).join(''), 'utf8')
    return file
  }

  /** The record: one checkpoint of the parent (as written), one arm dispatched from it. */
  function record(parent: WrittenParent, options: { dispatch?: boolean; cutByte?: number; digest?: string } = {}): RhizomorphEvent[] {
    const f = createEventFactory({ startTs: 1000 })
    f.forkCheckpoint({
      lane: PARENT_LANE,
      checkpointId: CHECKPOINT_ID,
      sessionFile: parent.sessionFile,
      sessionCutByte: options.cutByte ?? parent.cutByte,
      sessionDigest: options.digest ?? parent.digest,
    })
    if (options.dispatch !== false) {
      f.forkDispatched({
        forkId: 'fork-1',
        parentLane: PARENT_LANE,
        checkpointId: CHECKPOINT_ID,
        arm: 1,
        treatment: { model: 'opus', promptDigest: null },
        laneHandle: ARM_HANDLE,
        worktreePath: ARM_WORKTREE,
      })
    }
    return f.all()
  }

  function makeApp(events: RhizomorphEvent[], options: { claudeProjectsRoot?: string; chunkBytes?: number } = {}) {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'), { resumeFrom: events })
    const app = Fastify()
    registerLabTranscriptRoute(
      app,
      { repoPath: '/repo', repoName: 'repo', sessionDir, recorder, capabilityToken: TEST_CAPABILITY_TOKEN },
      options,
    )
    return app
  }

  describe('the parent, from its checkpoint to its cut', () => {
    it('serves every turn before the cut and none after it, digest-checked', async () => {
      const parent = await writeParent(PARENT_LINES, [assistantLine('the parent continues past the fork')])
      const result = (await readLabTranscript({ events: record(parent), lane: PARENT_LANE, arm: ARM_HANDLE })) as LabParentTranscript

      expect(result.available).toBe(true)
      expect(result.side).toBe('parent')
      expect(result.checkpointId).toBe(CHECKPOINT_ID)
      expect(result.sessionId).toBe(PARENT_SESSION_ID)
      expect(result.cutByte).toBe(parent.cutByte)
      expect(result.lines).toBe(PARENT_LINES.length)
      expect(result.droppedPartialLine).toBe(false)
      expect(result.entries.map(proseOf)).toEqual([
        'fix the summariser',
        `reading ${PARENT_WORKTREE}/src/summarise.ts`,
        'the floor is wrong',
        'go on',
      ])
    })

    it('a cut that falls mid-line drops the fragment, as the restore does — half a JSON object is not a turn', async () => {
      const parent = await writeParent(PARENT_LINES)
      const cutByte = parent.cutByte - 5
      const bytes = await readFile(parent.sessionFile)
      const digest = createHash('sha256').update(bytes.subarray(0, cutByte)).digest('hex')
      const result = (await readLabTranscript({ events: record(parent, { cutByte, digest }), lane: PARENT_LANE, arm: ARM_HANDLE })) as LabParentTranscript

      expect(result.available).toBe(true)
      expect(result.lines).toBe(PARENT_LINES.length - 1)
      expect(result.droppedPartialLine).toBe(true)
      expect(result.entries.map(proseOf)).toEqual(['fix the summariser', `reading ${PARENT_WORKTREE}/src/summarise.ts`, 'the floor is wrong'])
    })

    it('a transcript longer than one 64 KiB page is served complete up to the cut — its last turn is the last turn', async () => {
      // Every turn carries a multibyte character, so a piece boundary that
      // splits one is exercised many times over, whatever the piece size.
      const lines = Array.from({ length: 1_400 }, (_, i) => (i % 2 === 0 ? userLine(`turn ${i} — 日本`) : assistantLine(`turn ${i} — 日本`)))
      const parent = await writeParent(lines, [assistantLine('after the cut')])
      expect(parent.cutByte).toBeGreaterThan(TRANSCRIPT_CHUNK_BYTES)

      const result = (await readLabTranscript({ events: record(parent), lane: PARENT_LANE, arm: ARM_HANDLE })) as LabParentTranscript
      expect(result.available).toBe(true)
      expect(result.entries).toHaveLength(lines.length)
      expect(proseOf(result.entries[result.entries.length - 1])).toBe('turn 1399 — 日本')
      expect(result.entries.map(proseOf)).not.toContain('after the cut')

      // And in 100-byte pieces — smaller than a line — so a line split across
      // pieces, and a character split across pieces, are both proven whole.
      const small = (await readLabTranscript({ events: record(parent), lane: PARENT_LANE, arm: ARM_HANDLE, chunkBytes: 100 })) as LabParentTranscript
      expect(small.entries.map(proseOf)).toEqual(result.entries.map(proseOf))
    })

    it('refuses the read when one byte before the cut has changed — the digest no longer matches', async () => {
      const parent = await writeParent(PARENT_LINES)
      const bytes = await readFile(parent.sessionFile)
      // One byte, inside the cut, flipped: the file's length and line count are untouched.
      bytes[10] = bytes[10] === 0x61 ? 0x62 : 0x61
      await writeFile(parent.sessionFile, bytes)

      const result = await readLabTranscript({ events: record(parent), lane: PARENT_LANE, arm: ARM_HANDLE })
      expect(result.available).toBe(false)
      if (result.available) return
      expect(result.side).toBe('parent')
      expect(result.reason).toMatch(/^SESSION DIGEST REFUSED for "feature"/)
      expect(result.reason).toContain(CHECKPOINT_ID)
      expect(result.reason).toContain(parent.digest)
      expect(result.unknownLane).toBe(false)
    })

    it('a byte changed AFTER the cut changes nothing — the digest covers the prefix the checkpoint was taken over', async () => {
      const parent = await writeParent(PARENT_LINES, [assistantLine('later')])
      const bytes = await readFile(parent.sessionFile)
      bytes[parent.cutByte + 10] = bytes[parent.cutByte + 10] === 0x61 ? 0x62 : 0x61
      await writeFile(parent.sessionFile, bytes)

      const result = await readLabTranscript({ events: record(parent), lane: PARENT_LANE, arm: ARM_HANDLE })
      expect(result.available).toBe(true)
    })

    it('refuses a session shorter than its cut — truncated or replaced since capture', async () => {
      const parent = await writeParent(PARENT_LINES)
      await writeFile(parent.sessionFile, `${PARENT_LINES[0]}\n`, 'utf8')

      const result = await readLabTranscript({ events: record(parent), lane: PARENT_LANE, arm: ARM_HANDLE })
      expect(result.available).toBe(false)
      if (result.available) return
      expect(result.reason).toMatch(/^SESSION CUT REFUSED for "feature"/)
      expect(result.reason).toContain(`cuts at ${parent.cutByte}`)
    })

    it('a session file that is not on this machine is an honest absence naming the file, never a thrown 500', async () => {
      const parent = await writeParent(PARENT_LINES)
      await rm(parent.sessionFile)

      const result = await readLabTranscript({ events: record(parent), lane: PARENT_LANE, arm: ARM_HANDLE })
      expect(result.available).toBe(false)
      if (result.available) return
      expect(result.reason).toMatch(/^NO SESSION FILE for "feature"/)
      expect(result.reason).toContain(parent.sessionFile)
      expect(result.unknownLane).toBe(false)
    })
  })

  describe('an arm, from the session under its own worktree — resolved from the dispatch record', () => {
    it('serves the whole restored-and-continued session, and says the arm launched', async () => {
      const parent = await writeParent(PARENT_LINES, [assistantLine('the parent continues past the fork')])
      await writeArm([...restoredLines(PARENT_LINES), assistantLine('arm goes elsewhere', ARM_SESSION_ID), userLine('keep going', ARM_SESSION_ID)])

      const result = (await readLabTranscript({ events: record(parent), lane: ARM_HANDLE, claudeProjectsRoot: projectsRoot })) as LabArmTranscript
      expect(result.available).toBe(true)
      expect(result.side).toBe('arm')
      expect(result.parentLane).toBe(PARENT_LANE)
      expect(result.checkpointId).toBe(CHECKPOINT_ID)
      expect(result.sessionId).toBe(ARM_SESSION_ID)
      expect(result.restoredLines).toBe(PARENT_LINES.length)
      expect(result.lines).toBe(PARENT_LINES.length + 2)
      expect(result.launched).toBe(true)
      expect(result.note).toBeNull()
      expect(result.entries.map(proseOf)).toEqual([
        'fix the summariser',
        `reading ${ARM_WORKTREE}/src/summarise.ts`,
        'the floor is wrong',
        'go on',
        'arm goes elsewhere',
        'keep going',
      ])
    })

    it('an arm whose restored session has not grown past the cut answers "not launched", with its restored turns — not 404', async () => {
      const parent = await writeParent(PARENT_LINES)
      await writeArm(restoredLines(PARENT_LINES))

      const result = (await readLabTranscript({ events: record(parent), lane: ARM_HANDLE, claudeProjectsRoot: projectsRoot })) as LabArmTranscript
      expect(result.available).toBe(true)
      expect(result.launched).toBe(false)
      expect(result.note).toBe(NOT_LAUNCHED_NOTE)
      expect(result.note).toBe("not launched — its restored session ends where the parent's was cut")
      expect(result.lines).toBe(result.restoredLines)
      expect(result.entries).toHaveLength(PARENT_LINES.length)
    })

    it('finds the arm under the projects root the RECORD implies — the grandparent of the checkpoint\'s session file — with no root configured', async () => {
      const parent = await writeParent(PARENT_LINES)
      await writeArm([...restoredLines(PARENT_LINES), assistantLine('arm goes elsewhere', ARM_SESSION_ID)])

      // No `claudeProjectsRoot` at all: the fixture root is not this
      // machine's default, so only the record can lead here.
      const result = (await readLabTranscript({ events: record(parent), lane: ARM_HANDLE })) as LabArmTranscript
      expect(result.available).toBe(true)
      expect(result.launched).toBe(true)
      expect(proseOf(result.entries[result.entries.length - 1])).toBe('arm goes elsewhere')
    })

    it('an arm dispatched but never restored on this machine is an honest absence naming every directory tried', async () => {
      const parent = await writeParent(PARENT_LINES)

      const result = await readLabTranscript({ events: record(parent), lane: ARM_HANDLE, claudeProjectsRoot: projectsRoot })
      expect(result.available).toBe(false)
      if (result.available) return
      expect(result.side).toBe('arm')
      expect(result.reason).toMatch(/^NO RESTORED SESSION for "fork-1-arm-1"/)
      expect(result.reason).toContain(path.join(projectsRoot, worktreePathToProjectSlug(ARM_WORKTREE)))
      expect(result.reason).toContain(ARM_WORKTREE)
      expect(result.unknownLane).toBe(false)
    })

    it('when the parent\'s prefix no longer digests, whether the arm launched cannot be told — and the answer says so rather than guessing', async () => {
      const parent = await writeParent(PARENT_LINES)
      await writeArm(restoredLines(PARENT_LINES))
      const bytes = await readFile(parent.sessionFile)
      bytes[10] = bytes[10] === 0x61 ? 0x62 : 0x61
      await writeFile(parent.sessionFile, bytes)

      const result = (await readLabTranscript({ events: record(parent), lane: ARM_HANDLE, claudeProjectsRoot: projectsRoot })) as LabArmTranscript
      expect(result.available).toBe(true)
      expect(result.launched).toBeNull()
      expect(result.restoredLines).toBeNull()
      expect(result.note).toMatch(/^whether "fork-1-arm-1" launched cannot be told — the parent's session no longer matches checkpoint ckpt-1/)
      // The arm's own turns are still served — the arm's file is intact.
      expect(result.entries).toHaveLength(PARENT_LINES.length)
    })

    it('the newest session file in the arm\'s project directory is the one read — the rule the checkpoint itself cuts by', async () => {
      const parent = await writeParent(PARENT_LINES)
      const older = await writeArm([...restoredLines(PARENT_LINES), assistantLine('older', ARM_SESSION_ID)], 'cccccccc-0000-4000-8000-000000000003')
      const newer = await writeArm([...restoredLines(PARENT_LINES), assistantLine('newer', ARM_SESSION_ID)])
      const now = Date.now()
      await utimes(older, new Date(now - 60_000), new Date(now - 60_000))
      await utimes(newer, new Date(now), new Date(now))

      const result = (await readLabTranscript({ events: record(parent), lane: ARM_HANDLE, claudeProjectsRoot: projectsRoot })) as LabArmTranscript
      expect(result.sessionId).toBe(ARM_SESSION_ID)
      expect(proseOf(result.entries[result.entries.length - 1])).toBe('newer')
    })

    it('an arm whose checkpoint is missing from the record cannot be located, and says which checkpoint', async () => {
      const f = createEventFactory({ startTs: 1000 })
      f.forkDispatched({ forkId: 'fork-1', parentLane: PARENT_LANE, checkpointId: 'ckpt-gone', arm: 1, laneHandle: ARM_HANDLE, worktreePath: ARM_WORKTREE })

      const result = await readLabTranscript({ events: f.all(), lane: ARM_HANDLE, claudeProjectsRoot: projectsRoot })
      expect(result.available).toBe(false)
      if (result.available) return
      expect(result.side).toBe('arm')
      expect(result.reason).toMatch(/^NO CHECKPOINT for arm "fork-1-arm-1" — its dispatch record names checkpoint ckpt-gone/)
    })
  })

  describe('resolving which side, and which cut', () => {
    it('a lane the record never named — no checkpoint, no dispatch — is unknown, so the route may 404 it', async () => {
      const parent = await writeParent(PARENT_LINES)
      const result = await readLabTranscript({ events: record(parent), lane: 'nobody' })
      expect(result.available).toBe(false)
      if (result.available) return
      expect(result.side).toBeNull()
      expect(result.unknownLane).toBe(true)
      expect(result.reason).toMatch(/^NO SUCH LANE "nobody" in the lab's record/)
    })

    it('a parent with one checkpoint needs no hint; with two, the record cannot pick and refuses the question', async () => {
      const parent = await writeParent(PARENT_LINES)
      const one = await readLabTranscript({ events: record(parent, { dispatch: false }), lane: PARENT_LANE })
      expect(one.available).toBe(true)

      const f = createEventFactory({ startTs: 1000 })
      f.forkCheckpoint({ lane: PARENT_LANE, checkpointId: 'ckpt-1', sessionFile: parent.sessionFile, sessionCutByte: parent.cutByte, sessionDigest: parent.digest })
      f.forkCheckpoint({ lane: PARENT_LANE, checkpointId: 'ckpt-2', sessionFile: parent.sessionFile, sessionCutByte: parent.cutByte, sessionDigest: parent.digest })
      await expect(readLabTranscript({ events: f.all(), lane: PARENT_LANE })).rejects.toThrow(LabTranscriptRequestError)
      await expect(readLabTranscript({ events: f.all(), lane: PARENT_LANE })).rejects.toThrow(/has 2 checkpoints \(ckpt-1, ckpt-2\)/)

      // Named directly, the second cut is a different prefix of the same file.
      const second = (await readLabTranscript({ events: f.all(), lane: PARENT_LANE, checkpoint: 'ckpt-2' })) as LabParentTranscript
      expect(second.available).toBe(true)
      expect(second.checkpointId).toBe('ckpt-2')
    })

    it('checkpoint= naming a checkpoint the lane does not have, and arm= naming an arm of another lane, are honest absences', async () => {
      const parent = await writeParent(PARENT_LINES)
      const byId = await readLabTranscript({ events: record(parent), lane: PARENT_LANE, checkpoint: 'ckpt-elsewhere' })
      expect(byId.available).toBe(false)
      if (!byId.available) expect(byId.reason).toMatch(/^NO CHECKPOINT "ckpt-elsewhere" for "feature" — the record holds 1 for it \(ckpt-1\)/)

      const f = createEventFactory({ startTs: 1000 })
      f.forkCheckpoint({ lane: PARENT_LANE, checkpointId: CHECKPOINT_ID, sessionFile: parent.sessionFile, sessionCutByte: parent.cutByte, sessionDigest: parent.digest })
      f.forkCheckpoint({ lane: 'other', checkpointId: 'ckpt-other', sessionFile: parent.sessionFile, sessionCutByte: parent.cutByte, sessionDigest: parent.digest })
      f.forkDispatched({ forkId: 'fork-9', parentLane: 'other', checkpointId: 'ckpt-other', arm: 1, laneHandle: 'fork-9-arm-1', worktreePath: '/data/lab/worktrees/fork-9-arm-1' })
      const wrongParent = await readLabTranscript({ events: f.all(), lane: PARENT_LANE, arm: 'fork-9-arm-1' })
      expect(wrongParent.available).toBe(false)
      if (!wrongParent.available) expect(wrongParent.reason).toContain('was forked from "other", not from "feature"')

      const noArm = await readLabTranscript({ events: f.all(), lane: PARENT_LANE, arm: 'fork-0-arm-1' })
      expect(noArm.available).toBe(false)
      if (!noArm.available) expect(noArm.reason).toMatch(/^NO DISPATCH RECORD for arm "fork-0-arm-1"/)
    })
  })

  describe('the route', () => {
    it('is a gated read — a bare request is refused before the handler runs', async () => {
      const parent = await writeParent(PARENT_LINES)
      const app = makeApp(record(parent), { claudeProjectsRoot: projectsRoot })
      // Same readiness every other case in this file gets for free by
      // awaiting a real 200/400/404 through the gate: the request is made
      // only once the app is fully booted, never against a route table that
      // might still be mid-registration.
      await app.ready()
      const response = await app.inject({ method: 'GET', url: `/api/lab/transcript?lane=${ARM_HANDLE}` })
      expect(response.statusCode).toBe(401)
      // The body, not just the status: a pass means requireCapabilityToken
      // answered, never that some other 401 source did.
      expect(response.json()).toEqual({
        error: `missing or invalid ${CAPABILITY_TOKEN_HEADER} header — this route requires the per-process capability token`,
      })
      await app.close()
    })

    it('400 without a lane, and 400 when the record cannot pick a cut', async () => {
      const parent = await writeParent(PARENT_LINES)
      const f = createEventFactory({ startTs: 1000 })
      f.forkCheckpoint({ lane: PARENT_LANE, checkpointId: 'ckpt-1', sessionFile: parent.sessionFile, sessionCutByte: parent.cutByte, sessionDigest: parent.digest })
      f.forkCheckpoint({ lane: PARENT_LANE, checkpointId: 'ckpt-2', sessionFile: parent.sessionFile, sessionCutByte: parent.cutByte, sessionDigest: parent.digest })
      const app = makeApp(f.all(), { claudeProjectsRoot: projectsRoot })

      const bare = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: '/api/lab/transcript' })
      expect(bare.statusCode).toBe(400)
      expect((bare.json() as { error: string }).error).toContain('"lane"')

      const ambiguous = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: `/api/lab/transcript?lane=${PARENT_LANE}` })
      expect(ambiguous.statusCode).toBe(400)
      expect((ambiguous.json() as { error: string }).error).toContain('has 2 checkpoints')
      await app.close()
    })

    it('404 only for a lane the record never named — the body carries the reason and never `unknownLane`', async () => {
      const parent = await writeParent(PARENT_LINES)
      const app = makeApp(record(parent), { claudeProjectsRoot: projectsRoot })
      const response = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: '/api/lab/transcript?lane=nobody' })
      expect(response.statusCode).toBe(404)
      expect(response.json()).toEqual({
        available: false,
        side: null,
        lane: 'nobody',
        reason: expect.stringMatching(/^NO SUCH LANE "nobody"/),
      })
      await app.close()
    })

    it('200 for the parent read through the wire, cut at the arm\'s checkpoint', async () => {
      const parent = await writeParent(PARENT_LINES, [assistantLine('the parent continues')])
      const app = makeApp(record(parent), { claudeProjectsRoot: projectsRoot })
      const response = await app.inject({
        method: 'GET',
        headers: capabilityHeaders(TEST_CAPABILITY_TOKEN),
        url: `/api/lab/transcript?lane=${PARENT_LANE}&arm=${ARM_HANDLE}`,
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as LabParentTranscript
      expect(body.side).toBe('parent')
      expect(body.entries).toHaveLength(PARENT_LINES.length)
      expect(body.entries.map(proseOf)).not.toContain('the parent continues')
      await app.close()
    })

    it('200, not 404, for an arm that has not launched — and 200 with the reason for a refused digest', async () => {
      const parent = await writeParent(PARENT_LINES)
      await writeArm(restoredLines(PARENT_LINES))
      const app = makeApp(record(parent), { claudeProjectsRoot: projectsRoot })

      const arm = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: `/api/lab/transcript?lane=${ARM_HANDLE}` })
      expect(arm.statusCode).toBe(200)
      expect(arm.json()).toMatchObject({ available: true, side: 'arm', launched: false, note: NOT_LAUNCHED_NOTE })

      const bytes = await readFile(parent.sessionFile)
      bytes[10] = bytes[10] === 0x61 ? 0x62 : 0x61
      await writeFile(parent.sessionFile, bytes)
      const refused = await app.inject({ method: 'GET', headers: capabilityHeaders(TEST_CAPABILITY_TOKEN), url: `/api/lab/transcript?lane=${PARENT_LANE}&arm=${ARM_HANDLE}` })
      expect(refused.statusCode).toBe(200)
      expect(refused.json()).toEqual({
        available: false,
        side: 'parent',
        lane: PARENT_LANE,
        reason: expect.stringMatching(/^SESSION DIGEST REFUSED/),
      })
      await app.close()
    })
  })
})
