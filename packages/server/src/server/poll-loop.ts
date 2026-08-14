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
  /**
   * Drops every collector back to its own `initialSnapshot()` — the reset a
   * session boundary demands (prd20 retarget spike Q1): a collector only
   * emits a discovery event on a snapshot MISS, so a session that opens with
   * warm snapshots gets no `worktree.discovered`/`pane.discovered`/
   * `agent.status` for anything that already existed. This holds even for
   * the two machine-shaped collectors (tmux, workmux) that never held
   * `repoPath` in the first place — the reset is demanded by the SESSION
   * boundary, not the repo boundary. A session boundary means no snapshot
   * survives it, so — unlike a boot — this never re-hydrates from a store,
   * old or new: even a `snapshotStore` that already holds prior persisted
   * data is treated as write-only from here, never read from, because the
   * NEW session still owes a full round of discovery events regardless of
   * what any store remembers from before the boundary.
   *
   * `repoPath`, when given, re-points the ONE thing this module itself closes
   * over (Q1's headline finding: no collector holds it, only this loop does)
   * — a plain rotation never needs it, a retarget always does.
   *
   * `snapshotStore`, when given, replaces where persistence lands from here
   * on — the fix for the spike's gap (b): today, a snapshot store is bound at
   * boot to `snapshotDirFor(sessionDir, bootSessionId)`, so after a rotation
   * snapshots keep writing into the CLOSED session's directory and a later
   * resume of the new one never finds them. Omitted, persistence keeps
   * writing wherever it already was — in-memory snapshots still reset either
   * way, so the caller decides whether that also means a new file.
   *
   * Awaits any tick already in flight before touching anything, so that
   * tick's own snapshot writes land in the Map it started with rather than
   * racing the fresh one this creates — the caller does not need to `stop()`
   * the loop first, and nothing about the timer or its schedule is touched.
   */
  reset(options?: PollLoopResetOptions): Promise<void>
}

export interface PollLoopResetOptions {
  repoPath?: string
  snapshotStore?: SnapshotStore
}

/**
 * Runs every registered collector every `intervalMs`, recording whatever
 * events they emit. A collector throwing (bad parser, missing binary that
 * still isn't handled internally, whatever) becomes a `collector.error`
 * event instead of taking the loop down — one bad collector never stops the
 * others.
 */
export function createPollLoop(options: PollLoopOptions): PollLoop {
  const { collectors, recorder, exec } = options
  // Mutable, unlike every other closed-over option: `repoPath` is re-pointed
  // by `reset()` (a retarget's job), and `snapshotStore` is re-pointed by it
  // too (a rotation's job, fixing the spike's gap (b) — see `reset`'s doc).
  let repoPath = options.repoPath
  let snapshotStore = options.snapshotStore
  const intervalMs = options.intervalMs ?? 2000
  const now = options.now ?? Date.now
  const nextId = createIdFactory('evt')
  let snapshots = new Map<string, unknown>(collectors.map((c) => [c.name, c.initialSnapshot()]))
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

  async function reset(resetOptions: PollLoopResetOptions = {}): Promise<void> {
    // Let a tick already running finish against the Map/store it started
    // with. Its continuation and this one are both microtasks queued on the
    // same settled promise, so nothing new gets a chance to start in the gap
    // — see this function's own doc for why that ordering is what makes the
    // mutations below safe without touching the timer at all.
    await inFlightTick
    snapshots = new Map<string, unknown>(collectors.map((c) => [c.name, c.initialSnapshot()]))
    saveErrors.clear()
    repoPath = resetOptions.repoPath ?? repoPath
    snapshotStore = resetOptions.snapshotStore ?? snapshotStore
  }

  return { start, stop, tick, reset }
}
