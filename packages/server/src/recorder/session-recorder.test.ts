import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RhizomorphEvent } from '@rhizomorph/core'
import * as core from '@rhizomorph/core'
import { createEvent, createEventFactory, EVENT_TYPES, initialSessionState, reduceAll } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeSessionLock } from '../log/session-lock.js'
import { sessionFilePath } from '../log/session-log.js'
import { rotateSession } from './rotate.js'
import { SessionLogWriter } from './session-log-writer.js'
import {
  CloseNotDurableError,
  COMPACT_AFTER_EVICTED,
  MAX_BUFFERED_EVENTS,
  SessionRecorder,
} from './session-recorder.js'

const FIRST = '1000'

/**
 * Every line of a log, in order, by type. The WHOLE sequence — never
 * `lines.at(-1)`: "`session.closed` is the last line" is a claim about the
 * file, and a last-line check passes on a file that ended two lines early
 * (`a6dddfd`, review of #105).
 */
function lineTypes(filePath: string): string[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => String((JSON.parse(line) as { type: string }).type))
}

/** Structural fallback: the fold is a fresh object per event, so identity cannot be the check mid-emit. */
function deepEqualFold(r: SessionRecorder): boolean {
  return JSON.stringify(r.foldSoFar()) === JSON.stringify(reduceAll(r.eventsSoFar()))
}

describe('SessionRecorder#closeWith', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-test-'))
    recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('releases the seal instead of hanging forever when the closing write fails', async () => {
    const closeEvent = createEvent(
      'session.closed',
      { sessionId: FIRST, reason: 'rotated', eventCount: 1 },
      { id: `session-closed-${FIRST}`, ts: 1000 },
    )
    vi.spyOn(SessionLogWriter.prototype, 'append').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))

    await expect(recorder.closeWith(closeEvent)).rejects.toThrow('ENOSPC')
    expect(recorder.isSealed).toBe(false)

    // A record() call after a failed close must resolve promptly, not hang
    // forever on a seal nobody released.
    await expect(
      recorder.record(createEvent('collector.error', { collector: 'git', message: 'boom' }, { id: 'evt-2', ts: 1001 })),
    ).resolves.toBeUndefined()
  })

  /**
   * THE #80 LAW — prd40 ruling 1's fifth amendment, rule 1b.
   *
   * A session is closed the instant its `session.closed` line is appended;
   * durability is a separate, later property. So a `sync()` that fails AFTER a
   * successful append must NOT release the seal — the line is in the file, and
   * prd17 ruling 1's "it is the last line" is now owed.
   *
   * It mocks `sync`, deliberately, and that is the whole point. The seal law
   * above mocks `append`, and #4's durable-close law throws from a subscriber;
   * neither can see this. A variant of THIS test that rejected `append`
   * instead was run against the unfixed code and passed — vacuously, because
   * a failed append leaves no `session.closed` for anything to land behind.
   */
  it('holds the seal when the append lands but the fsync fails — nothing may follow `session.closed`', async () => {
    await recorder.record(
      createEvent('collector.error', { collector: 'git', message: 'before' }, { id: 'evt-1', ts: 999 }),
    )
    const closeEvent = createEvent(
      'session.closed',
      { sessionId: FIRST, reason: 'rotated', eventCount: 2 },
      { id: `session-closed-${FIRST}`, ts: 1000 },
    )
    vi.spyOn(SessionLogWriter.prototype, 'sync').mockRejectedValueOnce(new Error('EIO: i/o error, fsync'))

    // It rejects — losing durability is a fact the operator must learn — and it
    // rejects with a TYPE, because `closeCurrentSession` has to tell 1b from 1a
    // and a message is not an API.
    await expect(recorder.closeWith(closeEvent)).rejects.toBeInstanceOf(CloseNotDurableError)
    expect(recorder.isSealed).toBe(true)

    // The defect, closed: a later `record()` must not reach the file. It parks
    // on the seal instead — which is safe precisely because reopening is now
    // unconditional (`closeCurrentSession` absorbs this rejection).
    let settled = false
    const queued = recorder
      .record(createEvent('collector.error', { collector: 'git', message: 'after' }, { id: 'evt-3', ts: 1001 }))
      .then(() => {
        settled = true
      })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)

    expect(lineTypes(sessionFilePath(dir, FIRST))).toEqual(['collector.error', 'session.closed'])

    const SECOND = '2000'
    recorder.openSession(SECOND, sessionFilePath(dir, SECOND))
    await queued
    // And it landed in the NEW session, not behind the closed log's last line.
    expect(lineTypes(sessionFilePath(dir, FIRST))).toEqual(['collector.error', 'session.closed'])
    expect(lineTypes(sessionFilePath(dir, SECOND))).toEqual(['collector.error'])
  })

  it('a subscriber throwing after a durable close neither fails the close nor reopens the log', async () => {
    const closeEvent = createEvent(
      'session.closed',
      { sessionId: FIRST, reason: 'rotated', eventCount: 1 },
      { id: `session-closed-${FIRST}`, ts: 1000 },
    )
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unsubscribe = recorder.subscribe(() => {
      throw new Error('subscriber boom')
    })

    // The close DID happen, so it must not reject: `rotate.ts` reaches
    // `removeSessionLock` and `openSession` only when this resolves, and a
    // rejection here would strand the seal with nothing alive to release it.
    await expect(recorder.closeWith(closeEvent)).resolves.toBeUndefined()
    expect(reported).toHaveBeenCalledWith(expect.stringContaining('subscriber boom'))
    // And the seal STAYS: releasing it would let the record() below append
    // behind `session.closed`, which prd17 ruling 1 makes structural.
    expect(recorder.isSealed).toBe(true)
    unsubscribe()

    let settled = false
    const queued = recorder
      .record(createEvent('collector.error', { collector: 'git', message: 'boom' }, { id: 'evt-2', ts: 1001 }))
      .then(() => {
        settled = true
      })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)

    const SECOND = '2000'
    recorder.openSession(SECOND, sessionFilePath(dir, SECOND))
    await queued
    expect(settled).toBe(true)
  })

  it('a rejected closing append advances neither the buffer nor the fold', async () => {
    const closeEvent = createEvent(
      'session.closed',
      { sessionId: FIRST, reason: 'rotated', eventCount: 1 },
      { id: `session-closed-${FIRST}`, ts: 1000 },
    )
    vi.spyOn(SessionLogWriter.prototype, 'append').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))

    await expect(recorder.closeWith(closeEvent)).rejects.toThrow('ENOSPC')
    expect(recorder.eventsSoFar()).toEqual([])
    expect(recorder.foldSoFar()).toEqual(initialSessionState())
  })

  it('puts the close event on disk before any subscriber is told about it', async () => {
    const closeEvent = createEvent(
      'session.closed',
      { sessionId: FIRST, reason: 'rotated', eventCount: 1 },
      { id: `session-closed-${FIRST}`, ts: 1000 },
    )
    let onDiskWhenNotified = ''
    const unsubscribe = recorder.subscribe(() => {
      onDiskWhenNotified = readFileSync(sessionFilePath(dir, FIRST), 'utf8')
    })

    await recorder.closeWith(closeEvent)
    unsubscribe()

    expect(onDiskWhenNotified).toContain(`session-closed-${FIRST}`)
  })

  it('leaves the whole rotation able to finish when a subscriber throws', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    await recorder.record(createEvent('collector.error', { collector: 'git', message: 'x' }, { id: 'e1', ts: 1 }))
    await writeSessionLock(dir, FIRST, process.pid, 1000)
    recorder.subscribe((event) => {
      if (event.type === 'session.closed') throw new Error('subscriber boom')
    })

    // The real rotation, not a hand-driven recorder: closeCurrentSession →
    // removeSessionLock → openNextSession. `openSession` is the ONLY thing that
    // can release a seal the close earned, and it lives in the half that never
    // runs if closeWith rejects — so a rejection here strands the seal with
    // nothing alive to release it, every later record() parks forever on the
    // seal wait, `runTick` never returns and the poll loop stops silently.
    await expect(
      rotateSession({
        sessionDir: dir,
        repoPath: '/repo',
        repoName: 'repo',
        recorder,
        now: () => 5000,
        pid: 1,
        claudeProjectsRoot: path.join(dir, 'nope'),
      }),
    ).resolves.toBeDefined()

    expect(reported).toHaveBeenCalledWith(expect.stringContaining('subscriber boom'))
    expect(recorder.isSealed).toBe(false)
    await expect(
      recorder.record(createEvent('collector.error', { collector: 'git', message: 'after' }, { id: 'e2', ts: 2 })),
    ).resolves.toBeUndefined()
  })
})

