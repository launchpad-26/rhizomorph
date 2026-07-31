import type { AnyCollector, CollectorContext, ObservatoryEvent } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import { createPollLoop } from './poll-loop.js'
import type { SessionRecorder } from './recorder.js'
import type { LoadedSnapshot, SnapshotStore } from './snapshot-store.js'

function createFakeRecorder(): { recorder: SessionRecorder; events: ObservatoryEvent[] } {
  const events: ObservatoryEvent[] = []
  const recorder = {
    record: async (event: ObservatoryEvent) => {
      events.push(event)
    },
  } as unknown as SessionRecorder
  return { recorder, events }
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
})
