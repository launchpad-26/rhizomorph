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
  const execTimeoutMs = options.execTimeoutMs ?? COLLECTOR_EXEC_TIMEOUT_MS
  const tickBudgetMs = options.tickBudgetMs ?? COLLECTOR_TICK_BUDGET_MS
  /** Every collector subprocess is capped at `execTimeoutMs` (belt). */
  const boundedExec = withTimeout(exec, execTimeoutMs)
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
        snapshots.set(collector.name, result.nextSnapshot)
        for (const event of result.events) {
          await recorder.record(event)
        }
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

  return { start, stop, tick }
}
