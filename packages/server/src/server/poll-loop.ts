import type { AnyCollector, Exec } from '@rhizomorph/core'
import { createCollectorContext, createEvent, createIdFactory } from '@rhizomorph/core'
import type { SessionRecorder } from './recorder.js'
import type { SnapshotStore } from './snapshot-store.js'

export interface PollLoopOptions {
  repoPath: string
  collectors: readonly AnyCollector[]
  recorder: SessionRecorder
  exec: Exec
  /** Defaults to 2000ms per architecture. */
  intervalMs?: number
  /** Injectable clock so tests are deterministic. */
  now?: () => number
  /**
   * Where collector snapshots survive a restart. Omitted, snapshots stay
   * process-local and every boot starts each collector from its
   * `initialSnapshot()` — which is what makes a restart re-read everything.
   */
  snapshotStore?: SnapshotStore
}

export interface PollLoop {
  start(): void
  /** Clears the timer, then awaits the in-flight tick (if any) so nothing outlives "stopped". */
  stop(): Promise<void>
  /** Runs one tick immediately. Exposed for tests; start() also fires one on boot. */
  tick(): Promise<void>
}

/**
 * Runs every registered collector every `intervalMs`, recording whatever
 * events they emit. A collector throwing (bad parser, missing binary that
 * still isn't handled internally, whatever) becomes a `collector.error`
 * event instead of taking the loop down — one bad collector never stops the
 * others.
 */
export function createPollLoop(options: PollLoopOptions): PollLoop {
  const { repoPath, collectors, recorder, exec, snapshotStore } = options
  const intervalMs = options.intervalMs ?? 2000
  const now = options.now ?? Date.now
  const nextId = createIdFactory('evt')
  const snapshots = new Map<string, unknown>(collectors.map((c) => [c.name, c.initialSnapshot()]))
  /** Collectors whose snapshot failed to persist, so the error fires once, not every 2s. */
  const saveErrors = new Set<string>()

  let timer: ReturnType<typeof setInterval> | null = null
  /** The in-flight tick's own promise, held (not just a boolean) so `stop()` has something to await. */
  let inFlightTick: Promise<void> | null = null
  let hydration: Promise<void> | null = null

  /**
   * Replaces initial snapshots with whatever was persisted last run. Runs at
   * most once, awaited by the first tick rather than fired at construction, so
   * no poll can ever read a half-loaded Map.
   */
  function hydrate(): Promise<void> {
    if (!hydration) {
      hydration = (async () => {
        if (!snapshotStore) return
        for (const collector of collectors) {
          const loaded = await snapshotStore.load(collector.name)
          if (loaded.found) snapshots.set(collector.name, loaded.snapshot)
        }
      })()
    }
    return hydration
  }

  async function persist(collector: AnyCollector, snapshot: unknown): Promise<void> {
    if (!snapshotStore) return
    try {
      await snapshotStore.save(collector.name, snapshot)
      saveErrors.delete(collector.name)
    } catch (error) {
      if (saveErrors.has(collector.name)) return
      saveErrors.add(collector.name)
      await recorder.record(
        createEvent(
          'collector.error',
          {
            collector: collector.name,
            message: `snapshot save failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          { id: nextId(), ts: now() },
        ),
      )
    }
  }

  async function runTick(): Promise<void> {
    await hydrate()
    for (const collector of collectors) {
      const tickNow = now()
      const context = createCollectorContext({ repoPath, now: tickNow, exec, nextId })
      try {
        const previous = snapshots.get(collector.name)
        const result = await collector.poll(previous, context)
        snapshots.set(collector.name, result.nextSnapshot)
        for (const event of result.events) {
          await recorder.record(event)
        }
        // Reference check: a collector that handed its snapshot straight back
        // (nothing new, or an error branch) has nothing to write.
        if (result.nextSnapshot !== previous) await persist(collector, result.nextSnapshot)
      } catch (error) {
        await recorder.record(
          createEvent(
            'collector.error',
            {
              collector: collector.name,
              message: error instanceof Error ? error.message : String(error),
            },
            { id: nextId(), ts: now() },
          ),
        )
      }
    }
  }

  function tick(): Promise<void> {
    if (inFlightTick) return inFlightTick
    const promise = runTick().finally(() => {
      if (inFlightTick === promise) inFlightTick = null
    })
    inFlightTick = promise
    return promise
  }

  function start(): void {
    if (timer) return
    void tick()
    timer = setInterval(() => {
      void tick()
    }, intervalMs)
  }

  async function stop(): Promise<void> {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    await inFlightTick
  }

  return { start, stop, tick }
}