describe('SessionRecorder#record — the append precedes every publish (prd40 ruling 1)', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-test-'))
    recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  const anEvent = (id: string, message: string) =>
    createEvent('collector.error', { collector: 'git', message }, { id, ts: 1000 })

  it('publishes nothing when the append is rejected, with a live subscriber attached', async () => {
    const seen: RhizomorphEvent[] = []
    const unsubscribe = recorder.subscribe((event) => {
      seen.push(event)
    })
    vi.spyOn(SessionLogWriter.prototype, 'append').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))

    await expect(recorder.record(anEvent('evt-1', 'boom'))).rejects.toThrow('ENOSPC')
    unsubscribe()

    // All three publishes, not two: the subscriber, the buffer, and the fold.
    expect(seen).toEqual([])
    expect(recorder.eventsSoFar()).toEqual([])
    expect(recorder.foldSoFar()).toEqual(initialSessionState())
  })

  it('publishes to the buffer, the fold and the subscriber once the append resolves', async () => {
    const seen: RhizomorphEvent[] = []
    const unsubscribe = recorder.subscribe((event) => {
      seen.push(event)
    })
    const event = anEvent('evt-1', 'boom')

    await recorder.record(event)
    unsubscribe()

    expect(seen).toEqual([event])
    expect(recorder.eventsSoFar()).toEqual([event])
    expect(recorder.foldSoFar()).toEqual(reduceAll([event]))
  })

  it("keeps the buffer in the log's own order when two callers race", async () => {
    const a = anEvent('evt-a', 'a')
    const b = anEvent('evt-b', 'b')

    // Both issued before either is awaited: the writer's `tail` chain is what
    // makes the resolution order the call order, and therefore makes the
    // buffer agree with the file. A non-FIFO writer would break both at once.
    await Promise.all([recorder.record(a), recorder.record(b)])

    expect(recorder.eventsSoFar().map((event) => event.id)).toEqual(['evt-a', 'evt-b'])
    const lines = readFileSync(sessionFilePath(dir, FIRST), 'utf8').trimEnd().split('\n')
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(['evt-a', 'evt-b'])
  })

  it('does not publish into the next session when a rotation lands mid-append', async () => {
    let releaseAppend: () => void = () => {}
    vi.spyOn(SessionLogWriter.prototype, 'append').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseAppend = resolve
        }),
    )
    const seen: RhizomorphEvent[] = []
    const unsubscribe = recorder.subscribe((event) => {
      seen.push(event)
    })

    const pending = recorder.record(anEvent('evt-1', 'boom'))
    // The rotation closes this session and opens the next one while record()
    // is parked on its append — the suspension point this issue introduced.
    const SECOND = '2000'
    recorder.openSession(SECOND, sessionFilePath(dir, SECOND))
    releaseAppend()
    await pending
    unsubscribe()

    // The event is durable in the file it was appended to. What it must not do
    // is contaminate the session that has since opened.
    expect(recorder.eventsSoFar()).toEqual([])
    expect(recorder.foldSoFar()).toEqual(initialSessionState())
    expect(seen).toEqual([])
  })
})

