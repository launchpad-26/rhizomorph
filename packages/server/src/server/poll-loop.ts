import type { AnyCollector, Exec, PollResult, RhizomorphEvent } from '@rhizomorph/core'
import { createCollectorContext, createEvent, createIdFactory } from '@rhizomorph/core'
import type { SessionRecorder } from './recorder.js'
import type { SnapshotStore } from './snapshot-store.js'
import { withTimeout } from './exec.js'

/** Per-exec ceiling for every collector subprocess (belt) — the same value as the doctor route's `ROUTE_EXEC_TIMEOUT_MS`. See `docs/design-notes/collector-tick-budget.md`. */
export const COLLECTOR_EXEC_TIMEOUT_MS = 5000
/** Per-collector-poll watchdog budget (suspenders), enforced in JS so it holds even when a child ignores SIGTERM or the hang is not in a subprocess at all. */
export const COLLECTOR_TICK_BUDGET_MS = 10_000

export interface PollLoopOptions {
  repoPath: string
  collectors: readonly AnyCollector[]
  recorder: SessionRecorder
  exec: Exec
  /** Defaults to 2000ms per architecture. */
  intervalMs?: number
  /** Per-exec ceiling handed to collectors. Defaults to {@link COLLECTOR_EXEC_TIMEOUT_MS}. */
  execTimeoutMs?: number
  /** Per-collector-poll watchdog budget. Defaults to {@link COLLECTOR_TICK_BUDGET_MS}. Injectable so tests don't wait real seconds. */
  tickBudgetMs?: number
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
  const execTimeoutMs = options.execTimeoutMs ?? COLLECTOR_EXEC_TIMEOUT_MS
  const tickBudgetMs = options.tickBudgetMs ?? COLLECTOR_TICK_BUDGET_MS
  /** Every collector subprocess is capped at `execTimeoutMs` (belt). */
  const boundedExec = withTimeout(exec, execTimeoutMs)
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
  /** A collector's still-pending poll from a prior tick, so a wedged one is skipped rather than re-entered — which is what keeps the others polling. */
  const inFlight = new Map<string, Promise<PollResult<unknown>>>()

  /** Sentinel a timed-out poll rejects with, told apart from a real poll error in the one catch below. */
  const TIMED_OUT = Symbol('collector-poll-timed-out')

  /**
   * Resolves with the poll's result, or rejects with {@link TIMED_OUT} once
   * `tickBudgetMs` elapses — enforced here in JS so it holds regardless of what
   * the underlying child does. The timer is cleared the instant the poll
   * settles (and unref'd), so it never holds the loop open.
   */
  function raceBudget(pollPromise: Promise<PollResult<unknown>>): Promise<PollResult<unknown>> {
    return new Promise<PollResult<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(TIMED_OUT), tickBudgetMs)
      timer.unref()
      pollPromise.then(
        (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

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

  /**
   * Reports a failure via the recorder without letting a *second* failure —
   * the report itself rejecting — escape as an unhandled rejection. The
   * reporting path is never the crash path (issue #239).
   */
  async function recordOrDegrade(event: RhizomorphEvent, collectorName: string): Promise<void> {
    try {
      await recorder.record(event)
    } catch (reportError) {
      console.error(
        `[rhizomorph] failed to report ${event.type} for ${collectorName}: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
      )
    }
  }

  async function persist(collector: AnyCollector, snapshot: unknown): Promise<void> {
    if (!snapshotStore) return
    try {
      await snapshotStore.save(collector.name, snapshot)
      saveErrors.delete(collector.name)
    } catch (error) {
      if (saveErrors.has(collector.name)) return
      saveErrors.add(collector.name)
      await recordOrDegrade(
        createEvent(
          'collector.error',
          {
            collector: collector.name,
            message: `snapshot save failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          { id: nextId(), ts: now() },
        ),
        collector.name,
      )
    }
  }

  async function runTick(): Promise<void> {
    await hydrate()
    for (const collector of collectors) {
      // A prior tick's poll for this collector is still pending (wedged): skip
      // it so the others keep polling at full speed, and so the timeout error
      // fires once per episode rather than every tick.
      if (inFlight.has(collector.name)) continue

      const tickNow = now()
      const context = createCollectorContext({ repoPath, now: tickNow, exec: boundedExec, nextId })
      const previous = snapshots.get(collector.name)
      try {
        const pollPromise = Promise.resolve(collector.poll(previous, context))
        inFlight.set(collector.name, pollPromise)
        // Detach: clear the slot when the poll eventually settles (a real hung
        // child is reaped by the exec ceiling), swallowing a late rejection so
        // an abandoned poll never surfaces as an unhandled rejection.
        void pollPromise
          .catch(() => {})
          .finally(() => {
            if (inFlight.get(collector.name) === pollPromise) inFlight.delete(collector.name)
          })

        const result = await raceBudget(pollPromise)
        // prd40 ruling 1 (ADR-0029): the snapshot advances only once every event
        // in this batch is on disk. A rejected append therefore leaves
        // `previous` in place and the next tick re-derives the WHOLE batch —
        // including the events whose appends already resolved, which are
        // appended twice. ADR-0029 rules that duplicate accepted; losing the
        // event is not.
        for (const event of result.events) {
          await recorder.record(event)
        }
        snapshots.set(collector.name, result.nextSnapshot)
        // Reference check: a collector that handed its snapshot straight back
        // (nothing new, or an error branch) has nothing to write.
        if (result.nextSnapshot !== previous) await persist(collector, result.nextSnapshot)
      } catch (error) {
        // #332's message (the timeout episode names its own budget) reported
        // through #361's guarded path (a failing report degrades, never crashes
        // the loop) — the two changes are orthogonal and both are kept.
        const message =
          error === TIMED_OUT
            ? `timed out after ${tickBudgetMs}ms`
            : error instanceof Error
              ? error.message
              : String(error)
        const errorEvent = createEvent(
          'collector.error',
          { collector: collector.name, message },
          { id: nextId(), ts: now() },
        )
        await recordOrDegrade(errorEvent, collector.name)
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
    // Settle the hydration memo, so this function's own no-re-hydration
    // promise holds for a reset that lands BEFORE the first tick as well as
    // after one. `hydrate()` runs at most once and memoizes on its FIRST
    // call, so leaving `hydration` null here meant the next tick would still
    // run it — against whichever store this reset had just installed.
    hydration = Promise.resolve()
    saveErrors.clear()
    repoPath = resetOptions.repoPath ?? repoPath
    snapshotStore = resetOptions.snapshotStore ?? snapshotStore
  }

  return { start, stop, tick, reset }
}
