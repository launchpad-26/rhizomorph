import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, fixtureTraceSpans, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildLaneIndex,
  findLaneInIndex,
  readLaneIndex,
  type LaneIndexSession,
} from './lane-index.js'
import { transcriptCaptureDir, TRANSCRIPT_CAPTURE_MANIFEST_FILE_NAME } from './paths.js'
import type { TranscriptCaptureManifest } from './transcript-capture.js'

/**
 * THE LANE INDEX (prd-31 ruling 5 · #556) — the durability tests.
 *
 * The ruling's whole claim is "a lane's life survives its worktree", so the
 * assertions below are about *absence*: a worktree that has been removed, a
 * recording that is gone, a session the reader never loaded. Each one has to
 * read correctly with nothing on disk but the log and the capture sidecars.
 */

const LANE = '556-run-view'
const WORKTREE = '/repo-wt/556-run-view'
const SESSION_A = '1000'
const SESSION_B = '2000'

/** Session A: the lane works, touches a file, commits — and nothing is removed. */
function sessionAEvents(): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: Number(SESSION_A), stepMs: 10, idPrefix: 'a' })
  return [
    f.sessionStarted({ sessionId: SESSION_A, repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
    f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-1', isMain: false }),
    f.llmUsage({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: 'claude-a',
      model: 'test-model-unpriced',
      tokens: { input: 1, output: 1_000, cacheRead: 10, cacheCreation: 2 },
    }),
    f.toolActivity({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: 'claude-a',
      tool: 'Read',
      filePath: 'packages/server/src/log/lane-index.ts',
      toolUseId: 'toolu_a_1',
    }),
    ...fixtureTraceSpans({ lane: LANE, sessionId: 'claude-a', startTs: Number(SESSION_A) + 100 }),
  ]
}

/** Session B: the same lane, a commit, and then `workmux merge` removing the worktree. */
function sessionBEvents(): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: Number(SESSION_B), stepMs: 10, idPrefix: 'b' })
  return [
    f.sessionStarted({ sessionId: SESSION_B, repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
    f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-2', isMain: false }),
    f.llmUsage({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: 'claude-b',
      model: 'test-model-unpriced',
      tokens: { input: 1, output: 4_000, cacheRead: 10, cacheCreation: 2 },
    }),
    f.llmCost({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: 'claude-b',
      model: 'test-model-unpriced',
      costUsd: 0.42,
      authoritative: true,
    }),
    f.commitLanded({
      branch: LANE,
      sha: 'abc1234def',
      message: 'feat(lane-page): the run view (#556)',
      files: [{ path: 'packages/web/src/lane-page/LanePage.tsx', status: 'modified' }],
      insertions: 12,
      deletions: 1,
      worktreePath: WORKTREE,
    }),
    // The moment the ruling is about: the worktree goes, the log keeps saying so.
    f.worktreeRemoved({ path: WORKTREE }),
  ]
}

function session(
  id: string,
  events: readonly RhizomorphEvent[] | null,
  capture: TranscriptCaptureManifest | null = null,
): LaneIndexSession {
  return {
    summary: { id, startedAt: Number(id) },
    events,
    unreadableLineCount: 0,
    label: null,
    capture,
  }
}

function manifest(id: string, lanes: TranscriptCaptureManifest['lanes']): TranscriptCaptureManifest {
  return {
    sessionId: id,
    capturedAt: Number(id) + 1,
    complete: lanes.every((lane) => lane.captured),
    totalBytes: lanes.reduce((sum, lane) => sum + lane.bytes, 0),
    lanes,
  }
}

describe('buildLaneIndex — one continuous life across recordings', () => {
  const index = buildLaneIndex([
    // Deliberately out of order: the fold sorts, so a caller listing newest
    // first cannot make a lane's life read backwards.
    session(SESSION_B, sessionBEvents()),
    session(SESSION_A, sessionAEvents()),
  ])
  const lane = findLaneInIndex(index, LANE)

  it('finds the lane, with both recordings, oldest first', () => {
    expect(lane).not.toBeNull()
    expect(lane?.sessions.map((slice) => slice.sessionId)).toEqual([SESSION_A, SESSION_B])
  })

  it('carries the issue number from the handle, so a lane opens by issue too', () => {
    expect(lane?.issue).toBe('556')
    expect(findLaneInIndex(index, '556')?.handle).toBe(LANE)
  })

  it('answers to the branch and the worktree basename as well as the handle', () => {
    expect(lane?.aliases).toContain(LANE)
    expect(findLaneInIndex(index, LANE)?.handle).toBe(LANE)
  })

  it('spans both recordings in one first/last window', () => {
    expect(lane?.firstSeenAt).toBeLessThan(Number(SESSION_B))
    expect(lane?.lastSeenAt).toBeGreaterThan(Number(SESSION_B))
  })

  it('sums nothing across recordings itself — each slice carries its own reading', () => {
    // The index never adds two sessions' tokens together: a reader who wants a
    // life total gets it by adding the slices they can see, which is the only
    // sum that stays honest when one of them is missing.
    expect(lane?.sessions[0]?.tokens.output).toBe(1_000)
    expect(lane?.sessions[1]?.tokens.output).toBe(4_000)
  })

  it('reads the worktree’s removal off the LOG, never off the disk', () => {
    // The path in this fixture has never existed on any filesystem. If the
    // index stat'd it, the first slice could not say `present` and the second
    // could not say `removed` — both are the log's own record.
    expect(lane?.sessions[0]?.worktreeRemoved).toBe(false)
    expect(lane?.sessions[1]?.worktreeRemoved).toBe(true)
    expect(lane?.worktreeRemoved).toBe(true)
    expect(lane?.worktreePath).toBe(WORKTREE)
  })

  it('carries the commit that is the outcome’s evidence', () => {
    const commits = lane?.sessions.flatMap((slice) => slice.commits) ?? []
    expect(commits).toHaveLength(1)
    expect(commits[0]?.sha).toBe('abc1234def')
    expect(commits[0]?.message).toContain('#556')
  })

  it('carries cost with its provenance, and a null where there were no dollars', () => {
    expect(lane?.sessions[0]?.costIsAuthoritative).toBeNull()
    expect(lane?.sessions[0]?.costUsd).toBe(0)
    expect(lane?.sessions[1]?.costIsAuthoritative).toBe(true)
    expect(lane?.sessions[1]?.costUsd).toBeCloseTo(0.42)
  })

  it('carries the tool NAMES, which is what a phase can be inferred from', () => {
    expect(Object.keys(lane?.sessions[0]?.toolCounts ?? {})).toContain('Read')
  })

  it('counts the interaction roots the recording holds', () => {
    expect(lane?.sessions[0]?.interactionCount).toBe(1)
  })

  it('is whole — no missing recording, so no partial voice', () => {
    expect(lane?.missingSessionIds).toEqual([])
    expect(lane?.partialVoice).toBeNull()
    expect(index.unreadableSessionIds).toEqual([])
  })
})

describe('buildLaneIndex — a missing recording is NAMED, never dropped', () => {
  const MISSING = '1500'
  const index = buildLaneIndex([
    session(SESSION_A, sessionAEvents()),
    // The log is gone; the capture sidecar beside it survives and still names
    // the lane. That sidecar is the only witness that this session happened.
    session(MISSING, null, manifest(MISSING, [{ lane: LANE, claudeSessionId: 'claude-m', captured: true, bytes: 42 }])),
    session(SESSION_B, sessionBEvents()),
  ])
  const lane = findLaneInIndex(index, LANE)

  it('keeps the missing session as a row in the life, in its place in time', () => {
    expect(lane?.sessions.map((slice) => slice.sessionId)).toEqual([SESSION_A, MISSING, SESSION_B])
  })

  it('names WHICH session is absent, in the slice and in the lane’s own voice', () => {
    const missing = lane?.sessions.find((slice) => slice.sessionId === MISSING)
    expect(missing?.recordingPresent).toBe(false)
    expect(missing?.gap).toContain(MISSING)
    expect(missing?.gap).toContain('RECORDING MISSING')
    expect(lane?.missingSessionIds).toEqual([MISSING])
    expect(lane?.partialVoice).toContain(MISSING)
    expect(index.unreadableSessionIds).toEqual([MISSING])
  })

  it('reports no numbers for it at all, so a zero is never mistaken for a measurement', () => {
    const missing = lane?.sessions.find((slice) => slice.sessionId === MISSING)
    expect(missing?.tokens.output).toBe(0)
    expect(missing?.costIsAuthoritative).toBeNull()
    expect(missing?.firstTs).toBeNull()
    // What it DOES carry is the capture that proved it existed.
    expect(missing?.transcript?.captured).toBe(true)
  })

  it('would report a whole life as whole — the gap is not always on', () => {
    // The mutation: the same lane read without the sidecar-only session is
    // whole, so the partial voice above is a finding rather than a constant.
    const whole = buildLaneIndex([session(SESSION_A, sessionAEvents()), session(SESSION_B, sessionBEvents())])
    expect(findLaneInIndex(whole, LANE)?.partialVoice).toBeNull()
  })
})

describe('buildLaneIndex — the worktree state is the NEWEST recording that knew', () => {
  it('reads a re-dispatched lane as working again, not folded forever', () => {
    // The sibling of the durability case, and the one a sticky `true` gets
    // wrong: a handle torn down and dispatched again is present NOW, whatever
    // an older recording watched happen to its predecessor.
    const index = buildLaneIndex([
      session(SESSION_A, sessionBEvents()), // discovered, then removed
      session(SESSION_B, sessionAEvents()), // discovered again, still there
    ])
    expect(findLaneInIndex(index, LANE)?.worktreeRemoved).toBe(false)
  })

  it('is not un-removed by a later recording that never saw a worktree at all', () => {
    // The other half: telemetry-only recordings say `null`, not `false`, so
    // they cannot quietly resurrect a worktree nobody re-created.
    const f = createEventFactory({ startTs: 3_000, stepMs: 10, idPrefix: 'tel' })
    const index = buildLaneIndex([
      session(SESSION_B, sessionBEvents()),
      session('3000', [
        f.sessionStarted({ sessionId: '3000', repoPath: '/repo', repoName: 'r', mainBranch: 'main' }),
        f.llmUsage({ lane: LANE, branch: null, worktreePath: null, sessionId: 'claude-c', model: 'm', tokens: { input: 1, output: 5, cacheRead: 0, cacheCreation: 0 } }),
      ]),
    ])
    const lane = findLaneInIndex(index, LANE)
    expect(lane?.sessions[1]?.worktreeRemoved).toBeNull()
    expect(lane?.worktreeRemoved).toBe(true)
  })
})

describe('buildLaneIndex — a lane git alone ever saw', () => {
  it('is indexed from its worktree, so an uninstrumented lane still opens', () => {
    const f = createEventFactory({ startTs: 3_000, stepMs: 10, idPrefix: 'g' })
    const index = buildLaneIndex([
      session('3000', [
        f.sessionStarted({ sessionId: '3000', repoPath: '/repo', repoName: 'r', mainBranch: 'main' }),
        f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'm', isMain: true }),
        f.worktreeDiscovered({ path: '/repo-wt/700-quiet', branch: '700-quiet', head: 'q', isMain: false }),
      ]),
    ])

    const lane = findLaneInIndex(index, '700-quiet')
    expect(lane?.handle).toBe('700-quiet')
    expect(lane?.branch).toBe('700-quiet')
    expect(lane?.issue).toBe('700')
    // No telemetry: zeroed, and the cost says "unknown" rather than "$0.00".
    expect(lane?.sessions[0]?.tokens.output).toBe(0)
    expect(lane?.sessions[0]?.costIsAuthoritative).toBeNull()
  })

  it('never claims main as a lane', () => {
    const f = createEventFactory({ startTs: 3_000, stepMs: 10, idPrefix: 'm' })
    const index = buildLaneIndex([
      session('3000', [
        f.sessionStarted({ sessionId: '3000', repoPath: '/repo', repoName: 'r', mainBranch: 'main' }),
        f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'm', isMain: true }),
      ]),
    ])
    expect(index.lanes).toEqual([])
  })
})