describe('SessionRecorder#recordAlarm — the one named exception (prd40 success 1, ADR-0030)', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-alarm-test-'))
    recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  const anAlarm = (id: string, message: string) =>
    createEvent('collector.error', { collector: 'git', message }, { id, ts: 1000 })

  it('is record()s own path when the append succeeds — disk, buffer, fold and subscriber', async () => {
    const seen: RhizomorphEvent[] = []
    const unsubscribe = recorder.subscribe((event) => {
      seen.push(event)
    })
    const alarm = anAlarm('evt-1', 'boom')

    await expect(recorder.recordAlarm(alarm)).resolves.toEqual({ appended: true })
    unsubscribe()

    expect(readFileSync(sessionFilePath(dir, FIRST), 'utf8')).toContain('evt-1')
    expect(recorder.eventsSoFar()).toEqual([alarm])
    expect(recorder.foldSoFar()).toEqual(reduceAll([alarm]))
    expect(seen).toEqual([alarm])
  })

  it('emits to subscribers on a rejected append, and advances neither buffer nor fold', async () => {
    // The load-bearing law. The emit is the exemption prd-40 success 1 names by
    // event type; the untouched buffer and fold are the half that is NOT
    // exempted — "leaves the fold ahead of the file after a rejected append"
    // is still forbidden, alarm or not.
    const before = { events: recorder.eventsSoFar(), fold: recorder.foldSoFar() }
    const seen: RhizomorphEvent[] = []
    const unsubscribe = recorder.subscribe((event) => {
      seen.push(event)
    })
    vi.spyOn(SessionLogWriter.prototype, 'append').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
    const alarm = anAlarm('evt-1', 'boom')

    await expect(recorder.recordAlarm(alarm)).resolves.toEqual({ appended: false })
    unsubscribe()

    expect(seen).toEqual([alarm])
    expect(recorder.eventsSoFar()).toEqual(before.events)
    expect(recorder.foldSoFar()).toEqual(before.fold)
    expect(recorder.eventsSoFar()).toEqual([])
    expect(recorder.foldSoFar()).toEqual(initialSessionState())
  })

  it('never rejects, where record() on the same failure does', async () => {
    vi.spyOn(SessionLogWriter.prototype, 'append').mockRejectedValue(new Error('ENOSPC: no space left on device'))

    await expect(recorder.recordAlarm(anAlarm('evt-1', 'boom'))).resolves.toEqual({ appended: false })
    // The contrast is the point: `record`'s own law (same failure, same file)
    // still says the caller learns by rejection. Only the alarm is exempt.
    await expect(recorder.record(anAlarm('evt-2', 'boom'))).rejects.toThrow('ENOSPC')
  })

  it('a throwing subscriber cannot silence the alarm', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: RhizomorphEvent[] = []
    // Registered BEFORE the thrower, which is all this law ever claimed: it
    // pins the CALLER's survival. It used to be all that was available —
    // `EventEmitter.emit` abandons the listener list at the first throw — but
    // #106 moved the guard to `subscribe` and closed that hole, so delivery to
    // listeners queued BEHIND a broken one is now its own law at the foot of
    // this file. Assertions here are unchanged; only this note is.
    const unsubscribeGood = recorder.subscribe((event) => {
      seen.push(event)
    })
    const unsubscribeBad = recorder.subscribe(() => {
      throw new Error('subscriber boom')
    })
    vi.spyOn(SessionLogWriter.prototype, 'append').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
    const alarm = anAlarm('evt-1', 'boom')

    await expect(recorder.recordAlarm(alarm)).resolves.toEqual({ appended: false })
    unsubscribeGood()
    unsubscribeBad()

    expect(seen).toEqual([alarm])
    expect(reported).toHaveBeenCalledWith(expect.stringContaining('subscriber boom'))
  })

  it('emits every repeat of a failing alarm, and the buffer and fold never grow', async () => {
    const seen: RhizomorphEvent[] = []
    const unsubscribe = recorder.subscribe((event) => {
      seen.push(event)
    })
    vi.spyOn(SessionLogWriter.prototype, 'append').mockRejectedValue(new Error('ENOSPC: no space left on device'))

    for (const id of ['evt-1', 'evt-2', 'evt-3']) {
      await expect(recorder.recordAlarm(anAlarm(id, 'boom'))).resolves.toEqual({ appended: false })
      // Checked after EVERY alarm, not once at the end: a fold that drifts on
      // the second one is invisible to a single trailing assertion.
      expect(recorder.eventsSoFar()).toHaveLength(0)
      expect(recorder.foldSoFar()).toEqual(initialSessionState())
    }
    unsubscribe()

    expect(seen.map((event) => event.id)).toEqual(['evt-1', 'evt-2', 'evt-3'])
  })

  it('cannot be reached by any event but collector.error — asserted by name, enforced by tsc', async () => {
    const notAnAlarm = createEvent(
      'worktree.discovered',
      { path: '/repo/rhizomorph', branch: 'main', head: 'a'.repeat(40), isMain: true },
      { id: 'evt-1', ts: 1000 },
    )

    // prd-40 success 1: the exemption is "asserted BY NAME in the law rather
    // than inferred from a category, and no collector-derived event may carry
    // it". The parameter type is what makes that structural — if the directive
    // below ever reports as unused, the narrowing has been widened and the
    // exemption is no longer asserted by name. (Prose here deliberately avoids
    // spelling the directive out: tsc reads any comment line containing it as
    // one, and a second, satisfied directive would mask the first going stale.)
    // @ts-expect-error — recordAlarm accepts EventOf<'collector.error'> only.
    await expect(recorder.recordAlarm(notAnAlarm)).resolves.toEqual({ appended: true })
  })

  // The three laws below pin `recordAlarm`s two concurrency guards. Both are
  // copied from `record`, whose own guard has been held by a law since the
  // suspension point was introduced ("does not publish into the next session
  // when a rotation lands mid-append", above) — but the copies shipped
  // unasserted: deleting BOTH left the whole suite green (6594 passed).
  // `recordAlarm` is the one method allowed to publish without appending, so
  // it is the last one whose rotation and seal behaviour should rest on
  // reading the source.

  it('parks in the sealed window rather than appending behind session.closed (prd17 ruling 1)', async () => {
    await recorder.closeWith(
      createEvent('session.closed', { sessionId: FIRST, reason: 'rotated', eventCount: 1 }, { id: 'session-closed-1000', ts: 1000 }),
    )
    let settled = false
    const pending = recorder.recordAlarm(anAlarm('evt-1', 'boom')).then((result) => {
      settled = true
      return result
    })
    // Macrotask turn: the seal is a promise only `openSession` resolves, so no
    // number of turns can let this through while the window is open.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(settled).toBe(false)
    // The exemption is about publishing, never about writing behind a closed
    // log — prd17 ruling 1's structural guarantee is not one of the clauses
    // ADR-0030 carves out.
    // The whole file, not its last line: indexing would need a bounds check to
    // typecheck, and asserting the entire sequence is the stronger claim anyway
    // — it says the alarm is not in this log AT ALL, not merely not last.
    const closed = readFileSync(sessionFilePath(dir, FIRST), 'utf8').trimEnd().split('\n')
    expect(closed.map((line) => JSON.parse(line).type)).toEqual(['session.closed'])

    const SECOND = '2000'
    recorder.openSession(SECOND, sessionFilePath(dir, SECOND))

    await expect(pending).resolves.toEqual({ appended: true })
    expect(readFileSync(sessionFilePath(dir, SECOND), 'utf8')).toContain('evt-1')
  })

  it('does not publish into the next session when a rotation lands mid-append', async () => {
    let releaseAppend: () => void = () => {}
    vi.spyOn(SessionLogWriter.prototype, 'append').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseAppend = resolve
        }),
    )
    const seen: RhizomorphEvent[] = []
    const unsubscribe = recorder.subscribe((event) => {
      seen.push(event)
    })

    const pending = recorder.recordAlarm(anAlarm('evt-1', 'boom'))
    const SECOND = '2000'
    recorder.openSession(SECOND, sessionFilePath(dir, SECOND))
    releaseAppend()

    await expect(pending).resolves.toEqual({ appended: true })
    unsubscribe()

    // Durable in the log it was appended to, and absent from the session that
    // has since opened — buffer, fold AND subscribers, exactly as `record`.
    expect(recorder.eventsSoFar()).toEqual([])
    expect(recorder.foldSoFar()).toEqual(initialSessionState())
    expect(seen).toEqual([])
  })

  it('still speaks when a rotation lands mid-append and the append failed', async () => {
    // The asymmetry with the law above, and the reason the guard sits INSIDE
    // `if (appended)` rather than above it: a rotation racing the alarm is not
    // a reason to silence it. Nothing entered the buffer or the fold, so there
    // is nothing to pollute the new session with.
    let rejectAppend: (error: Error) => void = () => {}
    vi.spyOn(SessionLogWriter.prototype, 'append').mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAppend = reject
        }),
    )
    const seen: RhizomorphEvent[] = []
    const unsubscribe = recorder.subscribe((event) => {
      seen.push(event)
    })
    const alarm = anAlarm('evt-1', 'boom')

    const pending = recorder.recordAlarm(alarm)
    const SECOND = '2000'
    recorder.openSession(SECOND, sessionFilePath(dir, SECOND))
    rejectAppend(new Error('ENOSPC: no space left on device'))

    await expect(pending).resolves.toEqual({ appended: false })
    unsubscribe()

    expect(seen).toEqual([alarm])
    expect(recorder.eventsSoFar()).toEqual([])
    expect(recorder.foldSoFar()).toEqual(initialSessionState())
  })
})

describe('SessionRecorder — maintained fold (prd40 ruling 2)', () => {
  let dir: string
  let recorder: SessionRecorder
  let f: ReturnType<typeof createEventFactory>

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-fold-test-'))
    recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST))
    f = createEventFactory()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('starts at the initial fold for a fresh session', () => {
    expect(recorder.foldSoFar()).toEqual(initialSessionState())
  })

  it('advances through record(), matching reduceAll(eventsSoFar()) after every event', async () => {
    const events = [
      f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }),
      f.branchUpdated({ branch: 'main', head: 'a'.repeat(40) }),
      f.worktreeDiscovered({ path: '/repo/rhizomorph-wt/feature', branch: 'feature', isMain: false }),
    ]
    for (const event of events) {
      await recorder.record(event)
      expect(recorder.foldSoFar()).toEqual(reduceAll(recorder.eventsSoFar()))
    }
  })

  it('advances through closeWith() too — the sibling publisher record() has', async () => {
    await recorder.record(f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }))
    await recorder.closeWith(f.sessionClosed({ sessionId: FIRST, reason: 'rotated', eventCount: 1 }))
    expect(recorder.foldSoFar()).toEqual(reduceAll(recorder.eventsSoFar()))
  })

  it('resets in openSession(), in step with the buffer — old session events are gone from both', async () => {
    await recorder.record(f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }))
    await recorder.closeWith(f.sessionClosed({ sessionId: FIRST, reason: 'rotated', eventCount: 1 }))

    const SECOND = '2000'
    recorder.openSession(SECOND, sessionFilePath(dir, SECOND))
    expect(recorder.foldSoFar()).toEqual(initialSessionState())

    const next = f.worktreeDiscovered({ path: '/repo/other', branch: 'main', isMain: true })
    await recorder.record(next)
    expect(recorder.foldSoFar()).toEqual(reduceAll([next]))
  })

  it('starts consistent with a resumed buffer', () => {
    const resumeFrom = [
      f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }),
      f.branchUpdated({ branch: 'main', head: 'b'.repeat(40) }),
    ]
    const resumed = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST), { resumeFrom })
    expect(resumed.foldSoFar()).toEqual(reduceAll(resumeFrom))
    resumed.eventsSoFar() // sanity: buffer was preloaded too
    expect(resumed.eventsSoFar()).toEqual(resumeFrom)
  })

  it('repetition: reading foldSoFar() three times in a row never changes the answer', async () => {
    await recorder.record(f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }))
    const first = recorder.foldSoFar()
    const second = recorder.foldSoFar()
    const third = recorder.foldSoFar()
    expect(first).toEqual(second)
    expect(second).toEqual(third)
  })

  it('a throwing reduce() is absorbed: record() still resolves, and foldSoFar() self-heals on the next read', async () => {
    await recorder.record(f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }))
    const spy = vi.spyOn(core, 'reduce').mockImplementationOnce(() => {
      throw new Error('reduce boom')
    })
    const poisoned = f.branchUpdated({ branch: 'main', head: 'c'.repeat(40) })
    await expect(recorder.record(poisoned)).resolves.toBeUndefined()
    spy.mockRestore()

    // eventsSoFar() already has both events; foldSoFar() must catch up.
    expect(recorder.eventsSoFar()).toHaveLength(2)
    expect(recorder.foldSoFar()).toEqual(reduceAll(recorder.eventsSoFar()))

    // and it keeps working correctly afterward, repeated once more.
    const after = f.worktreeDiscovered({ path: '/repo/rhizomorph-wt/x', branch: 'x', isMain: false })
    await recorder.record(after)
    expect(recorder.foldSoFar()).toEqual(reduceAll(recorder.eventsSoFar()))
  })
})

