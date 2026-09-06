import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { foldStreamEvent, foldStreamEvents, initialStreamState } from './streamState.js'

/**
 * #183's OWN BEFORE/AFTER, measured at the sizes its DoD asks for.
 *
 * The operator felt this ("INCREDIBLY slow right now", 2026-08-05); the
 * conductor then measured a real 55k-event session's live page at 62 long
 * tasks, 224,805 ms of total blocking, one 31,010 ms single task, and zero
 * `requestAnimationFrame` samples during the window — the frame loop starved
 * entirely. The mechanism: `/api/stream` replays a whole fresh session
 * (there's no `Last-Event-ID` yet on first load, #166), and
 * `useEventStream.ts` used to fold every one of those events through its own
 * `setState`, each paying `foldStreamEvent`'s `events: [...state.events,
 * event]` — an O(n) copy per event, O(n²) over the burst. `#183` buffers the
 * burst — one eager fold for the first event, one batched
 * `foldStreamEvents` pass for whatever lands before that fold has actually
 * drained — instead of one `setState` per event. This bench isolates exactly
 * the fold cost that batched pass pays (the mechanism
 * `useEventStream.ts`'s hook now exercises for real); it does not drive a
 * browser event loop, since a synthetic one measures the stub, not the fold.
 *
 * Same discipline as `panels/ledger/perf.test.ts` (#171, itself restating
 * #157): rounds are **interleaved** (one `before` sample, one `after` sample,
 * repeated) so a sibling worktree's test run landing mid-bench inflates both
 * sides equally rather than "finding" a regression that was the load average.
 * Timings are reported, never asserted — a wall clock under concurrent
 * workers measures the box, not the code. The law beside the report is a
 * shape: `before` grows worse than linearly with N (it's the O(n²) burst
 * shape), `after` stays close to linear (a single O(n) pass), and the two
 * folds must agree bit-for-bit at every size — batching must never change
 * *what* gets folded, including which events land as news vs history, only
 * how many `setState`s it costs to fold them.
 *
 * **What it measured, on the dev box** (median of 3 interleaved rounds, which
 * is what `ROUNDS` was when this table was taken — see its note below for why
 * it is 1 now) — see `useEventStream.ts`'s own docstring for the same table,
 * carried there since that's the file this bench justifies:
 *
 * | N (events) | before (foldStreamEvent, per event) | after (foldStreamEvents, batched) | ratio  |
 * | ---------- | ------------------------------------ | ----------------------------------- | ------ |
 * | 5,000      | 29.4 ms                              | 1.8 ms                              | ~16x   |
 * | 15,000     | 630.1 ms                              | 5.8 ms                              | ~109x  |
 * | 55,000     | 20,880.2 ms                           | 24.5 ms                             | ~851x  |
 *
 * Growth 5k→55k (11x the events): before ~711x the time, after ~13x — the
 * O(n²) shape versus the O(n) shape it should have been.
 *
 * Re-run with `npm test -- packages/web/src/app/streamState.bench.test.ts` and
 * read the `console.log` lines for this box's own numbers.
 *
 * SPLIT OUT OF `streamState.test.ts`, and the filename is the whole mechanism.
 * `scripts/gate.sh` derives its timing set from a `// @gate-timing` marker or a
 * `*.bench.test.ts` name, and runs that set ALONE, serially, once — while
 * everything else runs four times concurrently as the load probe. This bench
 * carried neither, so it ran in all four copies of that probe: the
 * `BENCH_TIMEOUT_MS` note below records a single 55k call measured north of 49s
 * under exactly that contention, against ~21s alone. Nothing it asserts moved
 * with it; what changed is only which pass of the gate runs it — the one where
 * a wall clock means anything, which is the condition this bench always
 * documented needing.
 */
