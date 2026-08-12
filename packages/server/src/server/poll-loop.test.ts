import type { AnyCollector, CollectorContext, EventOf, Exec, ExecResult, RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it, vi } from 'vitest'
import { COLLECTOR_EXEC_TIMEOUT_MS, createPollLoop } from './poll-loop.js'
import type { SessionRecorder } from './recorder.js'
import type { LoadedSnapshot, SnapshotStore } from './snapshot-store.js'

function createFakeRecorder(): { recorder: SessionRecorder; events: RhizomorphEvent[] } {
  const events: RhizomorphEvent[] = []
  const recorder = {
    record: async (event: RhizomorphEvent) => {
      events.push(event)
    },
  } as unknown as SessionRecorder
  return { recorder, events }
}

/** A recorder whose every `record` call rejects — simulates a disk-full or permission-denied append. */
function createFailingRecorder(): SessionRecorder {
  return {
    record: async () => {
      throw new Error('ENOSPC: no space left on device')
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