describe('SessionRecorder — the fold handed out is frozen (#69, ADR-0031)', () => {
  let dir: string
  let recorder: SessionRecorder
  let f: ReturnType<typeof createEventFactory>

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-freeze-test-'))
    recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST))
    f = createEventFactory()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('a caller cannot corrupt the fold with a top-level write — it throws, and the fold stays correct', async () => {
    // The defect this issue closes. `reduceAll()` hands every caller a PRIVATE
    // fold, so a mutation there corrupts only that caller. `foldSoFar()` hands
    // out the recorder's ONLY fold, and `foldDesynced` is raised only when
    // `reduce` throws — never when a caller writes. So without the freeze the
    // corruption is silent and permanent for the life of the session.
    await recorder.record(f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }))
    const folded = recorder.foldSoFar()

    // Test files are ESM and therefore strict mode: the write throws rather
    // than failing silently, which is what makes this assertable at all.
    expect(() => {
      folded.eventCount = 999
    }).toThrow(TypeError)

    // And the fold the recorder still answers with is the correct one.
    expect(recorder.foldSoFar().eventCount).not.toBe(999)
    expect(recorder.foldSoFar()).toEqual(reduceAll(recorder.eventsSoFar()))
  })

  it('a caller cannot corrupt the fold with a NESTED write either — the walk is deep', async () => {
    // The sibling of the law above, and the reason the freeze recurses. This is
    // exactly the mutation a `Readonly<SessionState>` return type would have
    // let through: shallow readonly stops `folded.branches = {}` and says
    // nothing about `folded.branches.main.head`.
    await recorder.record(f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }))
    await recorder.record(f.branchUpdated({ branch: 'main', head: 'a'.repeat(40) }))

    const branch = recorder.foldSoFar().branches.main
    if (!branch) throw new Error('the fixture must create a branch for this law to mean anything')
    expect(branch.head).toBe('a'.repeat(40))

    expect(() => {
      branch.head = 'd'.repeat(40)
    }).toThrow(TypeError)

    expect(recorder.foldSoFar().branches.main?.head).toBe('a'.repeat(40))
    expect(recorder.foldSoFar()).toEqual(reduceAll(recorder.eventsSoFar()))
  })

  it('the freeze did NOT become a copy — reads still return the same object', async () => {
    // The constraint that rules copy-on-read out. #3's identity law is what
    // makes "no re-fold on any route" hold however a caller reaches the fold;
    // a defensive copy would satisfy immutability and destroy it, and would
    // reintroduce the per-read cost growing with session length that prd-40
    // ruling 2 removed.
    await recorder.record(f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }))
    const first = recorder.foldSoFar()
    expect(recorder.foldSoFar()).toBe(first)
    expect(recorder.foldSoFar()).toBe(first)
  })

  it('EVERY path that sets the fold yields a frozen one — constructor, record, self-heal, openSession', async () => {
    // The sibling-case law. There are four assignment sites, and a fix applied
    // to three of them is a silently mutable fold on the fourth path. They all
    // route through the one private setter; this is what proves it.

    // 1. the constructor, before any event.
    expect(Object.isFrozen(recorder.foldSoFar())).toBe(true)

    // 2. advanceFold, via record().
    await recorder.record(f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }))
    expect(Object.isFrozen(recorder.foldSoFar())).toBe(true)

    // 3. the self-heal rebuild inside foldSoFar().
    const spy = vi.spyOn(core, 'reduce').mockImplementationOnce(() => {
      throw new Error('reduce boom')
    })
    await recorder.record(f.branchUpdated({ branch: 'main', head: 'b'.repeat(40) }))
    spy.mockRestore()
    expect(Object.isFrozen(recorder.foldSoFar())).toBe(true)

    // 4. openSession's reset.
    const SECOND = '2000'
    await recorder.closeWith(f.sessionClosed({ sessionId: FIRST, reason: 'rotated', eventCount: 2 }))
    recorder.openSession(SECOND, sessionFilePath(dir, SECOND))
    expect(Object.isFrozen(recorder.foldSoFar())).toBe(true)
  })

  it('a resumed constructor freezes too — the fold rebuilt from resumeFrom is not a mutable one', async () => {
    const resumeFrom = [
      f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }),
      f.branchUpdated({ branch: 'main', head: 'b'.repeat(40) }),
    ]
    const resumed = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST), { resumeFrom })
    expect(Object.isFrozen(resumed.foldSoFar())).toBe(true)
    expect(resumed.foldSoFar()).toEqual(reduceAll(resumeFrom))
  })

  it('the self-heal still heals, and heals FROZEN — the rebuilt fold is not a mutable one', async () => {
    // The existing self-heal law (above) proves the rebuild is correct. This
    // one proves the rebuild went through the setter: leaving that one
    // assignment un-routed gives a fold that is correct, mutable and silent.
    await recorder.record(f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }))
    const spy = vi.spyOn(core, 'reduce').mockImplementationOnce(() => {
      throw new Error('reduce boom')
    })
    await recorder.record(f.branchUpdated({ branch: 'main', head: 'c'.repeat(40) }))
    spy.mockRestore()

    const healed = recorder.foldSoFar()
    expect(recorder.eventsSoFar()).toHaveLength(2)
    expect(healed).toEqual(reduceAll(recorder.eventsSoFar()))
    expect(Object.isFrozen(healed)).toBe(true)
    expect(() => {
      healed.eventCount = 999
    }).toThrow(TypeError)
  })

  it('freezing is bounded by what each event allocated, not by session length', async () => {
    // The reason this needs no dev/test gate. `reduce` copies only the spine it
    // changed and shares every untouched subtree, and those subtrees were
    // frozen when they were created — so the `Object.isFrozen` short-circuit
    // means each event freezes roughly what it allocated.
    //
    // Two sizes, because one size cannot tell "bounded" from "small" — the same
    // shape as #3's spy law. No exact number is asserted: the claim is that the
    // per-event cost does not GROW with the session, and an exact count would
    // be a brittle restatement of today's reducer internals.
    const freeze = vi.spyOn(Object, 'freeze')
    let n = 0
    const grow = async (count: number): Promise<void> => {
      for (let i = 0; i < count; i += 1) {
        n += 1
        await recorder.record(
          f.worktreeDiscovered({ path: `/repo/rhizomorph-wt/w${n}`, branch: `w${n}`, isMain: false }),
        )
      }
    }

    await grow(1) // warm up: the first event allocates the whole spine once.

    const beforeSmall = freeze.mock.calls.length
    await grow(5)
    const perEventSmall = (freeze.mock.calls.length - beforeSmall) / 5

    await grow(60) // a session an order of magnitude longer

    const beforeLarge = freeze.mock.calls.length
    await grow(5)
    const perEventLarge = (freeze.mock.calls.length - beforeLarge) / 5

    // Not vacuous: the freeze is doing real work at both sizes.
    expect(perEventSmall).toBeGreaterThan(0)
    expect(perEventLarge).toBeLessThanOrEqual(perEventSmall)
  })

  it('no reducer arm mutates its frozen input — every event type in the union, not just the corpus', async () => {
    // The freeze makes the fold the INPUT to the next `reduce()`, so ADR-0002's
    // purity contract stops being a convention and becomes load-bearing. An arm
    // that writes to its input now throws — and `advanceFold` CATCHES that,
    // raising `foldDesynced`. So the failure is not a crash: it is a silent,
    // permanent fallback to a full `reduceAll` on every read, which is exactly
    // the per-read cost prd40 ruling 2 exists to remove.
    //
    // The corpus law below discharges this for era-1, which carries 15 of the
    // union's types — `eras.test.ts` pins the 13 it does not reach, among them
    // every `collector.*`, `fork.*`, `judge.finding` and `telemetry.refused`.
    // Their arms are clean today (verified), but nothing held them there.
    //
    // Anchored on EVENT_TYPES rather than a count, so a newly added event type
    // fails this law until someone folds it here — the guard is scoped by what the
    // union IS, not by how many members it had the day it was written.
    const events = [
      f.sessionStarted(),
      f.beaconReceived(),
      f.processSeen(),
      f.processActivity(),
      f.processGone(),
      f.collectorError(),
      f.collectorDisabled(),
      f.collectorDegraded(),
      f.collectorRecovered(),
      f.worktreeDiscovered(),
      f.worktreeRemoved(),
      f.worktreeDirty(),
      f.worktreeDirtyStatusFailed(),
      f.worktreeDirtyStatusRecovered(),
      f.branchUpdated(),
      f.branchRemoved(),
      f.commitLanded(),
      f.paneDiscovered(),
      f.paneClosed(),
      f.paneActivity(),
      f.agentStatus(),
      f.agentRemoved(),
      f.llmUsage(),
      f.llmCost(),
      f.toolActivity(),
      f.agentActiveTime(),
      f.traceSpan(),
      f.forkCheckpoint(),
      f.forkDispatched(),
      f.forkMeasured(),
      f.judgeFinding(),
      f.make('telemetry.refused', { instance: 'other', expectedInstance: 'fixture-instance', count: 1 }),
      f.sessionClosed(),
      // prd17 ruling 1 (#219). Their arms return state unchanged today, which
      // is exactly the shape this law exists to keep honest: an arm that later
      // starts folding one of these into state must not write to its frozen
      // input, and it is checked here from the day the family exists rather
      // than from the day something emits it.
      f.summonsRaised(),
      f.summonsCleared(),
      f.gateVerdict(),
      f.dispatchBrief(),
      f.fenceDeclared(),
      f.operatorAck(),
      f.operatorVerdict(),
      f.operatorNote(),
      // prd-55 ruling 1 — the R&D hand's four (#407, #412). Unlike the prd17
      // family above, these arms DO fold: `state.rd` carries patterns,
      // proposals, refusals and overrides, and the override arm writes an
      // index into `overridesByProposal`. So they are exactly the shape this
      // law is for — arms that read a frozen input and build new state beside
      // it, where one `push` written in place of a spread would desync the
      // fold permanently and silently.
      //
      // They arrived with wave 5's core half and this list did not follow
      // them, which is precisely why the law is anchored on `EVENT_TYPES` and
      // not on a count: it went red on an otherwise untouched tree until
      // someone folded them in here. That is the correct direction, and this
      // commit is the follow.
      f.rdPatterns(),
      f.rdProposal(),
      f.rdRefused(),
      f.rdOverride(),
    ]
    // Exhaustive by construction, and it stays that way.
    expect([...new Set(events.map((event) => event.type))].sort()).toEqual([...EVENT_TYPES].sort())

    // `foldSoFar` reaches `reduceAll` ONLY to self-heal a desync, and `record`
    // never reaches it at all — so a single call here means an arm threw on its
    // frozen input. Counting `core.reduce` instead would NOT work: `reduceAll`
    // calls `reduce` through a module-local binding a namespace spy never sees.
    const healed = vi.spyOn(core, 'reduceAll')
    for (const event of events) {
      await recorder.record(event)
      recorder.foldSoFar()
      // Checked after EVERY event, and carrying the type: the self-heal repairs
      // the ANSWER, so a trailing equality assertion cannot see that it fired,
      // and a bare count would not say which arm did it.
      expect({ after: event.type, selfHeals: healed.mock.calls.length }).toEqual({
        after: event.type,
        selfHeals: 0,
      })
    }
    healed.mockRestore() // this law's own reduceAll calls must not be counted

    expect(recorder.eventsSoFar()).toHaveLength(events.length)
    expect(recorder.foldSoFar()).toEqual(reduceAll(recorder.eventsSoFar()))
    expect(Object.isFrozen(recorder.foldSoFar())).toBe(true)
  })

  it('repetition: three records in a row keep the fold correct, frozen and identical across reads', async () => {
    for (const event of [
      f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true }),
      f.branchUpdated({ branch: 'main', head: 'a'.repeat(40) }),
      f.worktreeDiscovered({ path: '/repo/rhizomorph-wt/feature', branch: 'feature', isMain: false }),
    ]) {
      await recorder.record(event)
      const fold = recorder.foldSoFar()
      expect(fold).toEqual(reduceAll(recorder.eventsSoFar()))
      expect(Object.isFrozen(fold)).toBe(true)
      expect(recorder.foldSoFar()).toBe(fold)
    }
  })
})

