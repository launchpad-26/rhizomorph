/**
 * Bounded fan-out for independent async work — prd-44 ruling 3's declared cap.
 *
 * Two structural properties, both asserted in `concurrency.test.ts`:
 *
 * 1. **At most `limit` tasks are in flight.** Six collectors each fanning out
 *    per entity could otherwise start 40+ subprocesses at once, and the
 *    reference box is an 8 GB machine that already thrashes at four concurrent
 *    lanes. See {@link COLLECTOR_FANOUT_LIMIT}.
 * 2. **Results come back in the order the tasks were given**, never the order
 *    they finished. The record is hash-chained (ADR-0009), so a collector
 *    gathers concurrently and then appends in its own original sequence — that
 *    is what keeps a replay of the same inputs byte-identical, and it is
 *    ruling 3's acceptance criterion rather than a hope about scheduling.
 *
 * The intended shape at a call site is therefore two phases, and the second one
 * is not optional:
 *
 * ```ts
 * const outcomes = await mapBounded(worktrees, (worktree) => runGit(context, ['status', '--porcelain'], worktree.path))
 * for (const [index, outcome] of outcomes.entries()) {   // original order — the append phase
 *   if (!outcome.ok) { ...report...; continue }
 *   ...emit events for worktrees[index]...
 * }
 * ```
 *
 * **Why that loop iterates `.entries()` instead of indexing, which is not
 * style.** `noUncheckedIndexedAccess` is on (`tsconfig.base.json`), so
 * `outcomes[index]` has type `FanoutOutcome<T> | undefined`. That `undefined`
 * is unreachable — property 1 above guarantees one outcome per task at the
 * task's own index — but the guarantee is a comment and the compiler cannot
 * read it, so every indexing consumer has to write *something* for a case that
 * cannot happen. `outcomes.entries()` yields `[number, FanoutOutcome<T>]` with
 * no union at all, which is why the example is written that way.
 *
 * Two things it does not solve, both of which cost a lane a detour:
 *
 * - **The input at that index is still `| undefined`.** Iterating the outcomes
 *   fixes the outcome, not the parallel array beside it: `worktrees[index]`
 *   above, or `pathsToResolve[index]` in `collectors/tmux/collector.ts`, needs
 *   its own check. Iterating the *input* and indexing the outcomes has the
 *   mirror problem, which is why that file uses both shapes in one `poll()`.
 * - **A fixed-arity destructure cannot use `.entries()` at all.**
 *   `const [statusOutcome, listOutcome] = await runBounded([...])` gives BOTH
 *   bindings `| undefined`, and there is no iteration to hide behind. That is
 *   the case that forced the first of the three helpers below.
 *
 * **The three answers already in this repo, and the one difference that
 * matters.** All three consumers arrived here in the same wave and each solved
 * the same compiler behaviour differently — the note exists because #34, #35
 * and #36 each independently recommended writing it down:
 *
 * - `collectors/workmux/collector.ts`'s `unwrapExecOutcome` — **throws**
 *   (`runBounded returned fewer outcomes than tasks given`), and rethrows an
 *   `ok: false` reason too, because for that collector an `Exec` that rejected
 *   means `server/exec.ts`'s own contract broke.
 * - `collectors/git/git-collector.ts`'s `execResultOf` and `aheadBehindOf` —
 *   **synthesize a failed result** and let the collector's ordinary degrade
 *   path report it.
 * - `collectors/tmux/collector.ts` — **no helper**: `.entries()` for the phase
 *   that can use it, and `outcome?.ok` with an inline fallback for the one
 *   indexed lookup that cannot.
 *
 * So on the same impossible input, workmux **dies** and git **degrades**. That
 * is the choice a fourth consumer is making, and it should make it on purpose:
 * throw when a violated contract should stop the whole collector, synthesize
 * when one entity's result should fail while the rest of the tick continues.
 * Pick one of the three and say which; a fifth idiom is the thing this note
 * exists to prevent.
 *
 * **This module has no timeout and no cancellation story, on purpose.**
 * `withTimeout` (`server/exec.ts`) is already the one exec ceiling, wired at
 * `poll-loop.ts:91`; a bounded exec is guaranteed to settle, so this file
 * composes with it rather than growing a second timer. It imports nothing —
 * not `exec.ts`, not a dependency — and a law asserts that.
 *
 * A rejecting task never cancels a sibling and never breaks the pool: its
 * reason is returned at its own index. This is `session-log-writer.ts:86`'s
 * `tail` chain read one level up — there, the chain continues from a settled
 * promise while the failed append still rejects for the caller that issued it;
 * here, the pool keeps pulling while the failed index still carries its reason.
 */

