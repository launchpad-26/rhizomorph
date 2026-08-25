import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent, createEventFactory, initialSessionState, reduceAll } from '@rhizomorph/core'
import type { RhizomorphEvent } from '@rhizomorph/core'
import * as core from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { writeSessionLock } from '../log/session-lock.js'
import { rotateSession } from './rotate.js'
import { SessionLogWriter } from './session-log-writer.js'
import { SessionRecorder } from './session-recorder.js'

const FIRST = '1000'

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
    // Registered BEFORE the thrower: `EventEmitter.emit` abandons the listener
    // list at the first throw, so this method's guard buys the CALLER's
    // survival, not delivery to listeners queued behind a broken one. That
    // limit is the same one `closeWith` has always had.
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