describe('SessionRecorder — foldSoFar() spy law (prd40 ruling 2)', () => {
  let dir: string
  let recorder: SessionRecorder
  let f: ReturnType<typeof createEventFactory>

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-spy-test-'))
    recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST))
    f = createEventFactory()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('costs zero extra reduce() calls per foldSoFar() read, at a small and then a larger session size', async () => {
    const spy = vi.spyOn(core, 'reduce')

    for (let i = 0; i < 5; i += 1) {
      await recorder.record(f.worktreeDiscovered({ path: `/repo/wt-${i}`, branch: 'main', isMain: i === 0 }))
    }
    const afterFive = spy.mock.calls.length
    expect(afterFive).toBe(5) // one reduce() call per recorded event, nothing more

    recorder.foldSoFar()
    recorder.foldSoFar()
    recorder.foldSoFar()
    expect(spy.mock.calls.length).toBe(afterFive) // three reads, zero extra reduce() calls

    for (let i = 5; i < 55; i += 1) {
      await recorder.record(f.worktreeDiscovered({ path: `/repo/wt-${i}`, branch: 'main', isMain: false }))
    }
    const afterFiftyFive = spy.mock.calls.length
    expect(afterFiftyFive).toBe(55)

    recorder.foldSoFar()
    recorder.foldSoFar()
    recorder.foldSoFar()
    recorder.foldSoFar()
    recorder.foldSoFar()
    // The law: five reads cost the SAME zero extra calls at 55 events as three
    // reads cost at 5 — the per-read cost does not grow with the session.
    expect(spy.mock.calls.length).toBe(afterFiftyFive)
  })

  it('does not re-fold the buffer on a read — reduceAll is never reached while the fold is in step', async () => {
    // The law above spies `core.reduce`, and that spy is STRUCTURALLY BLIND to
    // the rebuild path: `reduceAll` is `events.reduce(reduce, state)` inside
    // core's own module scope, so it binds core's LOCAL `reduce` declaration,
    // which replacing the exported property does not touch. Forcing
    // `foldSoFar()` to re-fold on every read left that law green — it proves
    // `advanceFold` runs once per event and cannot prove the read is free.
    // This law watches the call a rebuild actually makes.
    const rebuild = vi.spyOn(core, 'reduceAll')

    for (let i = 0; i < 5; i += 1) {
      await recorder.record(f.worktreeDiscovered({ path: `/repo/wt-${i}`, branch: 'main', isMain: i === 0 }))
    }
    for (let i = 0; i < 3; i += 1) recorder.foldSoFar()
    expect(rebuild).not.toHaveBeenCalled()

    for (let i = 5; i < 55; i += 1) {
      await recorder.record(f.worktreeDiscovered({ path: `/repo/wt-${i}`, branch: 'main', isMain: false }))
    }
    for (let i = 0; i < 5; i += 1) recorder.foldSoFar()
    // Still zero at eleven times the session size: a read does not re-fold, so
    // its cost cannot grow with the buffer.
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('returns the SAME state object across reads — reference identity, so no route can re-fold unseen', async () => {
    // Strictly stronger than either spy law, and route-independent. Both spies
    // are barrel-scoped: they intercept `@rhizomorph/core` import call sites,
    // so a rebuild reached through a DEEP import
    // (`@rhizomorph/core/src/reduce.js`) is invisible to both. Reference
    // identity cannot be fooled that way — a re-fold necessarily allocates a
    // new object, whatever path it took to get there.
    for (let i = 0; i < 5; i += 1) {
      await recorder.record(f.worktreeDiscovered({ path: `/repo/wt-${i}`, branch: 'main', isMain: i === 0 }))
    }
    const first = recorder.foldSoFar()
    expect(recorder.foldSoFar()).toBe(first)
    expect(recorder.foldSoFar()).toBe(first)

    await recorder.record(f.worktreeDiscovered({ path: '/repo/wt-next', branch: 'main', isMain: false }))
    const afterOneMore = recorder.foldSoFar()
    expect(afterOneMore).not.toBe(first) // an event DID advance it
    expect(recorder.foldSoFar()).toBe(afterOneMore)
  })

  it('a subscriber reading foldSoFar() from inside emit sees the fold already in step with the buffer', async () => {
    // The `advanceFold` doc claims exactly this — push and advance in the same
    // synchronous step, so a subscriber cannot observe the fold lagging. It was
    // unlaw'd: every other test reads only AFTER `await record()` resolves, so
    // the relative order of push-vs-advance was unguarded. prd-40 wave 2
    // reorders these very lines under this same fence, which is why it is
    // pinned here rather than left to hold by luck.
    const seen: { count: number; equal: boolean }[] = []
    recorder.subscribe(() => {
      seen.push({
        count: recorder.eventsSoFar().length,
        // Structural, never identity: `reduceAll` allocates a fresh state on
        // every call, so an identity comparison here is dead by construction —
        // it reads as though identity might hold mid-emit, and it cannot.
        equal: deepEqualFold(recorder),
      })
    })
    await recorder.record(f.worktreeDiscovered({ path: '/repo/a', branch: 'main', isMain: true }))
    await recorder.record(f.worktreeDiscovered({ path: '/repo/b', branch: 'wt', isMain: false }))
    expect(seen).toHaveLength(2)
    expect(seen.map((s) => s.count)).toEqual([1, 2])
    expect(seen.every((s) => s.equal)).toBe(true)
  })

  it('self-heals with exactly ONE rebuild — the desync flag is cleared, not left set', async () => {
    // Claimed in three doc comments and law'd in none: deleting
    // `foldDesynced = false` from `foldSoFar()` left every test green, and the
    // consequence is that after a single caught throw EVERY later read is O(n)
    // forever — the exact cost this issue exists to remove.
    const spy = vi.spyOn(core, 'reduce').mockImplementationOnce(() => {
      throw new Error('reduce boom')
    })
    await recorder.record(f.worktreeDiscovered({ path: '/repo/a', branch: 'main', isMain: true }))
    spy.mockRestore()

    const rebuild = vi.spyOn(core, 'reduceAll')
    recorder.foldSoFar() // the repair
    expect(rebuild).toHaveBeenCalledTimes(1)
    recorder.foldSoFar()
    recorder.foldSoFar()
    expect(rebuild).toHaveBeenCalledTimes(1) // repaired once, then free again
  })

  it('openSession() clears the desync flag too — a rotation does not carry a repair into the new session', async () => {
    // The sibling of the law above. `foldSoFar()` clears the flag; so must
    // `openSession()`, whose own reset makes the fold correct by construction
    // and leaves nothing to repair. Deleting `this.foldDesynced = false` from
    // `openSession` left all fifteen other laws green — and the consequence is
    // a flag that survives the rotation, so the first read of the NEW session
    // pays a full rebuild for a desync belonging to the session that ended.
    const spy = vi.spyOn(core, 'reduce').mockImplementationOnce(() => {
      throw new Error('reduce boom')
    })
    await recorder.record(f.worktreeDiscovered({ path: '/repo/a', branch: 'main', isMain: true }))
    spy.mockRestore()
    // Deliberately NOT reading foldSoFar() here: that would repair the flag,
    // and the flag crossing the rotation boundary is the whole point.

    const SECOND = '2000'
    await recorder.closeWith(f.sessionClosed({ sessionId: FIRST, reason: 'rotated', eventCount: 2 }))
    recorder.openSession(SECOND, sessionFilePath(dir, SECOND))
    await recorder.record(f.worktreeDiscovered({ path: '/repo/b', branch: 'main', isMain: true }))

    const rebuild = vi.spyOn(core, 'reduceAll')
    const fold = recorder.foldSoFar()
    expect(rebuild).not.toHaveBeenCalled() // the new session's read is free
    rebuild.mockRestore()
    expect(fold).toEqual(reduceAll(recorder.eventsSoFar())) // and still correct
  })
})

