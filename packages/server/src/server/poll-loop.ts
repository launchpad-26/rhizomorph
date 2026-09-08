import type { AnyCollector, EventOf, Exec, LaneManifest, PollResult } from '@rhizomorph/core'
import { buildFleet, createCollectorContext, createEvent, createIdFactory, evidenceLine, parseLaneManifest } from '@rhizomorph/core'
import { readLanesManifest, type LanesResult } from '../api/lanes.js'
import type { SessionRecorder } from './recorder.js'
import type { SnapshotStore } from './snapshot-store.js'
import { withTimeout } from './exec.js'
import { diffSummons, isSummonsKind, SUMMONS_SNAPSHOT_KEY, type SummonsCondition, type SummonsPoint } from './summons.js'

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
  /**
   * prd17 ruling 5 — every (lane, kind) pair with a summons currently open, as
   * of the last tick that successfully recorded its diff. Not a collector
   * snapshot (there is no collector named `SUMMONS_SNAPSHOT_KEY`), but
   * persisted through the same `SnapshotStore` so it survives a restart the
   * same way — see `raiseSummons()` below and `docs/adr/`.
   */
  let summonsState: readonly SummonsPoint[] = []
  /**
   * Which session's fold {@link summonsState} was last diffed against —
   * this raiser's own guard against a race `reset()` alone cannot close.
   * `api/rotate.ts`'s own mutating route empties the recorder's fold
   * immediately (`recorder.openSession()`) BEFORE it goes on to call
   * `pollLoop.reset()`. A tick landing in that gap would otherwise see a
   * brand-new, empty fold while `summonsState` still holds the OLD session's
   * open points, diff them against the wrong session, and emit a
   * `summons.cleared` for every one — mis-recorded into the NEW session's
   * log for a condition that never actually cleared (caught in review,
   * #278).
   */
  let summonsSessionId: string | null = null
  /**
   * A manifest read still pending from a prior tick, mirroring the
   * per-collector `inFlight` map below for the one non-collector read this
   * loop makes: `readLanesManifest` never rejects on its own (an absent or
   * unparseable file both degrade to `{ available: false }` internally), so
   * the only way it fails to settle is a genuinely wedged filesystem — and
   * without this, a fresh dangling read would stack up every `intervalMs`
   * forever (caught in review, #278).
   */
  let manifestInFlight: Promise<LanesResult> | null = null
  /**
   * Consecutive manifest-read timeouts not yet recovered from — 0 means
   * healthy. Round-2 review, finding 4: `collector.error` latches
   * `state.collectors['summons']` at `status: 'error'` and only
   * `collector.recovered` clears it; every real collector gets that signal
   * from `withResilience`, which the raiser is never wrapped by, so without
   * this a single timed-out read left the fold unable to ever say `summons`
   * was healthy again.
   *
   * #301 — armed by the timeout's own alarm having been APPENDED to the log,
   * not by the timeout merely having occurred: `recordAlarm` is the one
   * publish-without-append path (`{ appended: false }` on a full disk), and a
   * `collector.recovered` persisted with no persisted `collector.error`
   * behind it is a replayed record claiming a recovery from nothing — exactly
   * what prd-17's own integrity rulings exist to forbid. See the increment
   * site below.
   */
  let summonsManifestFailures = 0

  let timer: ReturnType<typeof setInterval> | null = null
  /** The in-flight tick's own promise, held (not just a boolean) so `stop()` has something to await. */
  let inFlightTick: Promise<void> | null = null
  let hydration: Promise<void> | null = null
  /** A collector's still-pending poll from a prior tick, so a wedged one is skipped rather than re-entered — which is what keeps the others polling. */
  const inFlight = new Map<string, Promise<PollResult<unknown>>>()

  /** Sentinel a timed-out poll rejects with, told apart from a real poll error in the one catch below. */
  const TIMED_OUT = Symbol('collector-poll-timed-out')

  /**
   * Resolves with `promise`'s own result, or rejects with {@link TIMED_OUT}
   * once `budgetMs` elapses — enforced here in JS so it holds regardless of
   * what the awaited work actually is. Originally just a collector's
   * subprocess poll; generalized (review of #278) so `raiseSummons()`'s
   * manifest read gets the identical treatment rather than a bespoke
   * mechanism of its own. The timer is cleared the instant `promise` settles
   * (and unref'd), so it never holds the loop open — and `promise` itself is
   * never cancelled: this is JS-level abandonment, the same "suspenders"
   * limit the collector case already had, not a kill.
   */
  function raceBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(TIMED_OUT), budgetMs)
      timer.unref()
      promise.then(
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
        // The raiser's own edge-state, restored the same way — this is what
        // makes mutation #2 (dropping persistence) fail: without it, a
        // condition still open across a restart re-raises on the very first
        // tick of the new process instead of staying quiet.
        const loadedSummons = await snapshotStore.load(SUMMONS_SNAPSHOT_KEY)
        if (loadedSummons.found && Array.isArray(loadedSummons.snapshot)) {
          summonsState = loadedSummons.snapshot as SummonsPoint[]
        }
      })()
    }
    return hydration
  }

  /**
   * Reports a failure via the recorder without letting a *second* failure —
   * the report itself rejecting — escape as an unhandled rejection. The
   * reporting path is never the crash path (issue #239).
   *
   * `recordAlarm` rather than `record`, because on a full disk this alarm's own
   * append fails too, and `record` publishes nothing when its append fails —
   * which would silence the alarm in exactly the case it exists for (prd-40
   * success 2, and success 1's one named exception; ADR-0030). It appends when
   * it can, emits to subscribers either way, and never rejects — so there is no
   * catch here to write.
   *
   * The `console.error` stays beside the emit rather than behind it: the DoD
   * asks for a line the operator can find afterwards, and prd41 #10 owns the
   * `api/lab.ts` stderr override that can silence one. Two channels, not one.
   *
   * Returns whether the append actually landed (prd17 w7 #301) — a caller
   * that arms a recovery on this alarm's say-so (the manifest-timeout path
   * below) needs to know, since a failed append leaves nothing in the log for
   * `collector.recovered` to answer.
   */
  async function recordOrDegrade(
    event: EventOf<'collector.error'>,
    collectorName: string,
  ): Promise<{ appended: boolean }> {
    const { appended } = await recorder.recordAlarm(event)
    if (!appended) {
      console.error(
        `[rhizomorph] failed to report ${event.type} for ${collectorName}: the session log could not be written`,
      )
    }
    return { appended }
  }

  /**
   * `name` is a collector's own name for a collector's snapshot, and
   * {@link SUMMONS_SNAPSHOT_KEY} for the raiser's edge-state — the store
   * itself is dumb, keyed by string, and never knows the difference.
   */
  async function persist(name: string, snapshot: unknown): Promise<void> {
    if (!snapshotStore) return
    try {
      await snapshotStore.save(name, snapshot)
      saveErrors.delete(name)
    } catch (error) {
      if (saveErrors.has(name)) return
      saveErrors.add(name)
      await recordOrDegrade(
        createEvent(
          'collector.error',
          {
            collector: name,
            message: `snapshot save failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          { id: nextId(), ts: now() },
        ),
        name,
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

        const result = await raceBudget(pollPromise, tickBudgetMs)
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
        if (result.nextSnapshot !== previous) await persist(collector.name, result.nextSnapshot)
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

    await raiseSummons()
  }

  /**
   * prd17 ruling 5 — the instrument raises its own summons, on the tick, from
   * the very state every other route already reads: `recorder.foldSoFar()`
   * folded through `buildFleet`, the lane manifest through
   * `readLanesManifest`/`parseLaneManifest`. Nothing here re-judges a lane;
   * it only asks whether `buildFleet`'s own pathologies changed since the
   * last tick this function completed.
   *
   * Failure here is reported exactly like a collector's (`collector.error`,
   * named `summons`) and never crashes the loop or the other collectors —
   * this runs after all of them, so a bad tick here has already cost nothing
   * else. `summonsState` and its persisted snapshot are only advanced past
   * `try`'s last line: a rejected `recorder.record` throws before either
   * updates, so the next tick recomputes and re-attempts the SAME diff
   * (ADR-0029's own rule — a rejected append leaves the state that would have
   * advanced past it exactly where it was).
   *
   * **Round-2 review, the class both MUST-FIX findings share:** this function
   * holds one `await` (the manifest read), and everything read BEFORE it may
   * describe a world that no longer exists by the time it resumes. Both
   * `recorder.sessionId`/`recorder.foldSoFar()` (finding 1) and off-fence's
   * dependence on a manifest that may have gone stale mid-read (finding 2)
   * are read or decided AFTER that await now, never before it.
   */
  async function raiseSummons(): Promise<void> {
    try {
      const tickNow = now()

      let manifest: LaneManifest | null = null
      // Round-2 review, finding 2: a DEGRADED read (timed out, or still
      // wedged from a prior tick) means "we do not know the current fence
      // state" — absence of evidence, not evidence of absence — as distinct
      // from a read that SETTLED and definitively found no manifest file.
      // Only the former gets off-fence's special preservation below; the
      // latter is a real, settled fact and off-fence correctly stops firing,
      // exactly as it always has for an absent manifest.
      let manifestDegradedThisTick = false
      if (!manifestInFlight) {
        const pending = readLanesManifest(repoPath)
        manifestInFlight = pending
        // Detached exactly like a collector's poll: if this settles long
        // after its own tick gave up on it, the slot simply clears and the
        // next tick reads fresh — nothing here can surface as an unhandled
        // rejection.
        void pending
          .catch(() => {})
          .finally(() => {
            if (manifestInFlight === pending) manifestInFlight = null
          })

        try {
          const manifestResult = await raceBudget(pending, tickBudgetMs)
          manifest = manifestResult.available ? parseLaneManifest(manifestResult) : null
          // Round-2 review, finding 4: the read itself completed — whatever
          // it found — so the filesystem is no longer wedged. Symmetric with
          // `withResilience`'s own `collector.recovered` emission: recovery
          // means the ATTEMPT succeeded, not that it found anything in
          // particular.
          if (summonsManifestFailures > 0) {
            await recorder.record(
              createEvent(
                'collector.recovered',
                { collector: 'summons', consecutiveFailures: summonsManifestFailures },
                { id: nextId(), ts: tickNow },
              ),
            )
            summonsManifestFailures = 0
          }
        } catch (error) {
          if (error !== TIMED_OUT) throw error
          manifestDegradedThisTick = true
          // Never aborts the whole tick — a hang here must never be worse
          // than a missing file — but no longer claims off-fence simply
          // "does not fire this tick" (round-2 finding 2's false comment):
          // see the preservation below for what actually happens to it.
          //
          // prd17 w7 #301 — the recovery below is armed by this alarm having
          // been APPENDED to the log, not by the timeout having merely
          // occurred: `collector.recovered` answers a `collector.error` the
          // fold can actually see, and a failed append (a full disk, same as
          // any other alarm) leaves no such event for it to answer. Read
          // `recordOrDegrade`'s own `{ appended }` rather than assuming the
          // attempt counts — the sibling half of this pair (the recovery's
          // OWN record failing to append) is handled a few lines down, by the
          // same rule every other `recorder.record` in this function already
          // follows (ADR-0029): a rejected append leaves the counter exactly
          // where it was and re-throws, so the next tick re-attempts the same
          // recovery rather than one that silently gave up on it.
          const { appended } = await recordOrDegrade(
            createEvent(
              'collector.error',
              { collector: 'summons', message: `manifest read timed out after ${tickBudgetMs}ms` },
              { id: nextId(), ts: tickNow },
            ),
            'summons',
          )
          if (appended) summonsManifestFailures += 1
        }
      } else {
        // The previous tick's read is still wedged. Skip issuing a second
        // one — `manifest` stays null, same as this tick having found none
        // at all — and the timeout error above already fired once for this
        // episode; it does not fire again every `intervalMs` while the read
        // stays hung (mirrors the collector `inFlight` skip's own "fires
        // once per episode" comment above). Still degraded, for the same
        // "we do not know" reason as a fresh timeout.
        manifestDegradedThisTick = true
      }

      // Round-2 review, finding 1: read fresh, AFTER the only await above —
      // a rotation's route empties the fold (`recorder.openSession()`)
      // synchronously, and a tick can be parked on the manifest read while
      // that happens. Reading `sessionId`/`foldSoFar()` before the await
      // would describe the OLD session even after it closed. Treat a change
      // exactly like `reset()` would: drop the stale points without emitting
      // a clear for any of them (they belong to a session that has already
      // closed) and let this tick's own diff start from empty.
      if (summonsSessionId !== null && summonsSessionId !== recorder.sessionId) {
        summonsState = []
      }
      summonsSessionId = recorder.sessionId

      const fleet = buildFleet(recorder.foldSoFar(), { now: tickNow, manifest })

      const conditions: SummonsCondition[] = []
      for (const lane of fleet.lanes) {
        for (const pathology of lane.pathologies) {
          if (!isSummonsKind(pathology.kind)) continue
          conditions.push({
            lane: lane.id,
            kind: pathology.kind,
            since: pathology.since,
            detail: evidenceLine(pathology),
          })
        }
      }

      // Round-2 review, finding 2: `off-fence` is the one kind `buildFleet`
      // ever derives from the manifest, so when THIS tick's read was
      // degraded, it is spliced out of both sides of the diff and carried
      // into `next` untouched — neither cleared (the read failed, it did not
      // learn the fence went away) nor spuriously re-raised next tick (it
      // was never cleared in the first place). Without this, a timed-out
      // read cleared an open off-fence summons and the next healthy read
      // re-raised it: a clear-then-raise cycle on the one family whose
      // stated purpose is making exactly that computable (chattering).
      let previousForDiff = summonsState
      let preservedOffFence: readonly SummonsPoint[] = []
      if (manifestDegradedThisTick) {
        preservedOffFence = summonsState.filter((point) => point.kind === 'off-fence')
        previousForDiff = summonsState.filter((point) => point.kind !== 'off-fence')
      }

      const { diff, next: diffedNext } = diffSummons(previousForDiff, conditions, tickNow)
      const next = manifestDegradedThisTick ? [...diffedNext, ...preservedOffFence] : diffedNext

      for (const raise of diff.raised) {
        await recorder.record(
          createEvent(
            'summons.raised',
            {
              lane: raise.lane,
              kind: raise.kind,
              raisedAt: raise.raisedAt,
              ...(raise.detail !== undefined ? { detail: raise.detail } : {}),
            },
            { id: nextId(), ts: tickNow },
          ),
        )
      }
      for (const clear of diff.cleared) {
        await recorder.record(
          createEvent(
            'summons.cleared',
            { lane: clear.lane, kind: clear.kind, clearedAt: clear.clearedAt },
            { id: nextId(), ts: tickNow },
          ),
        )
      }

      summonsState = next
      // Same reference-check spirit as a collector's own `persist` call: skip
      // the write when nothing changed, rather than touching disk every 2s
      // forever on a calm fleet.
      if (diff.raised.length > 0 || diff.cleared.length > 0) {
        await persist(SUMMONS_SNAPSHOT_KEY, next)
      }
    } catch (error) {
      await recordOrDegrade(
        createEvent(
          'collector.error',
          { collector: 'summons', message: error instanceof Error ? error.message : String(error) },
          { id: nextId(), ts: now() },
        ),
        'summons',
      )
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
    // The raiser's edge-state resets the same way a collector's snapshot
    // does, for the same reason: a session boundary means the NEW session's
    // log starts with nothing, so a condition still true right now must
    // still get its own `summons.raised` in the new log, regardless of what
    // the old in-memory state (or a store this reset just installed) says was
    // already announced.
    summonsState = []
    // Kept in step with the state it guards: a `reset()` that runs strictly
    // after `recorder.openSession()` (the production ordering) would already
    // have `summonsSessionId` read as stale on the very next tick and self-
    // correct there — this just means the correction has nothing left to do.
    summonsSessionId = recorder.sessionId
    // Round-2 review, finding 3: a genuinely wedged manifest read never
    // settles, so without this the slot stayed occupied forever and no
    // later tick — even after a retarget points `repoPath` at a healthy
    // repo — would ever issue a fresh read. Dropping the reference here
    // does not cancel the old read (still nothing can); it just stops this
    // loop from waiting on it, exactly like every other piece of state
    // `reset()` already drops rather than carries across a boundary.
    manifestInFlight = null
    summonsManifestFailures = 0
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
