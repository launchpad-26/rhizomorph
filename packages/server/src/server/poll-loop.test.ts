import type { AnyCollector, CollectorContext, EventOf, Exec, ExecResult, RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COLLECTOR_EXEC_TIMEOUT_MS, createPollLoop } from './poll-loop.js'
import type { SessionRecorder } from './recorder.js'
import type { LoadedSnapshot, SnapshotStore } from './snapshot-store.js'

function createFakeRecorder(): { recorder: SessionRecorder; events: RhizomorphEvent[] } {
  const events: RhizomorphEvent[] = []
  const recorder = {
    record: async (event: RhizomorphEvent) => {
      events.push(event)
    },
    recordAlarm: async (event: EventOf<'collector.error'>) => {
      events.push(event)
      return { appended: true }
    },
  } as unknown as SessionRecorder
  return { recorder, events }
}

/**
 * A recorder on a disk that cannot be written: every `record` rejects, and
 * `recordAlarm` reports `{ appended: false }` — the alarm's own append failed
 * too. Per ADR-0030 it still reaches subscribers, which is what `subscribe`
 * here exists to let the tests observe.
 */
function createFailingRecorder(): SessionRecorder {
  const listeners: ((event: RhizomorphEvent) => void)[] = []
  return {
    record: async () => {
      throw new Error('ENOSPC: no space left on device')
    },
    recordAlarm: async (event: EventOf<'collector.error'>) => {
      for (const listener of listeners) listener(event)
      return { appended: false }
    },
    subscribe: (listener: (event: RhizomorphEvent) => void) => {
      listeners.push(listener)
      return () => {
        const at = listeners.indexOf(listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
  } as unknown as SessionRecorder
}

/** In-memory {@link SnapshotStore}, plus the call log the tests assert against. */
function createFakeStore(initial: Record<string, unknown> = {}): SnapshotStore & {
  saves: { name: string; snapshot: unknown }[]
  loads: string[]
  failSave?: Error
} {
  const stored = new Map(Object.entries(initial))
  const store = {
    saves: [] as { name: string; snapshot: unknown }[],
    loads: [] as string[],
    failSave: undefined as Error | undefined,
    async load(name: string): Promise<LoadedSnapshot> {
      store.loads.push(name)
      return stored.has(name) ? { found: true, snapshot: stored.get(name) } : { found: false }
    },
    async save(name: string, snapshot: unknown): Promise<void> {
      if (store.failSave) throw store.failSave
      store.saves.push({ name, snapshot })
      stored.set(name, snapshot)
    },
  }
  return store
}

const nullExec = async () => ({ stdout: '', stderr: '', code: 0, failed: false })

const okResult: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }

/** An `Exec` that never resolves — the wedged child #236 is about. */
const hangingExec: Exec = () => new Promise<ExecResult>(() => {})

/** A collector whose poll awaits its exec, so a never-resolving exec wedges the whole poll. */
function hangingCollector(name = 'wedged'): AnyCollector {
  return {
    name,
    initialSnapshot: () => ({ polls: 0 }),
    poll: async (prev: { polls: number }, ctx: CollectorContext) => {
      await ctx.exec('sleep', ['infinity'])
      return { nextSnapshot: { polls: prev.polls + 1 }, events: [] }
    },
  }
}

/** `collector.error` events (the counting collector, git, and timeouts all use this type), narrowed so payload fields are typed rather than cast. */
function collectorErrors(events: readonly RhizomorphEvent[]): EventOf<'collector.error'>[] {
  return events.filter((event): event is EventOf<'collector.error'> => event.type === 'collector.error')
}

/** Counts polls in its snapshot and reports what it was handed. */
function countingCollector(name = 'counter'): AnyCollector {
  return {
    name,
    initialSnapshot: () => ({ polls: 0 }),
    poll: (prev: { polls: number }, ctx: CollectorContext) => ({
      nextSnapshot: { polls: prev.polls + 1 },
      events: [ctx.emit('collector.error', { collector: name, message: `saw ${prev.polls}` })],
    }),
  }
}

describe('the poll loop and source timestamps', () => {
  it('keeps a collector-supplied source time and defaults the rest to the tick clock', async () => {
    const { recorder, events } = createFakeRecorder()
    const lineTime = 1_699_400_000_000
    const tickTime = 1_700_000_000_000

    const replayer: AnyCollector = {
      name: 'replayer',
      initialSnapshot: () => null,
      poll: (_prev: null, ctx: CollectorContext) => ({
        nextSnapshot: null,
        events: [
          ctx.emit('collector.error', { collector: 'replayer', message: 'week-old' }, { ts: lineTime }),
          ctx.emit('collector.error', { collector: 'replayer', message: 'live' }),
        ],
      }),
    }

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [replayer],
      recorder,
      exec: nullExec,
      now: () => tickTime,
    })
    await pollLoop.tick()

    expect(events.map((event) => event.ts)).toEqual([lineTime, tickTime])
  })
})