describe('SessionRecorder — foldSoFar() over the golden-era corpus (prd40 ruling 2)', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-corpus-test-'))
    recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('deep-equals reduceAll(events) after replaying era-1 through record()', async () => {
    // Gate-forced deviation (#3): `corpus.ts` reads its fixture bytes with
    // Vite's `?raw` suffix, declared ambiently only in `core`'s own tsconfig
    // scope and in `web`'s (via `"types": ["vite/client"]`) — `server`'s
    // tsconfig has neither, so a literal-specifier import here pulls
    // `corpus.ts` into `tsc`'s program and fails with TS2307. Routing the
    // specifier through a `const` keeps the module out of the statically
    // resolved (and therefore statically type-checked) import graph, while
    // Node/Vitest still resolve it identically at runtime. `fold.ts` has no
    // such import and is imported directly below.
    const corpusModulePath = '@rhizomorph/core/src/eras/corpus.js'
    const { eraCorpusEntry } = await import(corpusModulePath)
    const { foldEraRecording } = await import('@rhizomorph/core/src/eras/fold.js')
    const { events } = foldEraRecording(eraCorpusEntry('era-1').recordingText)
    // F5: every assertion below holds vacuously against an empty corpus — an
    // era that stopped shipping events would leave this law green and blind.
    // era-1 carries 100 events across 15 event types as of this commit.
    expect(events.length).toBeGreaterThan(0)

    for (const event of events) {
      await recorder.record(event)
    }

    expect(recorder.foldSoFar()).not.toEqual(initialSessionState()) // the corpus DID fold
    expect(recorder.foldSoFar()).toEqual(reduceAll(events))
    expect(recorder.foldSoFar()).toEqual(reduceAll(recorder.eventsSoFar()))
  })
})