/**
 * The ceiling: at most four tasks in flight per fan-out.
 *
 * **Why four.** The reference box is an 8 GB machine that already thrashes at
 * four concurrent agent lanes, and the loops this exists for are per-entity:
 * prd-44 measured 20 sequential spawns at 282.4 ms against 94.7 ms fully
 * concurrent, so four rounds-of-five keeps nearly all of that win without ever
 * asking the box for more processes than it is known to survive.
 *
 * **Why a per-call cap is also the per-process ceiling today.** `runTick`
 * (`poll-loop.ts`) awaits each collector in turn — the six are deliberately
 * NOT polled concurrently (prd-44 measured 1.3x / 0.6x / 1.4x and rejected
 * it) — so at most one fan-out is ever live. Whether the cap should become a
 * process-wide budget is prd-44's open question 3, unruled; if the poll loop
 * ever fans out across collectors, this number stops being a process ceiling
 * and that question has to be answered before it does.
 */
export const COLLECTOR_FANOUT_LIMIT = 4

/** One task's outcome. `reason` is the thrown value itself, neither wrapped nor coerced. */
export type FanoutOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: unknown }

/**
 * Runs `tasks` with at most `limit` in flight, resolving with one outcome per
 * task **at the task's own index**, whatever order they finished in.
 *
 * Never rejects for a task's sake: a thrown value (synchronously from the thunk
 * or asynchronously from its promise) becomes `{ ok: false, reason }` at that
 * index and nothing else is disturbed. It rejects only for a caller error — a
 * `limit` that is not an integer >= 1 — and in that case starts no task at all.
 *
 * `limit` defaults to {@link COLLECTOR_FANOUT_LIMIT}; passing a larger value is
 * the caller taking responsibility for the box.
 */
export async function runBounded<T>(
  tasks: readonly (() => T | PromiseLike<T>)[],
  limit: number = COLLECTOR_FANOUT_LIMIT,
): Promise<FanoutOutcome<T>[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`fan-out limit must be an integer >= 1, got ${String(limit)}`)
  }

  const outcomes = new Array<FanoutOutcome<T>>(tasks.length)
  // One shared iterator, pulled from by every worker. `next()` is synchronous,
  // so a worker claims its index before it can await — which is the whole of
  // the mutual exclusion, and it keeps the index attached to the task rather
  // than recomputed from a counter.
  const queue = tasks.entries()

  async function worker(): Promise<void> {
    for (const [index, task] of queue) {
      try {
        outcomes[index] = { ok: true, value: await task() }
      } catch (reason) {
        outcomes[index] = { ok: false, reason }
      }
    }
  }

  // No worker ever rejects (every body is caught above), so this settles only
  // when every task has, and one failure cancels nothing.
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))
  return outcomes
}

/**
 * {@link runBounded} over a collection: `worker` is invoked lazily, at most
 * `limit` at a time, and `outcomes[i]` is `items[i]`'s.
 */
export function mapBounded<I, R>(
  items: readonly I[],
  worker: (item: I, index: number) => R | PromiseLike<R>,
  limit: number = COLLECTOR_FANOUT_LIMIT,
): Promise<FanoutOutcome<R>[]> {
  return runBounded(
    items.map((item, index) => () => worker(item, index)),
    limit,
  )
}
