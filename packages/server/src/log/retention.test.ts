import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsedSessionLogCache, readLaneIndex } from './lane-index.js'
import { sessionIdFromFileName, transcriptCaptureDir, TRANSCRIPT_CAPTURE_MANIFEST_FILE_NAME } from './paths.js'
import {
  applyRetentionPlan,
  planRetention,
  readRetentionPlan,
  RetentionAnswerRefused,
  voiceRetentionPlan,
} from './retention.js'
import { listSessions } from './session-log.js'

/**
 * RETENTION (prd-44 wave 3 · #38) — the laws of an operator act.
 *
 * Every assertion here is a COUNT or a rendered string — recordings removed,
 * bytes freed, lanes losing history, parses served — and never a wall clock,
 * which is the defect prd-24 named. No law here is named `*.bench.test.ts` and
 * none carries a `@gate-timing` marker, so `scripts/gate.sh`'s 4x-load timing
 * set and its `.swarm/timing-count` ratchet are untouched.
 *
 * The clock is a NUMBER passed in, never `Date.now()`: the policy is pure over
 * (contents, answer, clock), so a law that reached for the real clock would be
 * testing the box instead of the policy.
 */

const DAY = 24 * 60 * 60 * 1000
/** The clock every law measures against. Far enough ahead of the ids below that ages are unambiguous. */
const NOW = 1_800_000_000_000
const LANE = '519-migrate'
const WORKTREE = '/repo-wt/519-migrate'

/** A session that names one lane — enough for the lane index to give it a life. */
function laneEvents(sessionId: string, prefix: string): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: Number(sessionId), stepMs: 10, idPrefix: prefix })
  return [
    f.sessionStarted({ sessionId, repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: `sha-${prefix}`, isMain: false }),
    f.llmUsage({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: `claude-${prefix}`,
      model: 'test-model-unpriced',
      tokens: { input: 1, output: 100, cacheRead: 0, cacheCreation: 0 },
    }),
  ]
}

/** Writes a recording and sets its mtime — the age basis, so every law states it explicitly. */
async function writeRecording(dir: string, sessionId: string, events: readonly RhizomorphEvent[], mtimeMs: number) {
  const filePath = path.join(dir, `session-${sessionId}.jsonl`)
  await writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
  const when = new Date(mtimeMs)
  await utimes(filePath, when, when)
  return filePath
}

/** The capture sidecar that lets a pruned recording still read as pruned. */
async function writeCapture(dir: string, sessionId: string) {
  const captureDir = transcriptCaptureDir(dir, sessionId)
  await mkdir(captureDir, { recursive: true })
  await writeFile(
    path.join(captureDir, TRANSCRIPT_CAPTURE_MANIFEST_FILE_NAME),
    JSON.stringify({
      sessionId,
      capturedAt: Number(sessionId) + 1,
      complete: true,
      totalBytes: 10,
      lanes: [{ lane: LANE, claudeSessionId: `claude-${sessionId}`, captured: true, bytes: 10 }],
    }),
    'utf8',
  )
}

async function logFileNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => sessionIdFromFileName(name) !== null).sort()
}

