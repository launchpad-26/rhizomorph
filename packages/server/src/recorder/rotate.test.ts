import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent, createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionFileName, transcriptCaptureDir, transcriptCaptureFileName } from '../log/paths.js'
import { decideSessionBoot, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import { LOCK_STALE_MS, readSessionLock, sessionLockFileName, writeSessionLock } from '../log/session-lock.js'
import { readTranscriptCaptureManifest } from '../log/transcript-capture.js'
import { closeCurrentSession, nextSessionStart, openNextSession, rotateSession } from './rotate.js'
import { SessionRecorder } from './session-recorder.js'

/**
 * ROTATION'S LAWS (prd16 ruling 2, prd17 ruling 3.5).
 *
 * The ordering is the point: **close, then open, never both open**. A crash
 * between the two halves must leave a closed log and NO live lock, so the next
 * boot starts fresh with a voice instead of resuming a log the operator ended.
 * These tests stage that crash by calling the close half alone — which is why
 * the two halves are separately exported.
 */

const FIRST = '1000'
const REPO_PATH = '/repo/watched'

function errorEvent(id: string, ts: number, message = 'boom') {
  return createEvent('collector.error', { collector: 'git', message }, { id, ts })
}

describe('rotateSession', () => {
  let dir: string
  let recorder: SessionRecorder
  /** A clock a test moves deliberately — never `Date.now`, so ids are pinned. */
  let clock: number

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rotate-test-'))
    clock = Number(FIRST)
    recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST))
    await recorder.record(
      createEvent(
        'session.started',
        { sessionId: FIRST, repoPath: REPO_PATH, repoName: 'watched' },
        { id: 'evt-000001', ts: clock },
      ),
    )
    await recorder.record(errorEvent('evt-000002', clock + 1))
    await writeSessionLock(dir, FIRST, process.pid, clock)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function options() {
    return {
      sessionDir: dir,
      repoPath: REPO_PATH,
      repoName: 'watched',
      recorder,
      now: () => clock,
      pid: process.pid,
    }
  }

  async function locksIn(sessionDir: string): Promise<string[]> {
    return (await readdir(sessionDir)).filter((name) => name.endsWith('.lock.json')).sort()
  }

  it('closes the old log and opens a fresh one, and says which is which', async () => {
    clock = 5000
    const rotation = await rotateSession(options())

    expect(rotation.closed).toEqual({
      sessionId: FIRST,
      filePath: sessionFilePath(dir, FIRST),
      eventCount: 3,
      closedAt: 5000,
    })
    expect(rotation.opened).toEqual({
      sessionId: '5000',
      filePath: path.join(dir, sessionFileName(5000)),
      startedAt: 5000,
    })
    // The recorder is now writing the new session — same object, new session.
    expect(recorder.sessionId).toBe('5000')
    expect(recorder.filePath).toBe(rotation.opened.filePath)
  })

  it('appends `session.closed` as the LAST line of the closed log, exactly once', async () => {
    clock = 5000
    await rotateSession(options())

    const closed = await readSessionEvents(sessionFilePath(dir, FIRST))
    expect(closed.map((event) => event.type)).toEqual([
      'session.started',
      'collector.error',
      'session.closed',
    ])
    expect(closed.filter((event) => event.type === 'session.closed')).toHaveLength(1)
    expect(closed.at(-1)).toMatchObject({
      source: 'system',
      type: 'session.closed',
      ts: 5000,
      payload: { sessionId: FIRST, reason: 'rotated', eventCount: 3 },
    })
    // The count it claims is the number of lines a reader actually finds.
    expect(closed).toHaveLength(3)
  })

  it('gives every closed log exactly one close, across repeated rotations', async () => {
    clock = 5000
    const first = await rotateSession(options())
    await recorder.record(errorEvent('evt-000003', 6000))
    clock = 7000
    const second = await rotateSession(options())

    for (const filePath of [first.closed.filePath, second.closed.filePath]) {
      const events = await readSessionEvents(filePath)
      expect(events.filter((event) => event.type === 'session.closed')).toHaveLength(1)
      expect(events.at(-1)?.type).toBe('session.closed')
    }
    // The live log is open: no close in it at all.
    expect((await readSessionEvents(second.opened.filePath)).some((e) => e.type === 'session.closed')).toBe(
      false,
    )
  })

  it('opens the new session with a `session.started` and nothing carried over', async () => {
    clock = 5000
    const rotation = await rotateSession(options())

    const opened = await readSessionEvents(rotation.opened.filePath)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      type: 'session.started',
      ts: 5000,
      payload: { sessionId: '5000', repoPath: REPO_PATH, repoName: 'watched' },
    })
    // The recorder's buffer — what a connecting SSE client replays — is the new
    // session only, never the closed one's history.
    expect(recorder.eventsSoFar()).toEqual(opened)
  })

  it('moves the lock across the boundary: one lock, on the new session, held by us', async () => {
    clock = 5000
    await rotateSession(options())

    expect(await locksIn(dir)).toEqual([sessionLockFileName('5000')])
    expect(await readSessionLock(dir, FIRST)).toBeNull()
    expect(await readSessionLock(dir, '5000')).toEqual({ pid: process.pid, heartbeatMs: 5000 })
  })

  describe('the crash ordering (prd17 ruling 3.5)', () => {
    it('leaves NO live lock between the halves — never both open', async () => {
      clock = 5000
      const closed = await closeCurrentSession(options())

      // This is exactly the state a crash between close and open leaves behind.
      expect(await locksIn(dir)).toEqual([])
      expect(await readdir(dir)).toEqual([sessionFileName(Number(FIRST))])
      expect((await readSessionEvents(closed.filePath)).at(-1)?.type).toBe('session.closed')

      // And the open half then claims exactly one, for the new session only.
      await openNextSession(options(), closed)
      expect(await locksIn(dir)).toEqual([sessionLockFileName('5000')])
    })

    it('a crash between the halves leaves a session the next boot refuses to resume', async () => {
      clock = 5000
      await closeCurrentSession(options())

      // The next boot, moments later — well inside any resume window.
      const decision = await decideSessionBoot(dir, 5100)
      expect(decision.reason).toBe('closed')
      expect(decision.resumed).toBeNull()
      expect(decision.eventCountAtBoot).toBe(0)
      // It is not merely "stale": the window did not lapse, a human decided.
      expect(decision.previousAgeMs).toBeLessThan(decision.windowMs)
    })

    it('a crash BEFORE any close still resumes — only a closed log is final', async () => {
      // No rotation at all: the same young session, its writer's heartbeat
      // stale. That is #187's crash case, and it must keep resuming exactly as
      // it did — the new `closed` reason must not swallow it.
      const decision = await decideSessionBoot(dir, Number(FIRST) + LOCK_STALE_MS + 1)
      expect(decision.reason).toBe('resumed')
      expect(decision.resumed?.sessionId).toBe(FIRST)
    })

    it('flushes and fsyncs the closed log before releasing its lock', async () => {
      // The prototype `handle.sync()` resolves through — the only place a real
      // fsync can be observed without mocking the whole fs module.
      const probe = await open(path.join(dir, 'probe.bin'), 'w')
      const fileHandleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
      await probe.close()
      const syncSpy = vi.spyOn(fileHandleProto, 'sync')

      try {
        clock = 5000
        await closeCurrentSession(options())
        expect(syncSpy).toHaveBeenCalled()
      } finally {
        syncSpy.mockRestore()
      }

      // …and everything is on disk, read back from the file rather than the buffer.
      const raw = await readFile(sessionFilePath(dir, FIRST), 'utf8')
      expect(raw.trimEnd().split('\n')).toHaveLength(3)
      expect(raw.endsWith('\n')).toBe(true)
    })
  })

  describe('the sealed window', () => {
    it('an event a collector records mid-rotation lands in the NEW session, never after the closed log', async () => {
      clock = 5000
      const closed = await closeCurrentSession(options())

      // A poll tick that fired while the operator's rotation was in flight.
      const straggler = errorEvent('evt-000009', 5001, 'polled during the rotation')
      const pending = recorder.record(straggler)

      await openNextSession(options(), closed)
      await pending

      const closedEvents = await readSessionEvents(closed.filePath)
      expect(closedEvents.map((event) => event.id)).toEqual(['evt-000001', 'evt-000002', `session-closed-${FIRST}`])
      const openedEvents = await readSessionEvents(recorder.filePath)
      expect(openedEvents.map((event) => event.id)).toEqual(['session-started-5000', 'evt-000009'])
    })

    it('subscribers see the close and the start on the stream they already hold', async () => {
      const seen: RhizomorphEvent[] = []
      recorder.subscribe((event) => seen.push(event))

      clock = 5000
      await rotateSession(options())

      expect(seen.map((event) => event.type)).toEqual(['session.closed', 'session.started'])
    })
  })

  describe('the new session id', () => {
    it('is never the closed one, even when the rotation happens in the same millisecond', async () => {
      clock = Number(FIRST) // rotating at the exact instant the session started
      const rotation = await rotateSession(options())

      expect(rotation.opened.sessionId).toBe('1001')
      expect(rotation.opened.filePath).not.toBe(rotation.closed.filePath)
      const closed = await readSessionEvents(rotation.closed.filePath)
      expect(closed.filter((event) => event.type === 'session.started')).toHaveLength(1)
    })

    it('nextSessionStart: the clock when it is ahead, one past the closed id when it is not', () => {
      expect(nextSessionStart('1000', 5000)).toBe(5000)
      expect(nextSessionStart('1000', 1000)).toBe(1001)
      expect(nextSessionStart('1000', 500)).toBe(1001)
      // A non-numeric id (nothing mints one, but nothing should crash on one).
      expect(nextSessionStart('record-xyz', 5000)).toBe(5000)
    })
  })

  it('two rotations asked at once are ONE boundary, not two', async () => {
    clock = 5000
    const [a, b] = await Promise.all([rotateSession(options()), rotateSession(options())])

    expect(a).toEqual(b)
    // One close, one open: the second caller did not close a session one
    // millisecond old.
    const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort()
    expect(files).toEqual([sessionFileName(Number(FIRST)), sessionFileName(5000)])
  })

  it('rotates again afterwards — the guard releases when the boundary is done', async () => {
    clock = 5000
    await rotateSession(options())
    clock = 6000
    const second = await rotateSession(options())

    expect(second.closed.sessionId).toBe('5000')
    expect(second.opened.sessionId).toBe('6000')
  })
})