describe('the poll loop and snapshot persistence', () => {
  it('resumes from the persisted snapshot instead of starting the collector fresh', async () => {
    const { recorder, events } = createFakeRecorder()
    const store = createFakeStore({ counter: { polls: 41 } })

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: store,
    })
    await pollLoop.tick()

    // The very first poll of the process saw the restored snapshot, so
    // hydration finished before any collector ran.
    expect(events[0]?.payload).toMatchObject({ message: 'saw 41' })
    expect(store.saves).toEqual([{ name: 'counter', snapshot: { polls: 42 } }])
  })

  it('loads once, not on every tick', async () => {
    const { recorder } = createFakeRecorder()
    const store = createFakeStore({ counter: { polls: 5 } })

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: store,
    })
    await pollLoop.tick()
    await pollLoop.tick()

    expect(store.loads).toEqual(['counter'])
    expect(store.saves.map((save) => save.snapshot)).toEqual([{ polls: 6 }, { polls: 7 }])
  })

  it('starts fresh when the store has no snapshot for a collector', async () => {
    const { recorder, events } = createFakeRecorder()
    const store = createFakeStore()

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: store,
    })
    await pollLoop.tick()

    expect(events[0]?.payload).toMatchObject({ message: 'saw 0' })
  })

  it('keeps snapshots process-local when no store is configured', async () => {
    const { recorder, events } = createFakeRecorder()

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
    })
    await pollLoop.tick()
    await pollLoop.tick()

    expect(events.map((event) => (event.payload as { message: string }).message)).toEqual([
      'saw 0',
      'saw 1',
    ])
  })

  it('does not rewrite a snapshot the collector handed straight back', async () => {
    const { recorder } = createFakeRecorder()
    const store = createFakeStore()
    const idle: AnyCollector = {
      name: 'idle',
      initialSnapshot: () => ({ seen: [] }),
      poll: (prev: { seen: string[] }) => ({ nextSnapshot: prev, events: [] }),
    }

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [idle],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: store,
    })
    await pollLoop.tick()
    await pollLoop.tick()

    expect(store.saves).toEqual([])
  })

  it('reports a failing store once and keeps polling', async () => {
    const { recorder, events } = createFakeRecorder()
    const store = createFakeStore()
    store.failSave = new Error('EACCES: permission denied')

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: store,
    })
    await pollLoop.tick()
    await pollLoop.tick()
    await pollLoop.tick()

    const saveErrors = events.filter((event) =>
      (event.payload as { message: string }).message.startsWith('snapshot save failed'),
    )
    expect(saveErrors).toHaveLength(1)
    expect(saveErrors[0]?.payload).toMatchObject({
      collector: 'counter',
      message: 'snapshot save failed: EACCES: permission denied',
    })
    // The collector itself never stopped: three polls, three of its own events.
    const collectorEvents = events.filter((event) =>
      (event.payload as { message: string }).message.startsWith('saw '),
    )
    expect(collectorEvents).toHaveLength(3)
  })

  it('leaves a collector that throws with its previous snapshot, unpersisted', async () => {
    const { recorder, events } = createFakeRecorder()
    const store = createFakeStore({ broken: { polls: 3 } })
    const broken: AnyCollector = {
      name: 'broken',
      initialSnapshot: () => ({ polls: 0 }),
      poll: () => {
        throw new Error('broken blew up')
      },
    }

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [broken],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: store,
    })
    await pollLoop.tick()

    expect(events[0]).toMatchObject({
      type: 'collector.error',
      payload: { collector: 'broken', message: 'broken blew up' },
    })
    expect(store.saves).toEqual([])
  })

  it('degrades to a log line instead of crashing when the recorder itself cannot report a collector failure', async () => {
    const recorder = createFailingRecorder()
    const broken: AnyCollector = {
      name: 'broken',
      initialSnapshot: () => ({ polls: 0 }),
      poll: () => {
        throw new Error('broken blew up')
      },
    }

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [broken],
      recorder,
      exec: nullExec,
      now: () => 0,
    })

    await expect(pollLoop.tick()).resolves.toBeUndefined()
    // The loop is still alive: a second tick runs rather than the process
    // having died on an unhandled rejection from the first one.
    await expect(pollLoop.tick()).resolves.toBeUndefined()
  })

  it('degrades to a log line instead of crashing when the recorder cannot report a snapshot-save failure', async () => {
    const recorder = createFailingRecorder()
    const store = createFakeStore()
    store.failSave = new Error('EACCES: permission denied')
    // Emits no events of its own, so the snapshot-save catch in `persist()`
    // — not the collector-poll-failed catch in `runTick()` — is the one
    // whose `recorder.record` call this test exercises.
    const silent: AnyCollector = {
      name: 'silent',
      initialSnapshot: () => ({ polls: 0 }),
      poll: (prev: { polls: number }) => ({
        nextSnapshot: { polls: prev.polls + 1 },
        events: [],
      }),
    }

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [silent],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: store,
    })

    await expect(pollLoop.tick()).resolves.toBeUndefined()
    // The loop is still alive: a second tick runs rather than the process
    // having died on an unhandled rejection from the first one.
    await expect(pollLoop.tick()).resolves.toBeUndefined()
  })
})