describe('SessionRecorder — a throwing subscriber cannot blind the others (#106)', () => {
  let dir: string
  let recorder: SessionRecorder

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-isolation-test-'))
    recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  const anError = (id: string) => createEvent('collector.error', { collector: 'git', message: 'boom' }, { id, ts: 1000 })
  const aClose = () =>
    createEvent(
      'session.closed',
      { sessionId: FIRST, reason: 'rotated', eventCount: 1 },
      { id: `session-closed-${FIRST}`, ts: 1000 },
    )

  it('a subscriber registered AFTER a thrower still receives the event', async () => {
    // L1, and the registration ORDER is the whole law. `EventEmitter.emit`
    // abandons the listener list at the FIRST throw, so only a survivor queued
    // BEHIND the thrower can prove the isolation: register the survivor first
    // and this test passes against the unfixed recorder, proving nothing.
    // Do not "tidy" these two subscribe calls into the other order.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: RhizomorphEvent[] = []
    recorder.subscribe(() => {
      throw new Error('subscriber boom')
    })
    recorder.subscribe((event) => {
      seen.push(event)
    })
    const event = anError('evt-1')

    await recorder.record(event)

    expect(seen).toEqual([event])
    expect(reported).toHaveBeenCalledWith(expect.stringContaining('subscriber boom'))
  })

  // L2 — the sibling case. All three publish paths had this defect, in three
  // different costumes: `record` unguarded, `recordAlarm` and `closeWith`
  // guarded so the PUBLISHER survived while every listener behind the thrower
  // was still dropped. One wrapper at `subscribe` reaches all three because the
  // emitter is private and `subscribe` is its only registration path — and this
  // table is what proves that rather than asserting it. A fix proven on one path
  // and not its siblings is this repo's recurring defect shape.
  const publishPaths: ReadonlyArray<{
    readonly name: string
    readonly publish: (r: SessionRecorder) => Promise<RhizomorphEvent>
  }> = [
    {
      name: 'record',
      publish: async (r) => {
        const event = anError('evt-1')
        await r.record(event)
        return event
      },
    },
    {
      name: 'recordAlarm',
      publish: async (r) => {
        const event = anError('evt-1')
        await r.recordAlarm(event)
        return event
      },
    },
    {
      name: 'closeWith',
      publish: async (r) => {
        const event = aClose()
        await r.closeWith(event)
        return event
      },
    },
  ]

  it.each(publishPaths)('$name reaches a subscriber queued behind a thrower', async ({ publish }) => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: RhizomorphEvent[] = []
    recorder.subscribe(() => {
      throw new Error('subscriber boom')
    })
    recorder.subscribe((event) => {
      seen.push(event)
    })

    const event = await publish(recorder)

    expect(seen).toEqual([event])
    expect(reported).toHaveBeenCalledWith(expect.stringContaining('subscriber boom'))
  })

  it('reports EVERY subscriber that throws, not just the first', async () => {
    // L3. Under the old single `try` around `emitter.emit`, at most one throw
    // could ever be reported, because the emit stopped at it. Separate from L1
    // on purpose: a wrapper that swallowed silently would keep L1 green while
    // reintroducing exactly the silence ADR-0011 abolished.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: RhizomorphEvent[] = []
    recorder.subscribe(() => {
      throw new Error('subscriber boom one')
    })
    recorder.subscribe(() => {
      throw new Error('subscriber boom two')
    })
    recorder.subscribe((event) => {
      seen.push(event)
    })
    const event = anError('evt-1')

    await recorder.record(event)

    expect(seen).toEqual([event])
    expect(reported).toHaveBeenCalledWith(expect.stringContaining('subscriber boom one'))
    expect(reported).toHaveBeenCalledWith(expect.stringContaining('subscriber boom two'))
    expect(reported).toHaveBeenCalledTimes(2)
  })

  it('record() resolves rather than rejecting when a subscriber throws', async () => {
    // L4 pins the deliberate contract change (#106): `record` used to reject on
    // a subscriber's throw. `poll-loop.ts:223` calls it inside the try whose
    // catch builds a `collector.error`, with the snapshot advance behind it, so
    // rejecting turned a buggy dashboard into a false error naming a healthy
    // collector plus a re-appended batch. All three publish paths now agree.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    recorder.subscribe(() => {
      throw new Error('subscriber boom')
    })
    const event = anError('evt-1')

    await expect(recorder.record(event)).resolves.toBeUndefined()

    expect(reported).toHaveBeenCalledWith(expect.stringContaining('subscriber boom'))
    // And the publish itself completed — the throw stopped nothing at all.
    expect(recorder.eventsSoFar()).toEqual([event])
    expect(readFileSync(sessionFilePath(dir, FIRST), 'utf8')).toContain('evt-1')
  })

  it('unsubscribe still removes the right listener after that listener has thrown', async () => {
    // L5 catches the trap in the fix: `off` matches by REFERENCE, so an
    // unsubscribe closed over the caller's `listener` rather than the wrapper
    // actually registered would silently remove nothing — and leak a listener
    // per SSE client, forever, with every law above still green.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    let calls = 0
    const unsubscribe = recorder.subscribe(() => {
      calls++
      throw new Error('subscriber boom')
    })

    await recorder.record(anError('evt-1'))
    expect(calls).toBe(1)

    unsubscribe()
    await recorder.record(anError('evt-2'))

    expect(calls).toBe(1)
    expect(reported).toHaveBeenCalledTimes(1)
  })
})

