import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent, createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { repoSlug, sessionFileName, transcriptCaptureDir, transcriptCaptureFileName } from '../log/paths.js'
import { decideSessionBoot, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import { LOCK_STALE_MS, readSessionLock, sessionLockFileName, writeSessionLock } from '../log/session-lock.js'
import { readTranscriptCaptureManifest } from '../log/transcript-capture.js'
import {
  closeCurrentSession,
  nextSessionStart,
  openNextSession,
  performRetarget,
  reserveInFlightForTest,
  RetargetInFlightError,
  retargetSession,
  RotationRefusedError,
  rotateSession,
} from './rotate.js'
import { SessionLogWriter } from './session-log-writer.js'
import { SessionRecorder } from './session-recorder.js'

function isRejected(result: PromiseSettledResult<unknown>): result is PromiseRejectedResult {
  return result.status === 'rejected'
}

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

/**
 * Every line of a log, in order, by type — the WHOLE sequence, never
 * `.at(-1)`. "`session.closed` is the last line" is a claim about the file, and
 * a last-line check passes on a file that ended two lines early (`a6dddfd`).
 */
async function typesIn(filePath: string): Promise<string[]> {
  return (await readSessionEvents(filePath)).map((event) => event.type)
}

/** The fsync failure #80 is about: the append already landed, the flush did not. */
const FSYNC_FAILED = 'EIO: i/o error, fsync'

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
      // The ordinary case, stated exactly (#80): a rotation whose fsync
      // succeeded reports `synced: true` and carries NO `syncError`. `toEqual`
      // rather than `toMatchObject` is what makes that second half assertable.
      synced: true,
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

  /**
   * PRD-40 RULING 1'S FIFTH AMENDMENT (#80). A session is closed the instant
   * its `session.closed` line is appended — durability is a separate, later
   * property. Rule 1b holds the recorder's seal on a failed fsync, and these
   * are the caller-side consequences the amendment ruled with it: the close
   * half absorbs that one rejection (1b-i), still drops the lock (1b-ii), and
   * the boundary as a whole completes rather than wedging.
   */
  describe('a fsync that fails after the close line lands (prd40 ruling 1, rule 1b)', () => {
    it('closeCurrentSession returns `synced: false` rather than throwing, and still drops the lock', async () => {
      clock = 5000
      const sync = vi.spyOn(SessionLogWriter.prototype, 'sync').mockRejectedValueOnce(new Error(FSYNC_FAILED))
      try {
        // 1b-i: it RETURNS. Nothing had to be reconstructed — `sessionId`,
        // `filePath`, `closedAt` and `eventCount` are all captured before the
        // first `await`, so the descriptor is complete before the failure point.
        const closed = await closeCurrentSession(options())
        expect(closed).toMatchObject({
          sessionId: FIRST,
          filePath: sessionFilePath(dir, FIRST),
          closedAt: 5000,
          synced: false,
        })
        expect(closed.syncError).toContain('EIO')

        // The close really happened — that is what rule 1b rests on.
        expect(await typesIn(closed.filePath)).toEqual(['session.started', 'collector.error', 'session.closed'])
        // …and the recorder is still sealed, because only `openSession` may
        // release a seal the close earned.
        expect(recorder.isSealed).toBe(true)

        // 1b-ii: the lock guards a LIVE session, and this one is not live.
        expect(await locksIn(dir)).toEqual([])
        expect(await readSessionLock(dir, FIRST)).toBeNull()
      } finally {
        sync.mockRestore()
      }
    })

    it('still throws when the closing APPEND fails — that is rule 1a, and the close did not happen', async () => {
      clock = 5000
      const append = vi
        .spyOn(SessionLogWriter.prototype, 'append')
        .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
      try {
        // Absorbing EVERY close error would hide the case where nothing
        // reached the file at all. Only `CloseNotDurableError` is absorbed.
        await expect(closeCurrentSession(options())).rejects.toThrow('ENOSPC')
        // The recorder released its own seal (rule 1a), and the session is
        // still live: no close line, and its lock is untouched.
        expect(recorder.isSealed).toBe(false)
        expect(await typesIn(sessionFilePath(dir, FIRST))).toEqual(['session.started', 'collector.error'])
        expect(await readSessionLock(dir, FIRST)).not.toBeNull()
      } finally {
        append.mockRestore()
      }
    })

    it('the whole rotation completes — the wedge #80 named is gone', async () => {
      clock = 5000
      const sync = vi.spyOn(SessionLogWriter.prototype, 'sync').mockRejectedValueOnce(new Error(FSYNC_FAILED))
      try {
        // Before #80 this promise never settled: the seal was held with
        // nothing alive to release it. The explicit timeout is the point — a
        // regression must fail this test, not stall the suite.
        const rotation = await rotateSession(options())

        expect(rotation.closed.synced).toBe(false)
        expect(rotation.closed.syncError).toContain('EIO')
        expect(rotation.opened.sessionId).toBe('5000')
        // `openSession` released the seal, so the recorder records again.
        expect(recorder.isSealed).toBe(false)
        expect(recorder.sessionId).toBe('5000')

        const before = await typesIn(sessionFilePath(dir, FIRST))
        await expect(recorder.record(errorEvent('evt-after', 6000, 'after'))).resolves.toBeUndefined()
        // The defect, at the level the operator actually meets it: the closed
        // log is byte-for-byte what it was, and the event went to the new one.
        expect(await typesIn(sessionFilePath(dir, FIRST))).toEqual(before)
        expect(before).toEqual(['session.started', 'collector.error', 'session.closed'])
        expect(await typesIn(sessionFilePath(dir, '5000'))).toEqual(['session.started', 'collector.error'])
      } finally {
        sync.mockRestore()
      }
    }, 5000)
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

describe('retargetSession (prd20 ruling 5)', () => {
  const OLD_REPO_PATH = '/repo/old-watched'
  const NEW_REPO_PATH = '/repo/new-watched'

  let oldDir: string
  let newDir: string
  let recorder: SessionRecorder
  let clock: number

  beforeEach(async () => {
    oldDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-retarget-old-test-'))
    newDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-retarget-new-test-'))
    clock = Number(FIRST)
    recorder = new SessionRecorder(FIRST, sessionFilePath(oldDir, FIRST))
    await recorder.record(
      createEvent(
        'session.started',
        { sessionId: FIRST, repoPath: OLD_REPO_PATH, repoName: 'old-watched' },
        { id: 'evt-000001', ts: clock },
      ),
    )
    await writeSessionLock(oldDir, FIRST, process.pid, clock)
  })

  afterEach(async () => {
    await Promise.all([rm(oldDir, { recursive: true, force: true }), rm(newDir, { recursive: true, force: true })])
  })

  function options() {
    return {
      oldSessionDir: oldDir,
      oldRepoPath: OLD_REPO_PATH,
      newSessionDir: newDir,
      newRepoPath: NEW_REPO_PATH,
      newRepoName: 'new-watched',
      recorder,
      now: () => clock,
      pid: process.pid,
    }
  }

  it('closes the old log with reason "retargeted" and a successor pointer at the new slug', async () => {
    clock = 5000
    await retargetSession(options())

    const closed = await readSessionEvents(sessionFilePath(oldDir, FIRST))
    expect(closed.at(-1)).toMatchObject({
      type: 'session.closed',
      payload: {
        sessionId: FIRST,
        reason: 'retargeted',
        successor: { repoSlug: repoSlug(NEW_REPO_PATH) },
      },
    })
  })

  it('opens the new log naming the new repo, with a predecessor pointer at the old slug and exact session id', async () => {
    clock = 5000
    const rotation = await retargetSession(options())

    const opened = await readSessionEvents(rotation.opened.filePath)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      type: 'session.started',
      payload: {
        sessionId: rotation.opened.sessionId,
        repoPath: NEW_REPO_PATH,
        repoName: 'new-watched',
        predecessor: { repoSlug: repoSlug(OLD_REPO_PATH), sessionId: FIRST },
      },
    })
  })

  it('moves the lock to the NEW directory only — nothing left behind in the old one', async () => {
    clock = 5000
    const rotation = await retargetSession(options())

    expect(await readSessionLock(oldDir, FIRST)).toBeNull()
    expect(await readSessionLock(newDir, rotation.opened.sessionId)).toEqual({
      pid: process.pid,
      heartbeatMs: 5000,
    })
  })

  it('closes first, then opens — a retarget observes the same crash ordering as a rotation', async () => {
    clock = 5000
    const closed = await closeCurrentSession({
      sessionDir: oldDir,
      recorder,
      now: () => clock,
      reason: 'retargeted',
      successor: { repoSlug: repoSlug(NEW_REPO_PATH) },
    })

    // Exactly the state a crash between the two halves leaves behind: no live
    // lock anywhere, and the old log already ended.
    expect(await readSessionLock(oldDir, FIRST)).toBeNull()
    expect((await readSessionEvents(closed.filePath)).at(-1)?.type).toBe('session.closed')

    await openNextSession(
      {
        sessionDir: newDir,
        repoPath: NEW_REPO_PATH,
        repoName: 'new-watched',
        recorder,
        now: () => clock,
        predecessor: { repoSlug: repoSlug(OLD_REPO_PATH), sessionId: closed.sessionId },
      },
      closed,
    )
    expect(await readSessionLock(newDir, recorder.sessionId)).not.toBeNull()
  })

  /**
   * THE SIBLING CASE for #80. `performRetarget` is `closeCurrentSession` then
   * `openNextSession` — structurally identical to `rotateSession`, a different
   * entry point. Neither function needed editing for rule 1b: once the close
   * half stops throwing on a sync failure, the open half runs on its own. But
   * "correct by construction" is a claim, and a fix proven only through
   * `rotateSession` leaves this door wedging with nothing going red.
   */
  it('performRetarget completes through a failed fsync too — the sibling of the rotation wedge', async () => {
    clock = 5000
    const sync = vi.spyOn(SessionLogWriter.prototype, 'sync').mockRejectedValueOnce(new Error(FSYNC_FAILED))
    try {
      const rotation = await performRetarget(options())

      expect(rotation.closed.synced).toBe(false)
      expect(rotation.closed.syncError).toContain('EIO')
      // The new session is open in the NEW repo's directory, seal released.
      expect(rotation.opened.filePath).toBe(sessionFilePath(newDir, '5000'))
      expect(recorder.isSealed).toBe(false)
      expect(recorder.sessionId).toBe('5000')

      // And nothing lands behind the old log's `session.closed`.
      const before = await typesIn(sessionFilePath(oldDir, FIRST))
      expect(before).toEqual(['session.started', 'session.closed'])
      await expect(recorder.record(errorEvent('evt-after', 6000, 'after'))).resolves.toBeUndefined()
      expect(await typesIn(sessionFilePath(oldDir, FIRST))).toEqual(before)
      expect(await typesIn(sessionFilePath(newDir, '5000'))).toEqual(['session.started', 'collector.error'])
    } finally {
      sync.mockRestore()
    }
  }, 5000)

  /**
   * The sibling case: `closeCurrentSession`/`openNextSession` grew optional
   * overrides so `retargetSession` could reuse them — `rotateSession`'s own
   * calls pass none, and must therefore see exactly the behaviour they saw
   * before this issue touched the module. A `toMatchObject` alone would not
   * catch a leaked `successor`/`predecessor` (it ignores extra keys), so this
   * asserts their absence directly.
   */
  it("rotateSession is unaffected by the new overrides — still 'rotated', no successor/predecessor", async () => {
    clock = 5000
    const rotation = await rotateSession({
      sessionDir: oldDir,
      repoPath: OLD_REPO_PATH,
      repoName: 'old-watched',
      recorder,
      now: () => clock,
      pid: process.pid,
    })

    const closed = await readSessionEvents(sessionFilePath(oldDir, FIRST))
    expect(closed.at(-1)?.payload).toMatchObject({ reason: 'rotated' })
    expect(closed.at(-1)?.payload).not.toHaveProperty('successor')

    const opened = await readSessionEvents(rotation.opened.filePath)
    expect(opened[0]?.payload).not.toHaveProperty('predecessor')
  })

  describe('the shared in-flight guard (#14)', () => {
    it('a second concurrent retarget is REFUSED, not coalesced — one boundary, one session directory', async () => {
      clock = 5000
      const settled = await Promise.allSettled([retargetSession(options()), retargetSession(options())])

      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const refusals = settled.filter(isRejected)
      expect(refusals).toHaveLength(1)
      expect(refusals[0]?.reason).toBeInstanceOf(RetargetInFlightError)

      // The loser never touched either directory: one close, one open, never two.
      expect((await readdir(oldDir)).filter((n) => n.endsWith('.jsonl'))).toEqual([sessionFileName(Number(FIRST))])
      expect((await readdir(newDir)).filter((n) => n.endsWith('.jsonl'))).toHaveLength(1)
    })

    it('refuses a retarget while a rotation on the same recorder is still running', async () => {
      clock = 5000
      const rotation = rotateSession({
        sessionDir: oldDir,
        repoPath: OLD_REPO_PATH,
        repoName: 'old-watched',
        recorder,
        now: () => clock,
        pid: process.pid,
      })

      await expect(retargetSession(options())).rejects.toBeInstanceOf(RetargetInFlightError)
      await rotation
    })

    it('a rotation asked while a retarget is in flight REFUSES rather than being handed the retarget\'s boundary (#49, prd-42 ruling 5)', async () => {
      clock = 5000
      const retarget = retargetSession(options())

      // rotateSession REJECTS (not a synchronous throw — see this module's
      // own doc comment on why the two doors into this guard must agree on
      // error shape) instead of coalescing. Coalescing would have handed the
      // caller a `Rotation` whose `closed.reason` is `'retargeted'` and whose
      // `opened` session is in a DIFFERENT repo than the one this call asked
      // to rotate, at status 200 — a known hazard, not the desirable
      // behaviour the old assertion here used to pin.
      await expect(
        rotateSession({
          sessionDir: oldDir,
          repoPath: OLD_REPO_PATH,
          repoName: 'old-watched',
          recorder,
          now: () => clock,
          pid: process.pid,
        }),
      ).rejects.toBeInstanceOf(RotationRefusedError)

      await retarget
      // The retarget still ran, untouched by the refused rotation — one
      // close, one open on the old side.
      expect((await readdir(oldDir)).filter((n) => n.endsWith('.jsonl'))).toEqual([sessionFileName(Number(FIRST))])
    })

    it('refuses a rotation when the in-flight slot holds a THIRD kind nobody has written yet — fail-closed by default, not by name', async () => {
      clock = 5000
      // Neither `rotateSession` nor `retargetSession` can ever produce this
      // kind — it stands in for a caller this map has never had, so this
      // test would still catch a regression to `kind === 'retarget'` (which
      // only refuses the ONE non-rotation kind it was written against) even
      // though that regression would pass every other test in this file. The
      // literal itself is arbitrary and unrelated to any real or previously
      // proposed operation — what matters is that it is neither 'rotation'
      // nor 'retarget'.
      const release = reserveInFlightForTest(recorder, 'some-future-operation-kind')

      await expect(
        rotateSession({
          sessionDir: oldDir,
          repoPath: OLD_REPO_PATH,
          repoName: 'old-watched',
          recorder,
          now: () => clock,
          pid: process.pid,
        }),
      ).rejects.toBeInstanceOf(RotationRefusedError)

      release()
      // Nothing was touched: the reserved (fake) boundary never ran a
      // close/open, and releasing it leaves the map free for the next test.
      expect((await readdir(oldDir)).filter((n) => n.endsWith('.jsonl'))).toEqual([sessionFileName(Number(FIRST))])
    })
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
