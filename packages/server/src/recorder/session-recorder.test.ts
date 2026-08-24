import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvent, createEventFactory, initialSessionState, reduceAll } from '@rhizomorph/core'
import * as core from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
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

  it('releases the seal instead of hanging forever when a subscriber throws', async () => {
    const closeEvent = createEvent(
      'session.closed',
      { sessionId: FIRST, reason: 'rotated', eventCount: 1 },
      { id: `session-closed-${FIRST}`, ts: 1000 },
    )
    const unsubscribe = recorder.subscribe(() => {
      throw new Error('subscriber boom')
    })

    await expect(recorder.closeWith(closeEvent)).rejects.toThrow('subscriber boom')
    expect(recorder.isSealed).toBe(false)
    unsubscribe()

    // A record() call after the throwing close must resolve promptly, not
    // hang forever on a seal nobody released.
    await expect(
      recorder.record(createEvent('collector.error', { collector: 'git', message: 'boom' }, { id: 'evt-2', ts: 1001 })),
    ).resolves.toBeUndefined()
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
        equal: recorder.foldSoFar() === reduceAll(recorder.eventsSoFar()) ? true : deepEqualFold(recorder),
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

    for (const event of events) {
      await recorder.record(event)
    }

    expect(recorder.foldSoFar()).toEqual(reduceAll(events))
    expect(recorder.foldSoFar()).toEqual(reduceAll(recorder.eventsSoFar()))
  })
})
