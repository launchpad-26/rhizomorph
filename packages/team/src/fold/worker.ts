import type { FoldFaults } from '../ingest/faults.js'
import { readJournal } from '../journal/read.js'
import type { EventRow, TeamStorage } from '../storage/contract.js'
import { lowWaterMark, readCursor, writeCursor } from './cursor.js'
import { projectionsFor } from './projections.js'
import { toEventRow } from './row.js'

/**
 * ORDERING 2, THE FOLD (prd-51 ruling 4).
 *
 * ```
 * read the journal from the cursor
 *   -> BEGIN -> INSERT ... ON CONFLICT DO NOTHING -> the projections -> COMMIT
 *   -> THEN persist the cursor, tmp-then-rename
 * ```
 *
 * The cursor moves last, and the reason is the executed mutation: under
 * cursor-first, a death between the cursor write and the commit advances past a
 * batch whose rows rolled back, and the restart skips it — 15,000 lines lost
 * across 30 kills. Under commit-first the same death replays a committed batch,
 * which dedups. **A rewind costs time, not rows.**
 *
 * ## THE FOLD NEVER CREATES A PARTITION
 *
 * `migrations/0003_roles_rls.sql` grants `rz_ingest` INSERT on `events` and no
 * CREATE anywhere. A worker that created a partition on demand would fail on
 * the first real host with a permission error — and `CREATE TABLE … PARTITION OF`
 * takes an ACCESS EXCLUSIVE lock on the parent besides, on the hot path. So the
 * monthly window is topped up at **boot** (`../api/main.ts`), and a row whose
 * `ts` falls outside every existing partition fails its insert loudly: the
 * transaction rolls back, the cursor does not move, and an operator sees it.
 * Fail-closed. `worker.test.ts` asserts the recorded statements of a fold
 * contain no `CREATE` at all.
 *
 * ## THE FOLD IS PER ACTOR (ruling 16)
 *
 * This loop used to assemble every row from every record past the cursor **before** opening the
 * transaction, and return on the first refusal. So one line the build could not read discarded
 * the records *before* it as well as after: nothing was inserted, the cursor file was never
 * created, and every actor in the journal stopped rather than only the skewed one. Reproduced
 * three times on #410, four good lines landing nowhere.
 *
 * It now groups the records past the cursor by `(project, actorInstance)`, so one group's
 * failure stops that group only. Within a group the records are folded in seq order and a
 * refusal stops **that group there**, keeping everything before it: ruling 3 forbids a gap in
 * `n` among what reached storage, so `n=8` must not land when `n=7` refused — but the positions
 * before the refusal are not a gap and there is no reason to hold them back.
 *
 * Two things this does NOT change. The transaction is still ONE call carrying every group's rows
 * together, so ruling 4's ordering — commit, then cursor — is untouched and F7 still catches a
 * cursor-first swap. And a `malformed` line still refuses loudly: after ruling 16 an `unknown`
 * line lands as a row (`row.ts`), so the only thing left that can stop a group is a line that is
 * not an event at all.
 */

export interface FoldDeps {
  readonly journalPath: string
  readonly cursorPath: string
  readonly storage: TeamStorage
  readonly faults?: FoldFaults | undefined
  readonly trace?: ((step: string) => void) | undefined
}

export type FoldResult =
  | {
      ok: true
      /** Journal records folded this run. 0 when the cursor is already at the tail. */
      readonly records: number
      /** Rows the batch carried. */
      readonly rows: number
      /** Rows that actually landed — 0 for a complete replay. */
      readonly inserted: number
      /** Where the journal cursor now stands — the low-water mark over every known actor. */
      readonly cursor: number
      /**
       * Groups that stopped early, with the position that stopped them. Empty on a clean run.
       *
       * A run where EVERY group refuses at its first record is still `ok: true` with nothing
       * inserted and this populated: it is a fold that made no progress and says so, which is
       * the DoD's *"an operator can name which `(actor, n)` was not folded and why, without
       * reading the journal by hand"*. `ok: false` stays reserved for a journal-level failure.
       */
      readonly refused: readonly { actorInstance: string; n: number; error: string }[]
    }
  | { ok: false; error: string }