describe('the poll loop degrade voice (prd40 success 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes the operator a line naming the event and the collector when the alarm cannot be appended', async () => {
    // P0. The fallback in `recordOrDegrade` had no assertion of any kind
    // before this law: the two tests above drive it and assert only that the
    // loop did not crash. Cover it before changing it — what the line SAYS is
    // the operator's only handle on which collector went quiet.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const recorder = createFailingRecorder()
    const broken: AnyCollector = {
      name: 'broken',
      initialSnapshot: () => ({ polls: 0 }),
      poll: () => {
        throw new Error('broken blew up')
      },
    }

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [broken],
      recorder,
      exec: nullExec,
      now: () => 0,
    })
    await pollLoop.tick()

    expect(reported).toHaveBeenCalledWith(
      expect.stringContaining('[rhizomorph] failed to report collector.error for broken'),
    )
  })

  it('reaches a live subscriber even when the alarms own append fails', async () => {
    // P1, the decisive law: the disk-full case. `record` publishes nothing when
    // its append fails (prd40 ruling 1), so before ADR-0030 this alarm reached
    // nobody in exactly the case it exists for and the dashboard went on
    // looking healthy. This test is unpassable through `record`.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recorder = createFailingRecorder()
    const heard: RhizomorphEvent[] = []
    recorder.subscribe((event) => {
      heard.push(event)
    })
    const broken: AnyCollector = {
      name: 'broken',
      initialSnapshot: () => ({ polls: 0 }),
      poll: () => {
        throw new Error('broken blew up')
      },
    }

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [broken],
      recorder,
      exec: nullExec,
      now: () => 0,
    })
    await pollLoop.tick()

    expect(collectorErrors(heard)).toHaveLength(1)
    expect(collectorErrors(heard)[0]?.payload).toMatchObject({
      collector: 'broken',
      message: 'broken blew up',
    })
  })

  it('still writes the operators line beside the emit — two channels, not one', async () => {
    // P2. `api/lab.ts` replaces `process.stderr.write` process-wide for the
    // duration of a lab fork (prd41 #10 owns that), so the emit cannot be the
    // only channel either. Both fire, or the guarantee is half a guarantee.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const recorder = createFailingRecorder()
    const heard: RhizomorphEvent[] = []
    recorder.subscribe((event) => {
      heard.push(event)
    })
    const broken: AnyCollector = {
      name: 'broken',
      initialSnapshot: () => ({ polls: 0 }),
      poll: () => {
        throw new Error('broken blew up')
      },
    }

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [broken],
      recorder,
      exec: nullExec,
      now: () => 0,
    })
    await pollLoop.tick()

    expect(heard).toHaveLength(1)
    expect(reported).toHaveBeenCalledWith(
      '[rhizomorph] failed to report collector.error for broken: the session log could not be written',
    )
  })

  it('speaks in the same voice for a snapshot-save failure as for a collector failure', async () => {
    // P3, the sibling case. `persist`'s degrade call and `runTick`'s are
    // structurally identical, and a fix applied to one and not the other is
    // the defect shape this repo keeps finding. The collector below emits
    // nothing of its own, so `persist()`s catch is the only one in play.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recorder = createFailingRecorder()
    const heard: RhizomorphEvent[] = []
    recorder.subscribe((event) => {
      heard.push(event)
    })
    const store = createFakeStore()
    store.failSave = new Error('EACCES: permission denied')
    const silent: AnyCollector = {
      name: 'silent',
      initialSnapshot: () => ({ polls: 0 }),
      poll: (prev: { polls: number }) => ({
        nextSnapshot: { polls: prev.polls + 1 },
        events: [],
      }),
    }

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [silent],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: store,
    })
    await pollLoop.tick()

    expect(collectorErrors(heard)).toHaveLength(1)
    expect(collectorErrors(heard)[0]?.payload).toMatchObject({
      collector: 'silent',
      message: 'snapshot save failed: EACCES: permission denied',
    })
  })
})