describe('findLaneInIndex — an exact alias always beats an issue match', () => {
  it('does not let one lane’s issue number shadow another lane’s handle', () => {
    const f = createEventFactory({ startTs: 4_000, stepMs: 10, idPrefix: 'x' })
    const index = buildLaneIndex([
      session('4000', [
        f.sessionStarted({ sessionId: '4000', repoPath: '/repo', repoName: 'r', mainBranch: 'main' }),
        f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'm', isMain: true }),
        f.worktreeDiscovered({ path: '/repo-wt/12', branch: '12', head: 'a', isMain: false }),
        f.worktreeDiscovered({ path: '/repo-wt/12-other', branch: '12-other', head: 'b', isMain: false }),
      ]),
    ])
    // `12` is both a handle and `12-other`'s issue number. The handle wins.
    expect(findLaneInIndex(index, '12')?.handle).toBe('12')
  })

  it('returns null for a handle nothing answers to', () => {
    expect(findLaneInIndex(buildLaneIndex([]), 'never-existed')).toBeNull()
  })
})

describe('readLaneIndex — over a real session directory', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizo-lane-index-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeSession(id: string, events: readonly RhizomorphEvent[]): Promise<void> {
    await writeFile(
      path.join(dir, `session-${id}.jsonl`),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    )
  }

  async function writeCapture(id: string, body: TranscriptCaptureManifest): Promise<void> {
    const captureDir = transcriptCaptureDir(dir, id)
    await mkdir(captureDir, { recursive: true })
    await writeFile(path.join(captureDir, TRANSCRIPT_CAPTURE_MANIFEST_FILE_NAME), JSON.stringify(body), 'utf8')
  }

  it('assembles the lane from the logs on disk, with no worktree anywhere', async () => {
    await writeSession(SESSION_A, sessionAEvents())
    await writeSession(SESSION_B, sessionBEvents())
    await writeCapture(SESSION_B, manifest(SESSION_B, [{ lane: LANE, claudeSessionId: 'claude-b', captured: true, bytes: 99 }]))

    const index = await readLaneIndex(dir)
    const lane = findLaneInIndex(index, LANE)

    expect(lane?.sessions.map((slice) => slice.sessionId)).toEqual([SESSION_A, SESSION_B])
    expect(lane?.worktreeRemoved).toBe(true)
    expect(lane?.sessions[1]?.transcript?.bytes).toBe(99)
  })

  it('finds the session whose capture outlived its log, and names it', async () => {
    await writeSession(SESSION_A, sessionAEvents())
    await writeCapture('1500', manifest('1500', [{ lane: LANE, claudeSessionId: 'claude-m', captured: true, bytes: 5 }]))

    const index = await readLaneIndex(dir)
    expect(index.unreadableSessionIds).toEqual(['1500'])
    expect(findLaneInIndex(index, LANE)?.partialVoice).toContain('1500')
  })

  it('reads the live session from the recorder’s buffer, never mid-append from its file', async () => {
    // No file at all for the live session — only the buffer. If the read went
    // to disk, the lane would be absent.
    const index = await readLaneIndex(dir, { liveSessionId: SESSION_A, liveEvents: sessionAEvents() })
    // `listSessions` finds nothing on disk, so nothing is read: the live
    // override only applies to a session the directory already lists. This
    // pins that boundary rather than leaving it to be discovered.
    expect(index.lanes).toEqual([])

    await writeSession(SESSION_A, [])
    const withFile = await readLaneIndex(dir, { liveSessionId: SESSION_A, liveEvents: sessionAEvents() })
    expect(findLaneInIndex(withFile, LANE)?.sessions[0]?.tokens.output).toBe(1_000)
  })

  it('is empty and calm for a directory with nothing in it', async () => {
    expect(await readLaneIndex(dir)).toEqual({ lanes: [], unreadableSessionIds: [] })
  })
})