describe('retention — the operator names the age, and there is no default', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-retention-test-'))
    parsedSessionLogCache.resetForTests()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    parsedSessionLogCache.resetForTests()
  })

  it('refuses every way of not naming an age, and refuses before reading anything', async () => {
    await writeRecording(dir, '1000', laneEvents('1000', 'a'), NOW - 40 * DAY)

    // Wave 0's answer is that there IS no default: each of these is a caller
    // asking for a policy this module does not have, and the refusal is a type
    // rather than a message so a caller can tell it from a read failure.
    for (const answer of [undefined, {}, { maxAgeMs: Number.NaN }, { maxAgeMs: -1 }, { maxAgeMs: '30d' }]) {
      expect(() =>
        planRetention({
          recordings: [],
          laneIndex: { lanes: [], unreadableSessionIds: [] },
          liveSessionId: null,
          answer: answer as never,
          nowMs: NOW,
        }),
      ).toThrow(RetentionAnswerRefused)
      await expect(readRetentionPlan(dir, { answer: answer as never, nowMs: NOW })).rejects.toThrow(
        RetentionAnswerRefused,
      )
    }

    // And the refusal cost nothing: a caller who named no age has not had a
    // recording touched on their behalf.
    expect(await logFileNames(dir)).toEqual(['session-1000.jsonl'])
  })

  it('reports what would go and removes nothing — the dry run is a read', async () => {
    await writeRecording(dir, '1000', laneEvents('1000', 'a'), NOW - 40 * DAY)
    await writeRecording(dir, '2000', laneEvents('2000', 'b'), NOW - 1 * DAY)
    const before = await Promise.all(
      (await listSessions(dir)).map(async (s) => (await stat(path.join(dir, s.fileName))).size),
    )

    const plan = await readRetentionPlan(dir, { answer: { maxAgeMs: 30 * DAY }, nowMs: NOW })

    expect(plan.candidates.map((c) => c.sessionId)).toEqual(['1000'])
    expect(plan.keptSessionIds).toEqual(['2000'])
    // Nothing removed, nothing truncated: planning is a read, and the operator
    // sees the whole census before agreeing to any of it.
    expect(await logFileNames(dir)).toEqual(['session-1000.jsonl', 'session-2000.jsonl'])
    const after = await Promise.all(
      (await listSessions(dir)).map(async (s) => (await stat(path.join(dir, s.fileName))).size),
    )
    expect(after).toEqual(before)
  })

  it('removes exactly the plan candidates when asked, and nothing when the plan is empty', async () => {
    await writeRecording(dir, '1000', laneEvents('1000', 'a'), NOW - 40 * DAY)
    await writeRecording(dir, '2000', laneEvents('2000', 'b'), NOW - 1 * DAY)

    const nothing = await readRetentionPlan(dir, { answer: { maxAgeMs: 365 * DAY }, nowMs: NOW })
    const noop = await applyRetentionPlan(dir, nothing)
    // "A law asserts nothing is removed without being asked": an answer nothing
    // is older than removes nothing, and `applyRetentionPlan` cannot invent a
    // candidate the plan does not carry.
    expect(noop.removedSessionIds).toEqual([])
    expect(await logFileNames(dir)).toEqual(['session-1000.jsonl', 'session-2000.jsonl'])

    const plan = await readRetentionPlan(dir, { answer: { maxAgeMs: 30 * DAY }, nowMs: NOW })
    const applied = await applyRetentionPlan(dir, plan)

    expect(applied.removedSessionIds).toEqual(['1000'])
    expect(applied.bytesFreed).toBeGreaterThan(0)
    expect(await logFileNames(dir)).toEqual(['session-2000.jsonl'])
  })

  it('never makes the live session a candidate, whatever its age, and refuses it again at the moment of deletion', async () => {
    await writeRecording(dir, '1000', laneEvents('1000', 'a'), NOW - 400 * DAY)
    await writeRecording(dir, '2000', laneEvents('2000', 'b'), NOW - 40 * DAY)

    const plan = await readRetentionPlan(dir, {
      answer: { maxAgeMs: 1 * DAY },
      nowMs: NOW,
      liveSessionId: '1000',
      liveEvents: laneEvents('1000', 'a'),
    })
    expect(plan.candidates.map((c) => c.sessionId)).toEqual(['2000'])
    expect(plan.keptSessionIds).toContain('1000')

    // The rotation-between-plan-and-apply case: this plan was made when '2000'
    // was closed, and by the time it is applied '2000' is the session being
    // written. A stale plan must not delete a log a writer holds.
    const applied = await applyRetentionPlan(dir, plan, { liveSessionId: '2000' })
    expect(applied.refusedLiveSessionIds).toEqual(['2000'])
    expect(applied.removedSessionIds).toEqual([])
    expect(await logFileNames(dir)).toEqual(['session-1000.jsonl', 'session-2000.jsonl'])
  })

  it('measures age from the last append, not from the session id', async () => {
    // An ancient id, written to yesterday: a long-running session's recording
    // is yesterday's work, and pruning it by its start would delete the
    // freshest history the operator has.
    await writeRecording(dir, '1000', laneEvents('1000', 'a'), NOW - 1 * DAY)
    // A newer id, untouched for a month.
    await writeRecording(dir, '2000', laneEvents('2000', 'b'), NOW - 40 * DAY)

    const plan = await readRetentionPlan(dir, { answer: { maxAgeMs: 30 * DAY }, nowMs: NOW })

    expect(plan.candidates.map((c) => c.sessionId)).toEqual(['2000'])
    expect(plan.keptSessionIds).toEqual(['1000'])
    // Both facts are reported, so a dry-run can show the pair rather than make
    // the reader guess which one the age came from.
    expect(plan.candidates[0]?.startedAt).toBe(2000)
    expect(plan.candidates[0]?.lastAppendedAt).toBe(NOW - 40 * DAY)
  })

  it('cannot reach the golden-era corpus — not a copy in the data root, and not the real one', async () => {
    // 1. A file with the corpus's own name, in the session directory, older
    //    than anything: `listSessions` matches `session-<ts>.jsonl` and nothing
    //    else, so no answer can name it.
    await writeFile(path.join(dir, 'recording.jsonl'), '{"not":"a session"}\n', 'utf8')
    const corpusCopy = path.join(dir, 'recording.jsonl')
    const ancient = new Date(0)
    await utimes(corpusCopy, ancient, ancient)
    await writeRecording(dir, '1000', laneEvents('1000', 'a'), NOW - 400 * DAY)

    expect(sessionIdFromFileName('recording.jsonl')).toBeNull()
    const plan = await readRetentionPlan(dir, { answer: { maxAgeMs: 0 }, nowMs: NOW })
    expect(plan.candidates.map((c) => c.fileName)).toEqual(['session-1000.jsonl'])

    await applyRetentionPlan(dir, plan)
    // Every session log in the directory is gone and the corpus copy is not.
    expect(await logFileNames(dir)).toEqual([])
    await expect(stat(corpusCopy)).resolves.toBeDefined()

    // 2. The real corpus is not on any path this policy could be pointed at: it
    //    reaches the reducer as bytes compiled into `core` (`corpus.ts` imports
    //    it with Vite's `?raw`), so ADR-0011's forward-compatibility guarantee
    //    does not depend on the data root at all. The `const` specifier is the
    //    idiom `session-recorder.test.ts`'s corpus law already needs: a literal
    //    one pulls `corpus.ts` into `tsc`'s program and fails with TS2307,
    //    because `server`'s tsconfig does not declare `?raw`.
    const corpusModulePath = '@rhizomorph/core/src/eras/corpus.js'
    const { eraCorpusEntry } = await import(corpusModulePath)
    expect(eraCorpusEntry('era-1').recordingText.length).toBeGreaterThan(0)
  })

  it('names which lanes lose history, not only which files go', async () => {
    await writeRecording(dir, '1000', laneEvents('1000', 'a'), NOW - 40 * DAY)
    await writeCapture(dir, '1000')
    await writeRecording(dir, '2000', laneEvents('2000', 'b'), NOW - 1 * DAY)

    const plan = await readRetentionPlan(dir, { answer: { maxAgeMs: 30 * DAY }, nowMs: NOW })

    expect(plan.lanes).toHaveLength(1)
    expect(plan.lanes[0]).toMatchObject({ handle: LANE, lost: ['1000'], kept: ['2000'], whole: false, silent: false })
    // A file count is not something an operator can consent to; a lane losing
    // two of its three recordings is.
    const voiced = voiceRetentionPlan(plan).join('\n')
    expect(voiced).toContain(`lane ${LANE} loses 1 of its 2 recordings`)
    expect(voiced).toContain('1 recording older than')
  })

  it('says when a lane loses its whole life, and when the loss will not even read as pruned', async () => {
    // Both recordings old, and NEITHER has a capture beside it.
    await writeRecording(dir, '1000', laneEvents('1000', 'a'), NOW - 40 * DAY)
    await writeRecording(dir, '2000', laneEvents('2000', 'b'), NOW - 35 * DAY)

    const plan = await readRetentionPlan(dir, { answer: { maxAgeMs: 30 * DAY }, nowMs: NOW })

    expect(plan.lanes[0]).toMatchObject({ handle: LANE, whole: true, silent: true })
    const voiced = voiceRetentionPlan(plan).join('\n')
    expect(voiced).toContain('its WHOLE recorded life')
    // The honest limit, said out loud rather than discovered afterwards: with no
    // sidecar left behind, the lane index has nothing to prove the recording
    // existed, so this slice will not read as pruned — it will be absent.
    expect(voiced).toContain('will not read as pruned')
  })

  it('leaves a pruned lane reading as PRUNED through the lane index, not as a lane that never existed', async () => {
    await writeRecording(dir, '1000', laneEvents('1000', 'a'), NOW - 40 * DAY)
    await writeCapture(dir, '1000')
    await writeRecording(dir, '2000', laneEvents('2000', 'b'), NOW - 1 * DAY)

    const plan = await readRetentionPlan(dir, { answer: { maxAgeMs: 30 * DAY }, nowMs: NOW })
    await applyRetentionPlan(dir, plan)

    const index = await readLaneIndex(dir)
    const lane = index.lanes.find((entry) => entry.handle === LANE)
    // The whole point of ruling 1's amendment: "no such lane" for work that did
    // happen is the dishonest failure. The lane is still here, still has both
    // slices, and says which one it cannot read.
    expect(lane).toBeDefined()
    expect(lane?.sessions.map((slice) => slice.sessionId)).toEqual(['1000', '2000'])
    expect(lane?.sessions[0]?.recordingPresent).toBe(false)
    expect(lane?.sessions[0]?.gap).toContain('RECORDING MISSING for session 1000')
    expect(lane?.missingSessionIds).toEqual(['1000'])
    expect(lane?.partialVoice).toContain('this reading is partial')
    expect(index.unreadableSessionIds).toContain('1000')
    // And the surviving recording is untouched — a prune is not a rewrite.
    expect(lane?.sessions[1]?.recordingPresent).toBe(true)
  })

  it('cannot leave the parse cache serving a recording that is gone', async () => {
    await writeRecording(dir, '1000', laneEvents('1000', 'a'), NOW - 40 * DAY)
    await writeRecording(dir, '2000', laneEvents('2000', 'b'), NOW - 1 * DAY)

    // Prime it the way a request would (prd-44 ruling 1 / #30).
    await readLaneIndex(dir)
    expect(parsedSessionLogCache.parseCount).toBe(2)
    expect(parsedSessionLogCache.cachedFileCount).toBe(2)

    const plan = await readRetentionPlan(dir, { answer: { maxAgeMs: 30 * DAY }, nowMs: NOW })
    await applyRetentionPlan(dir, plan)

    // Ruling 1's amendment asks that pruning invalidate the cache rather than
    // leave it serving a recording that is gone. It cannot: the cache `stat`s
    // before every hit and drops the entry when the file has gone, so the read
    // below serves an empty recording and holds one fewer file — no explicit
    // invalidation call, and no window in which a stale hit is possible.
    const read = await parsedSessionLogCache.read(path.join(dir, 'session-1000.jsonl'))
    expect(read.events).toEqual([])
    expect(parsedSessionLogCache.cachedFileCount).toBe(1)
  })

  it('is pure over its inputs — the same contents, answer and clock give the same plan', () => {
    const input = {
      recordings: [
        { summary: { id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 10 }, lastAppendedAt: NOW - 40 * DAY },
        { summary: { id: '2000', fileName: 'session-2000.jsonl', startedAt: 2000, sizeBytes: 20 }, lastAppendedAt: NOW - 1 * DAY },
      ],
      laneIndex: { lanes: [], unreadableSessionIds: [] },
      liveSessionId: null,
      answer: { maxAgeMs: 30 * DAY },
      nowMs: NOW,
    }

    // No filesystem, no clock of its own, and no memory between calls: the
    // policy is testable without deleting anything, which is the DoD's first
    // line and the reason the IO lives in `readRetentionPlan`.
    const first = planRetention(input)
    const second = planRetention(input)
    expect(second).toEqual(first)
    expect(first.candidates.map((c) => c.sessionId)).toEqual(['1000'])
    expect(first.bytes).toBe(10)
  })
})
