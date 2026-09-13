import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, fixtureTraceSpans, reduceAll, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildLaneIndex,
  findLaneInIndex,
  laneHandlesOf,
  ParsedSessionLogCache,
  parsedSessionLogCache,
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
    parsedSessionLogCache.resetForTests()
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

describe('ParsedSessionLogCache — the mechanics behind ruling 1 (#30)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizo-parsed-session-cache-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function write(name: string, content: string): Promise<string> {
    const filePath = path.join(dir, name)
    await writeFile(filePath, content, 'utf8')
    return filePath
  }

  // A real, schema-valid event line — `parseJsonl` validates the full envelope
  // against `rhizomorphEventSchema` (no lenient/passthrough path for the raw
  // read this cache wraps), so an arbitrary `source`/`type`/`payload` fails
  // validation and lands in `errors`, not `events`. `collector.error` is the
  // schema with the fewest required payload fields (`collector`, `message`,
  // both plain strings), which is why it is used here purely as fixture
  // plumbing — this test is about the cache, not about collectors.
  const line = (id: string) =>
    `{"id":"${id}","ts":1,"source":"system","type":"collector.error","payload":{"collector":"c","message":"m"}}\n`

  it('parses a file once across repeated reads of an unchanged file', async () => {
    const cache = new ParsedSessionLogCache()
    const filePath = await write('a.jsonl', line('aaa'))

    await cache.read(filePath)
    await cache.read(filePath)
    await cache.read(filePath)

    expect(cache.parseCount).toBe(1)
  })

  it('re-parses once the file grows (size changed)', async () => {
    const cache = new ParsedSessionLogCache()
    const filePath = await write('a.jsonl', line('aaa'))
    await cache.read(filePath)

    await write('a.jsonl', `${line('aaa')}${line('bbb')}`)
    await cache.read(filePath)

    expect(cache.parseCount).toBe(2)
  })

  it('re-parses on a same-size edit if mtime moved — mtime alone catches what size cannot', async () => {
    const cache = new ParsedSessionLogCache()
    const filePath = await write('a.jsonl', line('aaa'))
    await cache.read(filePath)
    const first = await stat(filePath)

    // Same length, different id — nothing about `size` moved.
    await writeFile(filePath, line('bbb'), 'utf8')
    await utimes(filePath, new Date(first.mtimeMs + 5_000), new Date(first.mtimeMs + 5_000))

    const read = await cache.read(filePath)
    expect(cache.parseCount).toBe(2)
    expect(read.events[0]?.id).toBe('bbb')
  })

  it('re-parses on a size change with mtime provably identical — the size half of the key, on its own', async () => {
    // The mtime must be PINNED BEFORE the first read, not restored after it.
    // `utimes` takes whole milliseconds while APFS stores sub-millisecond
    // mtimes, so "forcing it back" to a value `stat` reported yields a
    // DIFFERENT number: mtime alone then invalidates the entry and the size
    // check never runs. The earlier version of this law asserted parseCount
    // === 2 and got it for the wrong reason — dropping `size` from the
    // validity key left every test green while the cache served stale
    // content. Pinning to a whole-second value first makes the mtime one
    // `utimes` can restore exactly, and the precondition is now asserted
    // rather than assumed.
    const cache = new ParsedSessionLogCache()
    const filePath = await write('a.jsonl', line('aaa'))
    const pinned = new Date(1_700_000_000_000)
    await utimes(filePath, pinned, pinned)
    await cache.read(filePath)
    const before = await stat(filePath)

    await writeFile(filePath, `${line('aaa')}${line('bbb')}`, 'utf8')
    await utimes(filePath, pinned, pinned)
    const after = await stat(filePath)

    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).not.toBe(before.size)

    const read = await cache.read(filePath)
    expect(cache.parseCount).toBe(2)
    expect(read.events).toHaveLength(2)
  })

  it('answers empty and drops any entry when the file is gone, never throws', async () => {
    const cache = new ParsedSessionLogCache()
    const filePath = await write('a.jsonl', line('aaa'))
    await cache.read(filePath)
    expect(cache.cachedFileCount).toBe(1)

    await rm(filePath)
    const read = await cache.read(filePath)
    expect(read).toEqual({ events: [], lineCount: 0, unreadableLineCount: 0 })
    expect(cache.cachedFileCount).toBe(0)
  })

  it('single-flights concurrent reads of the same cold file into one parse', async () => {
    const cache = new ParsedSessionLogCache()
    const filePath = await write('a.jsonl', line('aaa'))

    const [x, y, z] = await Promise.all([cache.read(filePath), cache.read(filePath), cache.read(filePath)])
    expect(cache.parseCount).toBe(1)
    expect(x).toEqual(y)
    expect(y).toEqual(z)
  })

  it('evicts the least-recently-read file once the byte budget is exceeded', async () => {
    const a = await write('a.jsonl', line('a'))
    const b = await write('b.jsonl', line('b'))
    const oneFileBudget = (await stat(a)).size
    const cache = new ParsedSessionLogCache(oneFileBudget)

    await cache.read(a)
    expect(cache.parseCount).toBe(1)
    await cache.read(b) // pushes total bytes over budget with 2 entries — a evicted
    expect(cache.parseCount).toBe(2)
    expect(cache.cachedFileCount).toBe(1)

    await cache.read(a) // a is gone — must re-parse
    expect(cache.parseCount).toBe(3)
  })

  it('LRU, not FIFO: touching a file keeps it, so a fresher neighbour is evicted instead', async () => {
    const a = await write('a.jsonl', line('a'))
    const b = await write('b.jsonl', line('b'))
    const c = await write('c.jsonl', line('c'))
    const twoFileBudget = (await stat(a)).size * 2
    const cache = new ParsedSessionLogCache(twoFileBudget)

    await cache.read(a)
    await cache.read(b)
    await cache.read(a) // touch: a is now freshest, b is now oldest
    expect(cache.parseCount).toBe(2) // the touch was a cache HIT, not a re-parse

    await cache.read(c) // over budget with 3 — the oldest (b) must go, not a
    expect(cache.parseCount).toBe(3)
    expect(cache.cachedFileCount).toBe(2)

    await cache.read(a) // still cached
    expect(cache.parseCount).toBe(3)
    await cache.read(b) // evicted — must re-parse
    expect(cache.parseCount).toBe(4)
  })

  it('a refreshed entry counts as freshly used, not still the oldest', async () => {
    const a = await write('a.jsonl', line('a'))
    const b = await write('b.jsonl', line('b'))
    const c = await write('c.jsonl', line('c'))
    const twoFileBudget = (await stat(a)).size * 2
    const cache = new ParsedSessionLogCache(twoFileBudget)

    await cache.read(a)
    await cache.read(b) // oldest to newest: a, b
    const firstA = await stat(a)
    await writeFile(a, line('x'), 'utf8') // same length as line('a') — only the id character differs
    await utimes(a, new Date(firstA.mtimeMs + 1_000), new Date(firstA.mtimeMs + 1_000))
    await cache.read(a) // changed — re-parse, AND must move a to the fresh end
    expect(cache.parseCount).toBe(3)

    await cache.read(c) // over budget with 3 — if a's refresh hadn't reordered it, a (wrongly oldest) would be evicted instead of b
    expect(cache.parseCount).toBe(4)
    expect(cache.cachedFileCount).toBe(2)

    await cache.read(a) // still cached — proves a survived
    expect(cache.parseCount).toBe(4)
    await cache.read(b) // b was the one evicted
    expect(cache.parseCount).toBe(5)
  })
})