/** One pass over everything the journal holds past the cursor. Never throws. */
export async function runOnce(deps: FoldDeps): Promise<FoldResult> {
  const cursor = readCursor(deps.cursorPath)

  const journal = readJournal(deps.journalPath, cursor.seq)
  deps.trace?.('fold.read')
  if (!journal.ok) return { ok: false, error: journal.error }
  if (journal.records.length === 0) {
    return { ok: true, records: 0, rows: 0, inserted: 0, cursor: cursor.seq, refused: [] }
  }

  // Grouped by (project, actorInstance): one group's refusal must stop that group only.
  const groups = new Map<string, { actorInstance: string; records: typeof journal.records }>()
  for (const record of journal.records) {
    const key = `${record.entry.project} ${record.entry.actorInstance}`
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, { actorInstance: record.entry.actorInstance, records: [record] })
    } else {
      group.records.push(record)
    }
  }

  const rows: EventRow[] = []
  const refused: { actorInstance: string; n: number; error: string }[] = []

  /**
   * The last seq this read covers. `readJournal` returns a CONTIGUOUS span from `cursor.seq`
   * (`read.ts`'s chain rule is `seq = previous + 1` from byte 0), so an actor with no record in
   * that span has no record in it — everything of its own is at or below `cursor.seq` and was
   * folded on an earlier pass.
   */
  const head = journal.records[journal.records.length - 1]?.seq ?? cursor.seq

  /**
   * EVERY ACTOR IS COMMITTED THROUGH `head` UNTIL ONE PROVES OTHERWISE.
   *
   * `lowWaterMark` is a minimum, and seeding it with the seq each actor last HAPPENED TO APPEAR
   * at makes the journal wait on actors that are not waiting for anything. Two costs, and they
   * differ in kind:
   *
   * - **Permanent, before the pruning below.** `actorInstance` is the session id
   *   (`packages/server/src/shipper/cursor.ts` says so of its own `actors` map), so a deployment
   *   accumulates one per session forever. A session that simply ENDED kept its final seq in
   *   `actors`, and the minimum sat there for good: nothing stuck, nothing refused, every row
   *   landing, and the fold re-reading the whole journal on every tick — which `journal.ts`
   *   records as growing without bound (ADR-0046).
   * - **Per pass, and this is what `head` is for.** Even with retired actors dropped, the
   *   minimum over the actors in ONE read is the earliest of their last appearances, so a clean
   *   pass over interleaved actors leaves the cursor mid-span and re-reads the rest next tick.
   *
   * A group that folded everything it had is committed through the whole span it was shown.
   * Only a group that STOPPED may sit below `head`, which is what the minimum was always meant
   * to mean: the point every actor has committed through, not the point the least recently
   * active one reached.
   */
  const marks: Record<string, number> = {}
  for (const key of Object.keys(cursor.actors)) marks[key] = head

  for (const [key, group] of groups) {
    // The mark is this actor's own committed point, not the journal's. A record at or below it
    // was folded on an earlier pass, so it is skipped before a row is built rather than being
    // rebuilt and left to `ON CONFLICT DO NOTHING`.
    const mark = cursor.actors[key] ?? cursor.seq
    let furthest = mark
    let stopped = false

    for (const record of group.records) {
      if (stopped) break
      if (record.seq <= mark) continue

      const built: EventRow[] = []
      for (const entry of record.entry.batch) {
        const row = toEventRow(record.entry.project, record.entry.actorInstance, entry.n, entry.line)
        if (!row.ok) {
          // Stop THIS group here and keep every row before it. The positions already built in
          // earlier records are not a gap; the ones after this one would be.
          refused.push({
            actorInstance: group.actorInstance,
            n: entry.n,
            error: `journal seq ${record.seq}: ${row.error}`,
          })
          stopped = true
          break
        }
        built.push(row.row)
      }
      if (stopped) break

      rows.push(...built)
      furthest = record.seq
    }

    // `head`, not `furthest`, when nothing stopped this group: it folded everything it had in
    // this span, so it is committed through the whole of it. `furthest` is only the seq it last
    // APPEARED at, and an actor that never appears again would hold that position for good.
    marks[key] = stopped ? furthest : head
  }

  const target = lowWaterMark(marks)

  /**
   * Everything at or below `target` is folded for every actor, so an entry equal to it says
   * exactly what `seq` already says — `readCursor`'s `actors[key] ?? cursor.seq` fallback
   * reconstructs it unchanged. Dropping those is lossless, and it is what keeps `actors` bounded
   * by the actors currently BEHIND the rest rather than growing one permanent entry per session
   * this deployment has ever seen. A clean pass leaves it empty.
   */
  const actors: Record<string, number> = {}
  for (const [key, mark] of Object.entries(marks)) if (mark > target) actors[key] = mark

  if (rows.length === 0) {
    // Nothing to insert — every group either refused at its first new record or had nothing new.
    // No transaction is opened: there is nothing to commit, so ruling 4's commit-then-cursor
    // ordering has nothing to order, and `worker.test.ts` asserts `appendEvents` is not called.
    // The cursor still moves if a group caught up without producing rows (an empty batch).
    if (target !== cursor.seq) {
      deps.trace?.('cursor.write')
      writeCursor(deps.cursorPath, { seq: target, actors }, deps.faults)
      deps.trace?.('cursor.rename')
    }
    return {
      ok: true,
      records: journal.records.length,
      rows: 0,
      inserted: 0,
      cursor: target,
      refused,
    }
  }

  try {
    deps.faults?.afterReadBeforeBegin?.()

    deps.trace?.('fold.begin')
    const inserted = await deps.storage.appendEvents(rows, (landed) => {
      // Inside the transaction, after the inserts and before the commit — which
      // is exactly where a fault has to fire to prove the rollback, and exactly
      // where the delta has to be computed to be idempotent.
      deps.trace?.('fold.insert')
      deps.faults?.afterInsertBeforeCommit?.()
      return projectionsFor(landed)
    })
    deps.trace?.('fold.commit')

    deps.faults?.afterCommitBeforeCursor?.()

    deps.trace?.('cursor.write')
    writeCursor(deps.cursorPath, { seq: target, actors }, deps.faults)
    deps.trace?.('cursor.rename')

    return {
      ok: true,
      records: journal.records.length,
      rows: rows.length,
      inserted,
      cursor: target,
      refused,
    }
  } catch (cause) {
    return {
      ok: false,
      error: `fold of journal seq ${target} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}

/**
 * THE SUPERVISOR — what actually calls {@link runOnce} in the deployment (#564).
 *
 * `runOnce` shipped complete in #373 and **nothing called it**. The ingest route journalled
 * durably, `startTeamServer` exposed an `onBatch` seam documented as *"Wakes the fold worker"*,
 * and `deploy/serve.ts` passed no `onBatch` — so every batch was accepted, fsynced, acked, and
 * never folded. Measured on the real host by #514's drill: two 202s with incrementing
 * `journalSeq`, 572 bytes in `/data/journal/ingest.log`, and `select count(*) from events` = 0
 * after an 8 s wait. Unfolded, not lost — which is why a drain from position 0 recovers it.
 *
 * ## ONE WORKER, IN THE APP PROCESS (prd-51's 2026-09-16 amendment)
 *
 * The amendment rules that the fold runs on the in-process seam and that #564 does not get
 * `compose.yml`. The mechanical reason is in `cursor.ts`: `writeCursor` is tmp-then-rename with
 * **no lock of any kind** — no `flock`, no O_EXCL, no pid file. Two processes folding the same
 * journal would each compute a low-water mark from its own read and rename over the other's, so
 * a second compose service is not a scaling knob, it is a cursor corruption. `ADR-0056` carries
 * the decision and the consequence: **this deployment may not run two app replicas** until
 * something elects a leader.
 *
 * ## THE DRAIN LOOPS ON THE CURSOR, NEVER ON THE RECORD COUNT
 *
 * `runOnce` returns `ok: true` with `records > 0` and the cursor **unmoved** when every group
 * refuses at its first new record — that is its documented `refused` state, not an error. So a
 * loop written `while (result.records > 0)` spins forever on one malformed line, which is the
 * exact input `worker.test.ts` already keeps around. The loop condition is therefore **strict
 * advance of the cursor**, and the case that would otherwise hang is a test below.
 *
 * ## WHY IT COALESCES
 *
 * `wake()` is wired to `notify`, which fires on the ingest hot path once per accepted batch. A
 * burst of batches must not start a fold each: they would read the same journal concurrently and
 * race the cursor exactly as two processes would. At most one pass runs; a wake arriving during
 * one sets `dirty` and is satisfied by a single follow-up pass, however many wakes arrived.
 *
 * `wake()` also never throws and never returns a promise. A fold failure must not become a
 * refused batch — that would invert ruling 4, which puts durability at the journal and lets the
 * fold be retried.
 */

export interface FoldWorkerDeps extends FoldDeps {
  /** Injected so tests never sleep on a real timer. Defaults to `setTimeout`. */
  readonly setTimer?: ((fn: () => void, ms: number) => unknown) | undefined
  readonly clearTimer?: ((handle: unknown) => void) | undefined
  /** Every pass's result, in order — the operator's log, and the tests' pass counter. */
  readonly onResult?: ((result: FoldResult) => void) | undefined
  /** Re-armed after each drain settles. `0` disables the tick: wake and boot drain only. */
  readonly tickMs?: number | undefined
}

export interface FoldWorker {
  /** Fold until the cursor stops moving. Safe to call concurrently — it coalesces. */
  drain(): Promise<void>
  /** Wake the worker. Never throws and never returns a promise: it is a `notify` callback. */
  wake(): void
  /** Stop the tick and await whatever is in flight. */
  stop(): Promise<void>
}

export function startFoldWorker(deps: FoldWorkerDeps): FoldWorker {
  /**
   * `Number.isFinite`, not just `> 0` (#564, found at verification).
   *
   * `Number('5s')` is `NaN`, `NaN <= 0` is **false**, and `setTimeout(fn, NaN)` is clamped by
   * Node to 1 ms — so a plausible operator typo in `RZ_TEAM_FOLD_TICK_MS` turned the safety tick
   * into a ~1 ms loop re-walking the WHOLE journal from byte 0 each time, on a file ADR-0046
   * already records as growing without bound. Measured: 145 drains in 200 ms. The runbook invites
   * operators to set this variable, so the guard belongs here rather than only at the caller.
   */
  const requested = deps.tickMs ?? 0
  const tickMs = Number.isFinite(requested) ? requested : 0
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  /**
   * ONE LOOP, A DIRTY FLAG, AND A LIST OF WAITERS.
   *
   * The first version of this coalesced by chaining onto the in-flight promise and re-entering
   * `drain()`. It spun: the re-entry set `dirty` unconditionally, so each follow-up pass
   * scheduled another one and the suite pinned a core. The `while (dirty)` loop below cannot do
   * that — `dirty` is cleared at the TOP of each iteration, so N wakes arriving during one pass
   * buy exactly one more pass, and a pass during which nothing wakes ends the loop.
   */
  let running = false
  let dirty = false
  let waiters: (() => void)[] = []
  let stopped = false
  let timer: unknown = null
  let loop: Promise<void> = Promise.resolve()

  /**
   * A SUBSCRIBER THAT THROWS MUST NOT STOP THE FOLD.
   *
   * `runOnce` catches its own failures and returns `ok: false`, so nothing INSIDE a pass
   * rejects — but `onResult` is the caller's code, called outside it, and `deploy/serve.ts`
   * passes one that writes to the console. Unguarded, its exception escapes the pass, rejects
   * the loop promise and surfaces at `stop()`, taking the worker down over a log line. Found by
   * the test below, which was vacuous until it was pointed at this path instead of at a
   * storage failure.
   */
  function report(result: FoldResult): void {
    if (deps.onResult === undefined) return
    try {
      deps.onResult(result)
    } catch {
      // Deliberately swallowed, and deliberately not logged: the thing that failed IS the log.
    }
  }

  /** One pass: fold until the cursor stops advancing. Never throws — `runOnce` never does. */
  async function pass(): Promise<void> {
    let previous = readCursor(deps.cursorPath).seq
    for (;;) {
      const result = await runOnce(deps)
      report(result)
      // A journal-level failure ends this pass. The worker stays alive: the next wake or tick
      // retries, and the cursor has not moved, so nothing is skipped.
      if (!result.ok) return
      if (result.cursor <= previous) return
      previous = result.cursor
    }
  }

  async function run(): Promise<void> {
    running = true
    try {
      do {
        dirty = false
        await pass()
      } while (dirty)
    } finally {
      running = false
      const settled = waiters
      waiters = []
      for (const resolve of settled) resolve()
      // ARMED HERE, which is the only place that cannot precede a drain. See `arm()`.
      arm()
    }
  }

  function drain(): Promise<void> {
    // STOPPED IS FINAL (#564, found at verification). `stopped` used to be read only by `arm()`,
    // so a `wake()` arriving after `stop()` resolved started a fresh pass — reachable from
    // `serve.ts`, whose shutdown stops the worker BEFORE closing the server, then ends the sql
    // connection underneath it.
    if (stopped) return Promise.resolve()
    // Set BEFORE the running check, so a wake landing in the last microtask of a pass is not lost.
    dirty = true
    const waited = new Promise<void>((resolve) => waiters.push(resolve))
    if (!running) {
      // The returned promise is `waited`, not `loop`, so `loop` needs its own rejection handler:
      // an unhandled rejection kills the process, and `run()` is not as total as it looks —
      // `runOnce` writes the cursor outside its own try/catch.
      loop = run()
      loop.catch(() => undefined)
    }
    return waited
  }

  /**
   * THE TICK IS ARMED AFTER THE FIRST DRAIN, NEVER AT CONSTRUCTION (#564, found at verification).
   *
   * It used to be armed in this function's body. `deploy/serve.ts` constructs the worker BEFORE
   * `startTeamServer`, and that call re-runs the migration preflight and tops up the monthly
   * partitions before it listens — so with the production default of 5000 ms, any startup slower
   * than five seconds fired a full fold pass before the partitions existed. On the first boot of
   * a new month that pass inserts rows with no partition to land in, fails closed and logs. It
   * self-heals, but it makes the boot-drain ordering ADR-0056 calls load-bearing a thing the code
   * defeated on its own, with no refactor required.
   *
   * Arming from the drain's completion path instead means the first tick cannot precede the first
   * drain — which is the boot drain — and the steady-state behaviour is unchanged.
   */
  function arm(): void {
    if (stopped || tickMs <= 0) return
    // Never two timers: `run()` arms on every completion, and a tick-triggered drain completes
    // like any other, so without this a tick would leave its own timer behind each round.
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      void drain().catch(() => undefined)
    }, tickMs)
  }

  return {
    drain,
    wake(): void {
      dirty = true
      void drain().catch(() => undefined)
    },
    async stop(): Promise<void> {
      stopped = true
      if (timer !== null) clearTimer(timer)
      timer = null
      /**
       * ONE await, and the reason it is enough is `stopped` rather than luck.
       *
       * This was `while (running) await loop`, guarding against `drain()` reassigning `loop`
       * mid-stop. It cannot: `drain()` returns early once `stopped` is set, and `loop` is only
       * assigned when nothing is running — so the value captured here is the last `run()` there
       * will be. Delta verification showed the loop form untestable, reverting it to a single
       * await left 95/95 green, and machinery whose necessity cannot be demonstrated is worse
       * than none: it reads as a guarded race to the next person and guards nothing.
       */
      await loop.catch(() => undefined)
    },
  }
}