describe('the live fold cost, before vs after (#183)', () => {
  const SIZES = [5_000, 15_000, 55_000]
  // ONE round, not three, and the arithmetic is the whole argument: every
  // `perEventFold()` at 55k is a real O(n²) pass measured at ~21s on the dev
  // box, so each round costs that again. Three rounds plus a warm-up plus the
  // identity check was five such passes per run of this file — ~105s, paid on
  // every CI leg and (before the rename) in all four copies of the gate's load
  // probe.
  //
  // What three rounds bought was a median instead of a single sample, and the
  // median feeds exactly two things: the `report` line, which this bench's own
  // docstring says is reported and never asserted, and the growth-shape law at
  // the bottom, which compares ~21s against ~0.03s. No plausible outlier flips
  // a 700x ratio, so the law is exactly as strong on one sample as on three.
  // Raise this locally when you want a sharper number; nothing asserted moves.
  const ROUNDS = 1
  // Generous on purpose: this bench's own O(n²) `before` path genuinely
  // burns real CPU (not a sleep), and under sibling worktrees' own
  // concurrent `npm test` runs sharing the same machine, a single 55k-event
  // call has been observed north of 49s — two such calls happen here (the
  // warmed identity check, and `ROUNDS` timed rounds, per size).
  // 300_000ms was enough in isolation and timed out under that contention;
  // this headroom is a hermetic-under-concurrency fix, not a weaker law —
  // every assertion below is unchanged.
  const BENCH_TIMEOUT_MS = 1_200_000
  const connectedAt = Date.UTC(2026, 6, 31, 12, 0, 0)
  const paths = ['/repo/wt-a', '/repo/wt-b', '/repo/wt-c']

  /**
   * `worktree.dirty`, not `commit.landed`, for the same reason
   * `StreamContext.test.tsx`'s `#166` bench picks it: `@rhizomorph/core`'s
   * reducer keeps an ever-growing `commits` map (O(n) to copy per event on
   * its own), which would swamp the number this bench exists to isolate —
   * `streamState.ts`'s own `events: [...state.events, event]` copy. Cycling
   * three worktree paths keeps the core fold O(1) per event.
   *
   * A mix of history and a news tail (the last `NEWS_GRACE_MS` worth) rather
   * than an all-history burst, so the before/after equality check below
   * covers the news/history split too, not just `session`/`events`.
   */
  function burst(n: number): RhizomorphEvent[] {
    const f = createEventFactory({ idPrefix: 'bench-183', stepMs: 1000 })
    return Array.from({ length: n }, (_unused, i) => {
      const path = paths[i % paths.length]!
      const ts = connectedAt - (n - i) * 1000
      return f.worktreeDirty(
        { path, branch: path.split('/').pop()!, files: [{ path: `file-${i}.ts`, status: 'modified' }] },
        { ts },
      )
    })
  }

  function median(samples: readonly number[]): number {
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] as number
  }

  function report(line: string): void {
    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log(line)
  }

  it('reports foldStreamEvent (per event) against foldStreamEvents (batched) at 5k/15k/55k, and proves they agree', () => {
    const rows: { n: number; beforeMs: number; afterMs: number }[] = []

    for (const n of SIZES) {
      const events = burst(n)

      const perEventFold = () =>
        events.reduce((state, event) => foldStreamEvent(state, event), initialStreamState(connectedAt))
      const batchedFold = () => foldStreamEvents(initialStreamState(connectedAt), events)

      // The identity check IS the warm-up, deliberately: both folds are pure,
      // so a cold result equals a warm one bit for bit, and the timed rounds
      // below still start with a JIT these two calls warmed. Running a
      // discarded warm-up pair FIRST and then re-deriving the same two values
      // for the check spent a second full O(n²) pass at 55k — ~21s per run of
      // this file — to learn nothing the check does not already learn.
      //
      // The identity law (#166), reaffirmed at every size this DoD measures:
      // batching must not change one field of the result, news/history split
      // included — never weakened, only exercised at realistic scale.
      expect(batchedFold()).toEqual(perEventFold())

      const beforeSamples: number[] = []
      const afterSamples: number[] = []
      for (let round = 0; round < ROUNDS; round += 1) {
        let started = performance.now()
        const before = perEventFold()
        beforeSamples.push(performance.now() - started)
        expect(before.events).toHaveLength(events.length)

        started = performance.now()
        const after = batchedFold()
        afterSamples.push(performance.now() - started)
        expect(after.events).toHaveLength(events.length)
      }

      const beforeMs = median(beforeSamples)
      const afterMs = median(afterSamples)
      rows.push({ n, beforeMs, afterMs })
      report(
        `N=${n}: before (foldStreamEvent) ${beforeMs.toFixed(3)} ms · ` +
          `after (foldStreamEvents) ${afterMs.toFixed(3)} ms · ` +
          `${(beforeMs / Math.max(afterMs, 0.001)).toFixed(1)}x`,
      )
    }

    report(
      `growth, before: 5k→55k is ${(rows[2]!.beforeMs / Math.max(rows[0]!.beforeMs, 0.001)).toFixed(1)}x ` +
        `for 11x the events (after: ${(rows[2]!.afterMs / Math.max(rows[0]!.afterMs, 0.001)).toFixed(1)}x)`,
    )

    // THE LAW, a shape rather than a pinned number (#157's discipline): the
    // per-event path is genuinely superlinear over the burst (O(n²) from the
    // O(n) copy repeated n times), so 11x the events must cost noticeably
    // more than 11x the time. The batched path is a single O(n) pass, so its
    // own growth must stay well under the per-event path's.
    expect(rows[1]!.beforeMs).toBeGreaterThan(rows[0]!.beforeMs)
    expect(rows[2]!.beforeMs).toBeGreaterThan(rows[1]!.beforeMs)
    const beforeGrowth = rows[2]!.beforeMs / Math.max(rows[0]!.beforeMs, 0.001)
    const afterGrowth = rows[2]!.afterMs / Math.max(rows[0]!.afterMs, 0.001)
    expect(afterGrowth).toBeLessThan(beforeGrowth)
  }, BENCH_TIMEOUT_MS)
})