describe('readLaneIndex — the parsed-session cache end-to-end (prd-44 ruling 1 / #30)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizo-lane-index-cache-'))
    parsedSessionLogCache.resetForTests()
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

  it('parses each closed recording once, however many times the index is read', async () => {
    await writeSession(SESSION_A, sessionAEvents())
    await writeSession(SESSION_B, sessionBEvents())

    await readLaneIndex(dir)
    await readLaneIndex(dir)
    await readLaneIndex(dir)

    // Two closed files, three reads of the whole directory — the count is the file count.
    expect(parsedSessionLogCache.parseCount).toBe(2)
  })

  it('costs one parse per file even when many reads race a cold cache', async () => {
    await writeSession(SESSION_A, sessionAEvents())
    await writeSession(SESSION_B, sessionBEvents())

    await Promise.all([readLaneIndex(dir), readLaneIndex(dir), readLaneIndex(dir)])

    expect(parsedSessionLogCache.parseCount).toBe(2)
  })

  it('never touches the cache for the live session', async () => {
    await readLaneIndex(dir, { liveSessionId: SESSION_A, liveEvents: sessionAEvents() })
    await readLaneIndex(dir, { liveSessionId: SESSION_A, liveEvents: sessionAEvents() })
    expect(parsedSessionLogCache.parseCount).toBe(0)
    expect(parsedSessionLogCache.cachedFileCount).toBe(0)
  })

  it('degrades a pruned recording as unreadable, never as a lane that never existed', async () => {
    await writeSession(SESSION_A, sessionAEvents())
    await writeSession(SESSION_B, sessionBEvents())
    await writeCapture(
      SESSION_B,
      manifest(SESSION_B, [{ lane: LANE, claudeSessionId: 'claude-b', captured: true, bytes: 99 }]),
    )

    const before = await readLaneIndex(dir)
    expect(findLaneInIndex(before, LANE)?.sessions.map((s) => s.sessionId)).toEqual([SESSION_A, SESSION_B])
    expect(parsedSessionLogCache.cachedFileCount).toBe(2) // B is warm in the cache here

    // Wave 3's sweep (#38): the log is gone, but its capture sidecar outlives it.
    await rm(path.join(dir, `session-${SESSION_B}.jsonl`))

    const after = await readLaneIndex(dir)
    expect(after.unreadableSessionIds).toEqual([SESSION_B])
    const lane = findLaneInIndex(after, LANE)
    expect(lane?.sessions.map((s) => s.sessionId)).toEqual([SESSION_A, SESSION_B])
    expect(lane?.sessions[1]?.recordingPresent).toBe(false)
    expect(lane?.sessions[1]?.gap).toContain(SESSION_B)
    expect(lane?.partialVoice).toContain(SESSION_B)
  })
})