describe('the poll loop watchdog (#236)', () => {
  it('abandons a wedged collector within the tick budget and keeps polling the others', async () => {
    vi.useFakeTimers()
    try {
      const { recorder, events } = createFakeRecorder()
      const pollLoop = createPollLoop({
        repoPath: '/tmp/repo',
        collectors: [hangingCollector(), countingCollector('healthy')],
        recorder,
        exec: hangingExec,
        now: () => 0,
        tickBudgetMs: 50,
      })
      const tick = pollLoop.tick()
      await vi.advanceTimersByTimeAsync(50) // fire the watchdog deterministically — no real wait
      await tick

      const timeout = collectorErrors(events).find((event) => event.payload.collector === 'wedged')
      expect(timeout?.payload.message).toBe('timed out after 50ms')
      // The collector after the wedged one still ran on the same tick.
      expect(
        collectorErrors(events).some(
          (event) => event.payload.collector === 'healthy' && event.payload.message === 'saw 0',
        ),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shuts down cleanly even with a wedged collector in flight', async () => {
    vi.useFakeTimers()
    try {
      const { recorder, events } = createFakeRecorder()
      const pollLoop = createPollLoop({
        repoPath: '/tmp/repo',
        collectors: [hangingCollector()],
        recorder,
        exec: hangingExec,
        now: () => 0,
        intervalMs: 10_000,
        tickBudgetMs: 50,
      })
      pollLoop.start()
      const stopped = pollLoop.stop() // awaits the in-flight tick
      // Without the watchdog bounding the tick, this advance never lets stop() resolve.
      await vi.advanceTimersByTimeAsync(50)
      await stopped

      expect(collectorErrors(events).some((event) => event.payload.message === 'timed out after 50ms')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits the timeout once per episode while the others keep polling across ticks', async () => {
    vi.useFakeTimers()
    try {
      const { recorder, events } = createFakeRecorder()
      const pollLoop = createPollLoop({
        repoPath: '/tmp/repo',
        collectors: [hangingCollector(), countingCollector('healthy')],
        recorder,
        exec: hangingExec,
        now: () => 0,
        tickBudgetMs: 50,
      })
      const first = pollLoop.tick()
      await vi.advanceTimersByTimeAsync(50)
      await first
      // Later ticks: the wedged poll is still pending, so the in-flight guard
      // skips it and the healthy collector resolves without any timer.
      await pollLoop.tick()
      await pollLoop.tick()

      expect(collectorErrors(events).filter((event) => event.payload.collector === 'wedged')).toHaveLength(1)
      expect(
        collectorErrors(events)
          .filter((event) => event.payload.collector === 'healthy')
          .map((event) => event.payload.message),
      ).toEqual(['saw 0', 'saw 1', 'saw 2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a collector after its wedged poll finally settles', async () => {
    vi.useFakeTimers()
    try {
      const { recorder, events } = createFakeRecorder()
      let reapFirst: (result: ExecResult) => void = () => {}
      const firstExec = new Promise<ExecResult>((resolve) => {
        reapFirst = resolve
      })
      let calls = 0
      const flakyExec: Exec = () => {
        calls += 1
        return calls === 1 ? firstExec : Promise.resolve(okResult)
      }
      const collector: AnyCollector = {
        name: 'gated',
        initialSnapshot: () => ({ polls: 0 }),
        poll: async (prev: { polls: number }, ctx: CollectorContext) => {
          await ctx.exec('git', ['status'])
          return {
            nextSnapshot: { polls: prev.polls + 1 },
            events: [ctx.emit('collector.error', { collector: 'gated', message: `ran ${prev.polls}` })],
          }
        },
      }
      const pollLoop = createPollLoop({
        repoPath: '/tmp/repo',
        collectors: [collector],
        recorder,
        exec: flakyExec,
        now: () => 0,
        tickBudgetMs: 50,
      })

      const first = pollLoop.tick()
      await vi.advanceTimersByTimeAsync(50) // first poll wedges → times out
      await first
      expect(collectorErrors(events).some((event) => event.payload.message === 'timed out after 50ms')).toBe(true)

      // The exec ceiling would reap the real child; settle it by hand, then drain
      // the detach tail's microtasks so the in-flight slot is cleared.
      reapFirst(okResult)
      for (let i = 0; i < 6; i += 1) await Promise.resolve()

      await pollLoop.tick() // no longer wedged → polls again and succeeds
      expect(collectorErrors(events).some((event) => event.payload.message === 'ran 0')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps every collector exec at the default timeout, overridable per loop (belt)', async () => {
    const runWith = async (execTimeoutMs?: number): Promise<(number | undefined)[]> => {
      const { recorder } = createFakeRecorder()
      const seen: (number | undefined)[] = []
      const spyExec: Exec = async (_command, _args, options) => {
        seen.push(options?.timeoutMs)
        return okResult
      }
      const collector: AnyCollector = {
        name: 'probe',
        initialSnapshot: () => ({ polls: 0 }),
        poll: async (prev: { polls: number }, ctx: CollectorContext) => {
          await ctx.exec('git', ['status'])
          return { nextSnapshot: { polls: prev.polls + 1 }, events: [] }
        },
      }
      const pollLoop = createPollLoop({
        repoPath: '/tmp/repo',
        collectors: [collector],
        recorder,
        exec: spyExec,
        now: () => 0,
        ...(execTimeoutMs === undefined ? {} : { execTimeoutMs }),
      })
      await pollLoop.tick()
      return seen
    }

    expect(await runWith()).toEqual([COLLECTOR_EXEC_TIMEOUT_MS])
    expect(await runWith(1234)).toEqual([1234])
  })
})

/** Emits `worktree.discovered`-shaped events ONLY on a snapshot miss — the same "discover once, then go quiet" shape every real discovery collector (git, tmux, workmux) uses. */
function discoveryCollector(name = 'discovery'): AnyCollector {
  return {
    name,
    initialSnapshot: () => ({ seen: [] as string[] }),
    poll: (prev: { seen: string[] }, ctx: CollectorContext) => {
      const known = new Set(prev.seen)
      if (known.has('the-one-worktree')) return { nextSnapshot: prev, events: [] }
      return {
        nextSnapshot: { seen: [...prev.seen, 'the-one-worktree'] },
        events: [ctx.emit('collector.error', { collector: name, message: 'discovered the-one-worktree' })],
      }
    },
  }
}

/**
 * Like {@link discoveryCollector}, but its `poll()` blocks until `release()`
 * is called — for staging a tick that's still in flight when something else
 * (a `reset()`) happens concurrently. `whenPolled()` resolves the instant
 * `poll()` is entered (before it blocks), so a test can await the exact
 * boundary "the tick has started" instead of guessing a microtask count —
 * the same pattern `cli/index.test.ts`'s `OffsetCollector.whenPolled` uses.
 * Each `poll()` call re-arms both signals, so calling `release()` always
 * unblocks the MOST RECENT call.
 */
function createSlowCollector(): { collector: AnyCollector; whenPolled: () => Promise<void>; release: () => void } {
  let releaseCurrent: (() => void) | null = null
  let polledResolve: (() => void) | null = null
  let polledPromise = new Promise<void>((resolve) => {
    polledResolve = resolve
  })

  const collector: AnyCollector = {
    name: 'slow',
    initialSnapshot: () => ({ seen: false }),
    poll: (prev: { seen: boolean }, ctx: CollectorContext) => {
      polledResolve?.()
      return new Promise((resolve) => {
        releaseCurrent = () => {
          if (prev.seen) {
            resolve({ nextSnapshot: prev, events: [] })
          } else {
            resolve({
              nextSnapshot: { seen: true },
              events: [ctx.emit('collector.error', { collector: 'slow', message: 'discovered' })],
            })
          }
        }
      })
    },
  }
  return {
    collector,
    whenPolled: () => polledPromise,
    release: () => {
      releaseCurrent?.()
      polledPromise = new Promise((resolve) => {
        polledResolve = resolve
      })
    },
  }
}

describe('the poll loop, rebuildable (prd20 ruling 5, retarget spike Q1/gap a+b)', () => {
  it('reset() drops every collector back to initialSnapshot() — the next tick re-discovers everything, exactly as a fresh session boundary demands', async () => {
    const { recorder, events } = createFakeRecorder()
    const pollLoop = createPollLoop({
      repoPath: '/repo/watched',
      collectors: [discoveryCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
    })

    await pollLoop.tick()
    await pollLoop.tick()
    expect(events).toHaveLength(1) // discovered once, then quiet — the ordinary steady state

    await pollLoop.reset()
    await pollLoop.tick()

    // A session boundary just happened (rotation or retarget): the collector
    // has no memory of "the-one-worktree" anymore, so it fires again — this is
    // the fix for gap (a): a rotated/retargeted log that opens with warm
    // snapshots gets no discovery events at all for what already existed.
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ payload: { message: 'discovered the-one-worktree' } })
  })

  it('reset() with a snapshotStore repoints persistence — the fix for gap (b): snapshots stop landing in the closed session\'s directory', async () => {
    const { recorder } = createFakeRecorder()
    const oldStore = createFakeStore()
    const newStore = createFakeStore()
    const pollLoop = createPollLoop({
      repoPath: '/repo/watched',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: oldStore,
    })

    await pollLoop.tick()
    expect(oldStore.saves).toHaveLength(1)

    await pollLoop.reset({ snapshotStore: newStore })
    await pollLoop.tick()

    // The new session's snapshot dir gets the next persist — never the old one again.
    expect(newStore.saves).toHaveLength(1)
    expect(oldStore.saves).toHaveLength(1)
  })

  it('reset() without a snapshotStore keeps persisting to the SAME store — a plain rotation only needs the in-memory reset, never a new dir', async () => {
    const { recorder } = createFakeRecorder()
    const store = createFakeStore()
    const pollLoop = createPollLoop({
      repoPath: '/repo/watched',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: store,
    })

    await pollLoop.tick()
    await pollLoop.reset()
    await pollLoop.tick()

    expect(store.saves).toHaveLength(2)
  })

  it('reset({ repoPath }) re-points the ONE thing this module itself closes over (Q1) — a retarget\'s job, never a plain rotation\'s', async () => {
    const { recorder } = createFakeRecorder()
    const seenRepoPaths: string[] = []
    const repoPathSpy: AnyCollector = {
      name: 'spy',
      initialSnapshot: () => undefined,
      poll: (_prev: unknown, ctx: CollectorContext) => {
        seenRepoPaths.push(ctx.repoPath)
        return { nextSnapshot: undefined, events: [] }
      },
    }
    const pollLoop = createPollLoop({
      repoPath: '/repo/old',
      collectors: [repoPathSpy],
      recorder,
      exec: nullExec,
      now: () => 0,
    })

    await pollLoop.tick()
    await pollLoop.reset({ repoPath: '/repo/new' })
    await pollLoop.tick()

    expect(seenRepoPaths).toEqual(['/repo/old', '/repo/new'])
  })

  it('reset() clears a suppressed save-error, so a persist failure against the NEW store gets its own fresh report', async () => {
    const { recorder, events } = createFakeRecorder()
    const failingStore = createFakeStore()
    failingStore.failSave = new Error('disk full')
    const pollLoop = createPollLoop({
      repoPath: '/repo/watched',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: failingStore,
    })

    await pollLoop.tick()
    await pollLoop.tick()
    expect(events.filter((e) => e.type === 'collector.error' && 'message' in e.payload && String(e.payload.message).includes('snapshot save failed'))).toHaveLength(1)

    await pollLoop.reset()
    await pollLoop.tick()

    const saveErrorEvents = events.filter(
      (e) => e.type === 'collector.error' && 'message' in e.payload && String(e.payload.message).includes('snapshot save failed'),
    )
    expect(saveErrorEvents).toHaveLength(2)
  })

  it('reset() awaits an in-flight tick before clearing snapshots — a race here would silently reintroduce gap (a) for whichever collector was mid-poll at rotate time', async () => {
    const { recorder, events } = createFakeRecorder()
    const { collector, whenPolled, release } = createSlowCollector()
    const pollLoop = createPollLoop({ repoPath: '/repo/watched', collectors: [collector], recorder, exec: nullExec, now: () => 0 })

    const firstTick = pollLoop.tick() // begins
    await whenPolled() // ...and is now definitely blocked inside poll(), mid-tick

    const resetPromise = pollLoop.reset()
    let resetSettled = false
    void resetPromise.then(() => {
      resetSettled = true
    })

    // Reset must not have raced ahead of the tick it overlapped with.
    await Promise.resolve()
    await Promise.resolve()
    expect(resetSettled).toBe(false)
    expect(events).toHaveLength(0)

    release()
    await firstTick
    await resetPromise

    // The overlapping tick's own discovery landed normally — into the Map it
    // started with, not corrupted by the reset that was waiting on it.
    expect(resetSettled).toBe(true)
    expect(events).toHaveLength(1)

    // And the reset itself took effect cleanly once its wait was over: the
    // very next tick re-discovers, exactly as an uncontested reset() would.
    const secondTick = pollLoop.tick()
    await whenPolled()
    release()
    await secondTick
    expect(events).toHaveLength(2)
  })

  it('reset() never re-hydrates from ANY store, old or new — a session boundary means no snapshot survives it, even one the new store already holds', async () => {
    const { recorder, events } = createFakeRecorder()
    const seededStore = createFakeStore({ counter: { polls: 99 } })
    const pollLoop = createPollLoop({
      repoPath: '/repo/watched',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
    })

    await pollLoop.tick() // no store at boot — starts from initialSnapshot(), polls: 0
    await pollLoop.reset({ snapshotStore: seededStore })
    await pollLoop.tick()

    // If reset() had re-hydrated from the new store, this tick would have seen
    // `polls: 99` (what `seededStore` was pre-loaded with) instead of the
    // fresh `polls: 0` reset() itself just set — both ticks see the same
    // fresh start, proving the seeded store was never consulted.
    const messages = events
      .filter((e) => e.type === 'collector.error' && 'message' in e.payload)
      .map((e) => (e.type === 'collector.error' ? e.payload.message : undefined))
    expect(messages).toEqual(['saw 0', 'saw 0'])
  })

  it('reset() never re-hydrates even when it lands BEFORE the first tick — the sibling of the case above, where the hydration memo has not been set yet', async () => {
    const { recorder, events } = createFakeRecorder()
    const seededStore = createFakeStore({ counter: { polls: 99 } })
    const pollLoop = createPollLoop({
      repoPath: '/repo/watched',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
    })

    // No tick first, unlike the test above. `hydrate()` runs at most once and
    // memoizes on its FIRST call, so a reset before any tick used to leave
    // that memo unset — and the tick after it hydrated from the very store
    // the boundary was supposed to make irrelevant.
    await pollLoop.reset({ snapshotStore: seededStore })
    await pollLoop.tick()

    expect(seededStore.loads).toEqual([])
    const messages = events
      .filter((e) => e.type === 'collector.error' && 'message' in e.payload)
      .map((e) => (e.type === 'collector.error' ? e.payload.message : undefined))
    expect(messages).toEqual(['saw 0'])
  })
})

/**
 * A recorder whose Nth append (1-based) rejects and whose others land. Both
 * publishing paths append, so both share the count: `record` rejects on it,
 * and `recordAlarm` — which never rejects (ADR-0030) — reports it as
 * `{ appended: false }` and publishes nothing.
 */
function createRecorderFailingOn(n: number): { recorder: SessionRecorder; events: RhizomorphEvent[] } {
  const events: RhizomorphEvent[] = []
  let calls = 0
  const recorder = {
    record: async (event: RhizomorphEvent) => {
      calls += 1
      if (calls === n) throw new Error('ENOSPC: no space left on device')
      events.push(event)
    },
    recordAlarm: async (event: EventOf<'collector.error'>) => {
      calls += 1
      if (calls === n) return { appended: false }
      events.push(event)
      return { appended: true }
    },
  } as unknown as SessionRecorder
  return { recorder, events }
}

/** Emits three events derived from its snapshot, so an un-advanced snapshot re-derives the same batch. */
function batchCollector(name = 'batch'): AnyCollector {
  return {
    name,
    initialSnapshot: () => ({ polls: 0 }),
    poll: (prev: { polls: number }, ctx: CollectorContext) => ({
      nextSnapshot: { polls: prev.polls + 1 },
      events: [0, 1, 2].map((index) =>
        ctx.emit('collector.error', { collector: name, message: `poll ${prev.polls} event ${index}` }),
      ),
    }),
  }
}

const messagesOf = (events: readonly RhizomorphEvent[]) => collectorErrors(events).map((event) => event.payload.message)

describe('the poll loop advances its snapshot only once the batch is on disk (prd40 ruling 1)', () => {
  it('re-derives the WHOLE batch when the second event of three fails, appending the first twice', async () => {
    // Call 1 is event 0 (lands), call 2 is event 1 (rejects), call 3 is the
    // degrade `collector.error` the catch reports.
    const { recorder, events } = createRecorderFailingOn(2)
    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [batchCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
    })

    await pollLoop.tick()
    await pollLoop.tick()

    // The second poll was handed the SAME snapshot, so it re-derived poll 0's
    // batch — including the event whose append had already resolved.
    expect(messagesOf(events).filter((message) => message === 'poll 0 event 0')).toHaveLength(2)
    expect(messagesOf(events)).toEqual([
      'poll 0 event 0',
      'ENOSPC: no space left on device',
      'poll 0 event 0',
      'poll 0 event 1',
      'poll 0 event 2',
    ])
  })

  it('does not advance the snapshot when the only event fails, and re-emits it next tick', async () => {
    const { recorder, events } = createRecorderFailingOn(1)
    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
    })

    await pollLoop.tick()
    await pollLoop.tick()

    // 'saw 0' twice would mean the snapshot never advanced at all; once, after
    // the degrade line, is the event being re-derived exactly as intended.
    expect(messagesOf(events)).toEqual(['ENOSPC: no space left on device', 'saw 0'])
  })

  it('does not persist the snapshot for a batch that failed', async () => {
    const { recorder } = createRecorderFailingOn(2)
    const store = createFakeStore()
    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [batchCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: store,
    })

    await pollLoop.tick()

    expect(store.saves).toEqual([])
  })

  it('still reports a rejected append through the existing degrade path, and keeps ticking', async () => {
    const { recorder, events } = createRecorderFailingOn(1)
    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
    })

    await pollLoop.tick()

    const degraded = collectorErrors(events).filter((event) => event.payload.collector === 'counter')
    expect(degraded.map((event) => event.payload.message)).toEqual(['ENOSPC: no space left on device'])
    // The loop survived it: a later tick still polls.
    await expect(pollLoop.tick()).resolves.toBeUndefined()
  })

  it('leaves the clean path exactly as it was: the snapshot advances once per tick and persists once', async () => {
    const { recorder, events } = createFakeRecorder()
    const store = createFakeStore()
    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [countingCollector()],
      recorder,
      exec: nullExec,
      now: () => 0,
      snapshotStore: store,
    })

    await pollLoop.tick()
    await pollLoop.tick()

    expect(messagesOf(events)).toEqual(['saw 0', 'saw 1'])
    expect(store.saves).toEqual([
      { name: 'counter', snapshot: { polls: 1 } },
      { name: 'counter', snapshot: { polls: 2 } },
    ])
  })
})