// prd-44 ruling 4 (#37): the server states its retention, as the client already
// does. Every law here asserts a COUNT — events in the window, events dropped,
// array slots held, `reduce`/`reduceAll` calls — and never a wall clock, which
// is the defect prd-24 named. No law here is named `*.bench.test.ts` and none
// carries a `@gate-timing` marker, so `scripts/gate.sh`'s 4x-load timing set
// and its `.swarm/timing-count` ratchet are untouched.
//
// **They run at the REAL 75,000, not at an injected toy bound.** A configurable
// ceiling tested only at 4 would never exercise the default it exists to
// protect — the second-worst defect shape AGENTS.md names. Reaching the real
// bound is affordable because `resumeFrom` seeds a whole session in one
// constructor call (~130 ms for 76,025 events), and because the one law that
// must drive `record()` itself mocks the writer's append: the bound is a memory
// property, so paying 75,003 disk writes to observe it would buy nothing.
describe('SessionRecorder — the window has a stated ceiling (prd-44 ruling 4, #37)', () => {
  let dir: string

  /**
   * A distinguishable event whose fold is O(1). Type matters here in a way it
   * does not elsewhere in this file: `worktree.discovered` accumulates a record
   * per worktree, so folding 76,025 of them copies a growing map 76,025 times
   * and takes minutes. `collector.error` folds into one collector entry plus an
   * errors list capped at `MAX_ERRORS`, so a 76,025-event session folds in
   * ~36 ms.
   */
  function err(i: number) {
    return createEvent('collector.error', { collector: 'git', message: `boom ${i}` }, { id: `evt-${i}`, ts: 1000 + i })
  }

  /** `count` events, oldest first — `evt-0` .. `evt-(count-1)`. */
  function session(count: number): RhizomorphEvent[] {
    const events: RhizomorphEvent[] = []
    for (let i = 0; i < count; i += 1) events.push(err(i))
    return events
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-window-test-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('is the operator number, and it is the client own number', () => {
    // Wave 0's answer, 2026-08-27: the same bound the browser sets on the same
    // data (`MAX_EVENTS`, `web/src/app/streamState.ts`). Pinned here because it
    // is a decision, not an implementation detail — a lane may not retune it.
    //
    // The stronger form of this law is a seam test on the WEB side importing
    // both constants, the way `web/src/app/boot-reason-seam.test.ts` already
    // reads `SESSION_BOOT_REASONS` from server source. That file is outside
    // this issue's fence; see the PR.
    expect(MAX_BUFFERED_EVENTS).toBe(75_000)
  })

  it('stops the window at the ceiling while the session own count keeps climbing', async () => {
    const recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST), { resumeFrom: session(MAX_BUFFERED_EVENTS) })
    expect(recorder.eventsSoFar()).toHaveLength(MAX_BUFFERED_EVENTS)
    expect(recorder.evictedEventCount).toBe(0)

    for (let i = 0; i < 3; i += 1) await recorder.record(err(MAX_BUFFERED_EVENTS + i))

    // The window stopped rising; the session's own count did not. That pair is
    // the whole ruling, and it is exactly the pair `eventsWindowLabel` reads.
    expect(recorder.eventsSoFar()).toHaveLength(MAX_BUFFERED_EVENTS)
    expect(recorder.foldSoFar().eventCount).toBe(MAX_BUFFERED_EVENTS + 3)
    expect(recorder.evictedEventCount).toBe(3)
  })

  it('evicts oldest first, and leaves the window in the log own order', async () => {
    const recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST), { resumeFrom: session(MAX_BUFFERED_EVENTS) })
    for (let i = 0; i < 3; i += 1) await recorder.record(err(MAX_BUFFERED_EVENTS + i))

    const window = recorder.eventsSoFar()
    // The three oldest went, the three newest arrived, and nothing in between
    // moved: a newest-first or unordered eviction fails on the first assertion,
    // a window rebuilt from a set fails on the last.
    expect(window[0]?.id).toBe('evt-3')
    expect(window.at(-1)?.id).toBe(`evt-${MAX_BUFFERED_EVENTS + 2}`)
    expect(window.map((event) => event.ts)).toEqual([...window].sort((a, b) => a.ts - b.ts).map((event) => event.ts))
  })

  it('never trims the fold — it stays the fold of every event, not of the window', () => {
    const all = session(MAX_BUFFERED_EVENTS + 25)
    const recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST), { resumeFrom: all })

    expect(recorder.evictedEventCount).toBe(25)
    // The fold is complete: every evicted event is still in it.
    expect(JSON.stringify(recorder.foldSoFar())).toBe(JSON.stringify(reduceAll(all)))
    // And the negative, which is what makes the positive mean something: past
    // eviction the fold is NOT `reduceAll(eventsSoFar())`. This file's own
    // `deepEqualFold` helper asserts exactly that equality, so its premise ends
    // here — it holds for every session under the ceiling and no further.
    expect(JSON.stringify(recorder.foldSoFar())).not.toBe(JSON.stringify(reduceAll(recorder.eventsSoFar())))
  })

  it('reclaims the slots behind the window rather than holding every event it evicted', () => {
    const recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST), {
      resumeFrom: session(MAX_BUFFERED_EVENTS + COMPACT_AFTER_EVICTED + 1),
    })

    expect(recorder.eventsSoFar()).toHaveLength(MAX_BUFFERED_EVENTS)
    // The law the window's own length cannot carry: an implementation that
    // evicted by advancing an index and never compacted would pass every other
    // law here while holding all 76,025 events in memory forever.
    expect(recorder.bufferedSlotsForTests()).toBeLessThanOrEqual(MAX_BUFFERED_EVENTS + COMPACT_AFTER_EVICTED)
  })

  it('empties the window outright on a rotation — a rotation is not an eviction', async () => {
    const recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST), {
      resumeFrom: session(MAX_BUFFERED_EVENTS + 5),
    })
    expect(recorder.evictedEventCount).toBe(5)

    recorder.openSession('2000', sessionFilePath(dir, '2000'))

    expect(recorder.eventsSoFar()).toEqual([])
    expect(recorder.foldSoFar().eventCount).toBe(0)
    // Not 5: the previous session's evictions are not this session's, and a
    // count carried across the boundary would make the new session's fold
    // permanently unrepairable for a reason that belongs to the old one.
    expect(recorder.evictedEventCount).toBe(0)
    expect(recorder.bufferedSlotsForTests()).toBe(0)

    await recorder.record(err(1))
    await recorder.record(err(2))
    expect(recorder.eventsSoFar()).toHaveLength(2)
    expect(recorder.evictedEventCount).toBe(0)
  })

  // #307: this law folds 75,003 events and takes 4–10 s alone on an 8 GB Apple
  // Silicon machine (four measurements: 4.2 s, 9.3 s, 9.7 s, 10.5 s) and 5.9 s
  // under a six-worker suite — past vitest's 5 s default, which made it the one
  // red in every full run of prd-27 waves 3 and 4 on that machine. The ceiling
  // it asserts is a COUNT; only the harness clock moves here. The file's stance
  // above (no `@gate-timing`, no `.bench`) is unchanged.
  it('holds the ceiling in a session reached by rotation, not only in the first one', async () => {
    const recorder = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST), {
      resumeFrom: session(MAX_BUFFERED_EVENTS + 5),
    })
    recorder.openSession('2000', sessionFilePath(dir, '2000'))

    // Mocked purely to keep 75,003 disk writes out of a law about memory.
    vi.spyOn(SessionLogWriter.prototype, 'append').mockResolvedValue(undefined)
    for (let i = 0; i < MAX_BUFFERED_EVENTS + 3; i += 1) await recorder.record(err(i))

    // The bound is a property of the recorder, not of the session it happened
    // to be constructed with — an `openSession` that reset the window but not
    // the machinery around it would fail here and nowhere else.
    expect(recorder.eventsSoFar()).toHaveLength(MAX_BUFFERED_EVENTS)
    expect(recorder.evictedEventCount).toBe(3)
    expect(recorder.foldSoFar().eventCount).toBe(MAX_BUFFERED_EVENTS + 3)
  }, 30_000)

  it('does not repair the fold from a window that has already evicted, and still repairs one that has not', async () => {
    const evicting = new SessionRecorder(FIRST, sessionFilePath(dir, FIRST), {
      resumeFrom: session(MAX_BUFFERED_EVENTS + 5),
    })
    // One event's fold fails, so `foldDesynced` is raised over a window that is
    // no longer the whole session.
    vi.spyOn(core, 'reduce').mockImplementationOnce(() => {
      throw new Error('a bug in the accelerator')
    })
    await evicting.record(err(MAX_BUFFERED_EVENTS + 5))

    const rebuild = vi.spyOn(core, 'reduceAll')
    evicting.foldSoFar()
    evicting.foldSoFar()
    // A rebuild from `buffer` here would drop all 6 evicted events; the
    // incremental fold is behind by the ONE event `reduce` threw on. The better
    // of two imperfect answers is kept, and no rebuild is attempted.
    expect(rebuild).not.toHaveBeenCalled()
    expect(evicting.foldSoFar().eventCount).toBe(MAX_BUFFERED_EVENTS + 5)
    rebuild.mockRestore()

    // The sibling, stated beside it: with nothing evicted, `buffer` IS ground
    // truth and the repair still runs exactly as it did before this change.
    const whole = new SessionRecorder('3000', sessionFilePath(dir, '3000'))
    await whole.record(err(1))
    vi.spyOn(core, 'reduce').mockImplementationOnce(() => {
      throw new Error('a bug in the accelerator')
    })
    await whole.record(err(2))
    const repair = vi.spyOn(core, 'reduceAll')
    expect(whole.foldSoFar().eventCount).toBe(2)
    expect(repair).toHaveBeenCalledTimes(1)
  })
})