// ── laneHandlesOf, now public (prd-51 ruling 11, #432) ─────────────────────

/**
 * `laneHandlesOf` was private until #432. `log/archive.ts`'s tombstone writer
 * now derives its lane set from it, so the union it computes is a contract
 * between two modules rather than an internal detail of this one — and the git
 * half of that union is the whole reason the widening happened. A lane git
 * alone knows about is invisible to `allAttributedLanes`, so an
 * attribution-only tombstone left it to vanish from this index the moment its
 * log was pruned (the archive spike's verdict 5).
 */
describe('laneHandlesOf — telemetry handles ∪ non-main worktree branches (#432)', () => {
  it('unions both halves, sorted, and takes each lane only once', () => {
    const f = createEventFactory({ startTs: 1000, stepMs: 10, idPrefix: 'h' })
    const events: RhizomorphEvent[] = [
      f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
      f.worktreeDiscovered({ path: '/repo-wt/ghost-lane', branch: 'ghost-lane', head: 'sha-g', isMain: false }),
      f.worktreeDiscovered({ path: '/repo-wt/556-run-view', branch: LANE, head: 'sha-1', isMain: false }),
      f.llmUsage({ lane: LANE, branch: LANE, sessionId: 'claude-a', worktreePath: WORKTREE }),
    ]

    // 'main' is absent: it is the MAIN worktree's branch, deliberately skipped.
    // 'ghost-lane' is present from git alone — drop the worktree half of the
    // union and it disappears, which is exactly what #432 exists to fix.
    expect(laneHandlesOf(reduceAll(events))).toEqual(['556-run-view', 'ghost-lane'])
  })

  it('excludes a worktree with no branch — there is no handle to name it by', () => {
    const f = createEventFactory({ startTs: 1000, stepMs: 10, idPrefix: 'd' })
    const events: RhizomorphEvent[] = [
      f.worktreeDiscovered({ path: '/repo-wt/detached', branch: null, head: 'sha-d', isMain: false }),
      f.llmUsage({ lane: LANE, branch: LANE, sessionId: 'claude-a', worktreePath: WORKTREE }),
    ]

    expect(laneHandlesOf(reduceAll(events))).toEqual([LANE])
  })

  it('is telemetry alone when git saw nothing, and git alone when telemetry saw nothing', () => {
    const f = createEventFactory({ startTs: 1000, stepMs: 10, idPrefix: 't' })
    expect(laneHandlesOf(reduceAll([f.llmUsage({ lane: LANE, branch: LANE, sessionId: 'c', worktreePath: WORKTREE })]))).toEqual([
      LANE,
    ])

    const g = createEventFactory({ startTs: 1000, stepMs: 10, idPrefix: 'g' })
    expect(
      laneHandlesOf(
        reduceAll([g.worktreeDiscovered({ path: '/repo-wt/only-git', branch: 'only-git', head: 'sha', isMain: false })]),
      ),
    ).toEqual(['only-git'])
  })
})