describe('transcript capture on close (prd16 ruling 3)', () => {
  const LANE = '84-chat-drawer'
  const WORKTREE = '/tmp/rhizomorph-rotate-fixture/84-chat-drawer'
  const PROJECT_SLUG = '-tmp-rhizomorph-rotate-fixture-84-chat-drawer'
  const CLAUDE_SESSION_ID = 'sess-84'

  let dir: string
  let claudeProjectsRoot: string
  let recorder: SessionRecorder
  let clock: number

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rotate-capture-test-'))
    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rotate-capture-claude-'))
    clock = Number(FIRST)
    recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST))
    await recorder.record(
      createEvent(
        'session.started',
        { sessionId: FIRST, repoPath: REPO_PATH, repoName: 'watched' },
        { id: 'evt-000001', ts: clock },
      ),
    )
    const f = createEventFactory()
    await recorder.record(
      f.llmUsage(
        { lane: LANE, branch: LANE, sessionId: CLAUDE_SESSION_ID, worktreePath: WORKTREE },
        { id: 'evt-000002', ts: clock + 1 },
      ),
    )
    await writeSessionLock(dir, FIRST, process.pid, clock)
  })

  afterEach(async () => {
    await Promise.all([rm(dir, { recursive: true, force: true }), rm(claudeProjectsRoot, { recursive: true, force: true })])
  })

  function options() {
    return {
      sessionDir: dir,
      repoPath: REPO_PATH,
      repoName: 'watched',
      recorder,
      now: () => clock,
      pid: process.pid,
      claudeProjectsRoot,
    }
  }

  async function writeLiveTranscript(lines: string[]): Promise<void> {
    const liveDir = path.join(claudeProjectsRoot, PROJECT_SLUG)
    await mkdir(liveDir, { recursive: true })
    await writeFile(path.join(liveDir, `${CLAUDE_SESSION_ID}.jsonl`), lines.map((line) => `${line}\n`).join(''))
  }

  it('captures the lane transcript beside the closed log, and the manifest reports its size', async () => {
    await writeLiveTranscript([JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })])
    clock = 5000

    const closed = await closeCurrentSession(options())

    const capturedPath = path.join(transcriptCaptureDir(dir, FIRST), transcriptCaptureFileName(CLAUDE_SESSION_ID))
    const capturedRaw = await readFile(capturedPath, 'utf8')
    expect(JSON.parse(capturedRaw.trimEnd())).toMatchObject({ type: 'user' })

    const manifest = await readTranscriptCaptureManifest(dir, FIRST)
    expect(manifest).not.toBeNull()
    expect(manifest?.complete).toBe(true)
    expect(manifest?.totalBytes).toBeGreaterThan(0)
    expect(manifest?.lanes).toEqual([
      { lane: LANE, claudeSessionId: CLAUDE_SESSION_ID, captured: true, bytes: manifest?.totalBytes },
    ])

    // Capture finished before the close event was appended — not after.
    expect(closed.sessionId).toBe(FIRST)
  })

  it('voices a precise gap, and marks the manifest incomplete, when a lane\'s transcript is gone — and rotation still proceeds', async () => {
    // No live transcript ever written for this lane.
    clock = 5000

    const closed = await closeCurrentSession(options())

    const manifest = await readTranscriptCaptureManifest(dir, FIRST)
    expect(manifest?.complete).toBe(false)
    expect(manifest?.lanes[0]).toMatchObject({ lane: LANE, captured: false })
    expect(manifest?.lanes[0]?.reason).toContain('TRANSCRIPT NOT CAPTURED')

    // The close itself is unaffected: the log still ends in `session.closed`.
    const events = await readSessionEvents(closed.filePath)
    expect(events.at(-1)?.type).toBe('session.closed')
  })

  it('captures before the closing event is appended — the closed log is never marked done while capture is still unaccounted for', async () => {
    await writeLiveTranscript([JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })])
    clock = 5000

    await closeCurrentSession(options())

    // The manifest's own `capturedAt` is the close instant, proving it ran as
    // part of this same close rather than some later, unordered pass.
    const manifest = await readTranscriptCaptureManifest(dir, FIRST)
    expect(manifest?.capturedAt).toBe(5000)
  })
})
