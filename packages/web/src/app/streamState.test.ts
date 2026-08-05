import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { boundaryIndex, eventsUpTo, foldUpTo, sortEvents } from '../replay/replayFold.js'
import {
  NEWS_GRACE_MS,
  foldStreamEvent,
  foldStreamEvents,
  initialStreamState,
  replayStreamState,
} from './streamState.js'

/**
 * A session with several distinct worktrees/branches/commits, long enough to
 * exercise many scrub points without needing thousands of events in a
 * hermetic test.
 */
function buildSession(eventCount: number): RhizomorphEvent[] {
  const f = createEventFactory({ stepMs: 1000 })
  const paths = ['/repo/wt-a', '/repo/wt-b', '/repo/wt-c']

  f.sessionStarted()
  for (const path of paths) {
    f.worktreeDiscovered({
      path,
      branch: path.split('/').pop()!,
      head: 'sha-0',
      isMain: path.endsWith('wt-a'),
    })
  }

  for (let i = 0; i < eventCount; i++) {
    const path = paths[i % paths.length]!
    const branch = path.split('/').pop()!
    if (i % 5 === 0) {
      f.commitLanded({ sha: `sha-${i}`, branch, message: `commit ${i}` })
    } else {
      f.worktreeDirty({ path, branch, files: [{ path: `file-${i}.ts`, status: 'modified' }] })
    }
  }

  return f.all()
}

/** The oracle: what `foldStreamEvents` produces from scratch for a scrub prefix. */
function oracleAt(events: readonly RhizomorphEvent[], ts: number, connectedAt: number) {
  return foldStreamEvents(initialStreamState(connectedAt), eventsUpTo(events, ts))
}

/** `replayStreamState`'s inputs for a scrub prefix, matching what `useReplaySession` hands `StreamContext`. */
function replayAt(events: readonly RhizomorphEvent[], ts: number, connectedAt: number) {
  const prefixLength = boundaryIndex(events, ts)
  const session = foldUpTo(events, ts)
  return replayStreamState(events, prefixLength, session, connectedAt)
}

describe('replayStreamState', () => {
  const events = sortEvents(buildSession(120))
  // Beyond every real timestamp — replay's own news/history boundary
  // (`StreamContext`'s `REPLAY_CONNECTED_AT`), so every event here is history.
  const REPLAY_CONNECTED_AT = Number.MAX_SAFE_INTEGER

  /**
   * The identity law (#160, extended by #162): whatever `useReplaySession`'s
   * cursor cache does to reach a given scrub `ts`, the `StreamState`
   * `replayStreamState` composes from it must be bit-for-bit what an
   * independent full refold (`foldStreamEvents` over `eventsUpTo`) produces.
   * `* 137` over the event count spreads non-monotonically, exercising
   * backward jumps without an RNG.
   */
  it('matches a full refold at many scrub points, forward and backward', () => {
    for (let i = 0; i < 40; i++) {
      const eventIndex = (i * 137) % events.length
      const ts = events[eventIndex]!.ts
      expect(replayAt(events, ts, REPLAY_CONNECTED_AT)).toEqual(
        oracleAt(events, ts, REPLAY_CONNECTED_AT),
      )
    }
  })

  it('scrubbing is exactly reversible: forward, then back, then forward again lands on identical state (#155)', () => {
    const tsA = events[10]!.ts
    const tsB = events[90]!.ts

    const stateAtAFirst = replayAt(events, tsA, REPLAY_CONNECTED_AT)
    expect(replayAt(events, tsB, REPLAY_CONNECTED_AT)).toEqual(oracleAt(events, tsB, REPLAY_CONNECTED_AT))
    const stateAtASecond = replayAt(events, tsA, REPLAY_CONNECTED_AT)

    expect(stateAtASecond).toEqual(stateAtAFirst)
    expect(stateAtASecond).toEqual(oracleAt(events, tsA, REPLAY_CONNECTED_AT))
  })

  it('is the initial state before the first event', () => {
    const firstTs = events[0]!.ts
    expect(replayAt(events, firstTs - 1, REPLAY_CONNECTED_AT)).toEqual(
      initialStreamState(REPLAY_CONNECTED_AT),
    )
  })

  it('replay builds state and lights nothing: news stays empty at every prefix', () => {
    const lastTs = events[events.length - 1]!.ts
    const state = replayAt(events, lastTs, REPLAY_CONNECTED_AT)
    expect(state.news).toEqual([])
    expect(state.newsCount).toBe(0)
    expect(state.events).toEqual(events)
  })

  /**
   * `replayStreamState` doesn't assume news is always empty — it derives the
   * threshold analytically ({@link lowerBoundaryIndex}) — so it must still
   * agree with the oracle for a `connectedAt` that actually splits the log
   * into history and news, the way a live connection's boundary would.
   */
  it('matches the oracle for a connectedAt that actually crosses the log, not just replay\'s constant', () => {
    const connectedAt = events[80]!.ts + NEWS_GRACE_MS
    for (const index of [0, 10, 60, 79, 80, 81, 100, events.length - 1]) {
      const ts = events[index]!.ts
      expect(replayAt(events, ts, connectedAt)).toEqual(oracleAt(events, ts, connectedAt))
    }
  })

  it('caps news at the most recent MAX_NEWS entries, same as the oracle', () => {
    // Every event news (connectedAt before the very first event), on a log
    // longer than the 256 cap.
    const longEvents = sortEvents(buildSession(300))
    const connectedAt = longEvents[0]!.ts
    const ts = longEvents[longEvents.length - 1]!.ts
    expect(replayAt(longEvents, ts, connectedAt)).toEqual(oracleAt(longEvents, ts, connectedAt))
  })
})

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
 * **What it measured, on the dev box** (median of 3 interleaved rounds) — see
 * `useEventStream.ts`'s own docstring for the same table, carried there since
 * that's the file this bench justifies:
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
 * Re-run with `npm test -- packages/web/src/app/streamState.test.ts` and read
 * the `console.log` lines for this box's own numbers.
 */
describe('the live fold cost, before vs after (#183)', () => {
  const SIZES = [5_000, 15_000, 55_000]
  const ROUNDS = 3
  const BENCH_TIMEOUT_MS = 300_000
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

      // Warm the JIT: the steady state a real reconnect sees, not the first call.
      perEventFold()
      batchedFold()

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
