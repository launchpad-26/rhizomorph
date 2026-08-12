import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { buildSessionIndex } from './replayFold.js'

/**
 * MEASUREMENT LANE for the two load-time findings against `buildSessionIndex`
 * (#342, #274), run through the surface both issues name rather than through
 * `reduceAll` alone — the index build is exactly one fold plus keyframe
 * snapshots plus one `isSorted` pass, so this is the number "open a long
 * recording" actually pays.
 *
 * Discipline copied from `reduce.bench.test.ts`, which learned it from
 * `scene/perf.test.ts`: a wall clock under `--maxWorkers` measures the box,
 * not the code, so raw timings are *reported* for a human and never asserted.
 * What IS asserted is a **ratio between two corpora folded in the same pass on
 * the same box** — load moves both sides together, so the ratio survives a
 * contended runner that would flunk any absolute budget.
 *
 * ## #342 — the commit-dense quadratic, and its budget
 *
 * The defect: `commit.landed` accumulated `state.commits` by Record spread —
 * `{ ...state.commits, [sha]: commit }` — copying every key the session had
 * gathered, per event. 25k events with 5,000 commits (a real working day
 * here) measured **3,768 ms** against **4.7 ms** for the same events with no
 * commits; capping the *growth* while keeping every event identical (the same
 * 5k `commit.landed` over 50 distinct shas) read 25 ms, so 99.3% of the cost
 * was growth-driven copying. Spreading the same commits across six branches
 * moved nothing (3,754 ms) — the per-branch list the issue suspected was no
 * term at all. Isolation tables on #342.
 *
 * The fix (`CommitsState` in core's `state.ts`): the slice is an append-only
 * log with `bySha`/`order` as memoized projections — #184's shape, ownership
 * rules and all. Re-measured after: **177.6 ms**, with the commit-free
 * baseline unchanged.
 *
 * **The residual, named rather than hidden.** The fold still appends
 * `[...log, commit]` — a pointer copy that grows with the log, the same
 * accepted floor #179 measured for `[...usage, record]` (~210 ms of the 491 ms
 * 55k fold) and left, because removing it means mutating an array a previous
 * frame still holds, which the purity laws forbid outright. So per-commit cost
 * is not perfectly flat and this file does not pretend it is: the law below
 * bounds the **growth-driven excess** — all-new shas against growth-capped
 * shas, same event count, same types, same pass. That ratio read ~150× before
 * the fix and ~1.6× after; the 3× budget catches the quadratic class coming
 * back while tolerating the purity floor and a loaded box.
 *
 * ## #274 — the 4.4 s table, re-measured on today's fold
 *
 * #274's numbers (34.6 ms / 234.4 ms / 4,425 ms at 5k / 25k / 55k) were
 * captured 2026-08-07 — **before #179, #184 and #342 landed**, and its
 * "superlinear jump" is those issues' mechanisms compounded. Where the 4.4 s
 * actually went, stated from measurement rather than guessed: the usage-fold
 * scans (#179) and the `byTrace` Record accumulation (#184) — together ~10.5 s
 * of the 11.2 s 55k `reduceAll` in `reduce.bench.test.ts`'s tables — plus the
 * commit Record spread (#342) for commit-dense logs. What the index build
 * adds on top of the linear fold: 111 shallow keyframe snapshots at 55k
 * (structurally shared — `reduce` replaces only the slices an event touches)
 * and one O(n) `isSorted` pass. The lane below reports today's number at
 * #274's own three sizes so the next reader starts from the instrument as it
 * is, not as it was.
 */

declare const performance: { now(): number }
declare const process: { stdout: { write(chunk: string): void } }

const BENCH_TIMEOUT_MS = 240_000

function report(line: string): void {
  process.stdout.write(`${line}\n`)
}

/** Median of three timed `buildSessionIndex` calls. */
function measure(events: readonly RhizomorphEvent[]): number {
  const samples: number[] = []
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now()
    buildSessionIndex(events)
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return samples[1] as number
}

/**
 * #342's own fixture shape: `total` events, every fifth a `commit.landed`
 * when `commitShas` is set — `Infinity` gives every commit a fresh sha (the
 * growth case), a finite pool keeps the accumulated structures small while
 * every event stays the same type and size (the control).
 */
function commitCorpus(total: number, commitShas: number | null): readonly RhizomorphEvent[] {
  const f = createEventFactory({ stepMs: 100, idPrefix: 'bench342' })
  f.sessionStarted({ sessionId: 's', repoPath: '/repo/r', repoName: 'r', mainBranch: 'main' })
  for (let i = 0; i < total; i += 1) {
    if (commitShas !== null && i % 5 === 0) {
      f.commitLanded({
        sha: commitShas === Infinity ? `sha-${i}` : `sha-${i % (commitShas * 5)}`,
        branch: 'main',
        message: `feat: change ${i}`,
        author: { name: 'A', email: 'a@example.com' },
        files: [{ path: `src/f-${i}.ts`, status: 'modified', insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      })
    } else {
      f.paneActivity({ paneId: '%1', contentHash: `h-${i}` })
    }
  }
  return f.all()
}

/**
 * A lean cut of `reduce.bench.test.ts`'s census (the audit's own type mix on a
 * real 55k-event session): pane.activity-dominant with the telemetry types
 * that made #274's original table superlinear, so today's numbers answer
 * yesterday's table rather than a softer workload.
 */
function censusCorpus(total: number): readonly RhizomorphEvent[] {
  const f = createEventFactory({ stepMs: 250, idPrefix: 'bench274' })
  f.sessionStarted({ sessionId: 's', repoPath: '/repo/r', repoName: 'r', mainBranch: 'main' })
  for (let i = 0; i < total; i += 1) {
    const slot = i % 100
    if (slot < 50) {
      f.paneActivity({ paneId: '%1', contentHash: `h-${i}` })
    } else if (slot < 69) {
      f.llmUsage({
        lane: 'w',
        role: 'worker',
        model: 'claude-opus-5',
        tokens: { input: 2, output: 500 + (i % 900), cacheRead: 50_000, cacheCreation: 1_000 },
        requestId: `req-${i}`,
        sessionId: 'sess-w',
        worktreePath: '/repo/r',
        branch: 'w',
      })
    } else if (slot < 82) {
      f.traceSpan({
        lane: 'w',
        role: 'worker',
        traceId: `trace-${i}`,
        spanId: `span-${i}`,
        parentSpanId: null,
        sessionId: 'sess-w',
      })
    } else if (slot < 90) {
      f.toolActivity({ lane: 'w', tool: 'Bash', role: 'worker', sessionId: 'sess-w', toolUseId: `toolu-${i}` })
    } else if (slot < 91) {
      f.commitLanded({
        sha: `sha-${i}`,
        branch: 'w',
        message: `feat: ${i}`,
        author: { name: 'A', email: 'a@example.com' },
        files: [{ path: `src/f-${i}.ts`, status: 'modified' }],
      })
    } else {
      f.paneActivity({ paneId: '%2', contentHash: `h2-${i}` })
    }
  }
  return f.all()
}

describe('buildSessionIndex under commit-dense load (#342)', () => {
  it('warms up', () => {
    buildSessionIndex(commitCorpus(2_000, Infinity))
    expect(true).toBe(true)
  }, BENCH_TIMEOUT_MS)

  it('bounds the growth-driven excess: all-new shas vs a capped sha pool, same events otherwise', () => {
    const baseline = measure(commitCorpus(25_000, null))
    const capped = measure(commitCorpus(25_000, 50))
    const dense = measure(commitCorpus(25_000, Infinity))

    report(`#342 · 25k events, 0 commits        : ${baseline.toFixed(1)} ms`)
    report(`#342 · 25k events, 5k commits/50sha : ${capped.toFixed(1)} ms`)
    report(`#342 · 25k events, 5k commits/new   : ${dense.toFixed(1)} ms`)
    report(
      `#342 · growth-driven excess ${(dense / capped).toFixed(2)}× ` +
        `(the Record-spread defect read ~150× here; the purity-floor residual read 1.1–1.6× while authoring)`,
    )

    // THE BUDGET (#342's done-when, spelled so a loaded box cannot flunk it):
    // both sides fold the same event count, the same types, the same sizes, in
    // the same pass — only the growth of the accumulated commit structures
    // differs. Re-introduce a per-event copy of anything that grows with the
    // commit count and this ratio explodes past any box's noise.
    expect(dense / capped).toBeLessThan(3)

    // And the fold actually did the work it claims to have measured.
    const index = buildSessionIndex(commitCorpus(25_000, Infinity))
    const last = index.keyframes[index.keyframes.length - 1]
    expect(index.events).toHaveLength(25_001)
    expect(last?.state.commits.order.length).toBe(5_000)
  }, BENCH_TIMEOUT_MS)
})

describe("buildSessionIndex at #274's own three sizes, on today's fold", () => {
  it('warms up', () => {
    buildSessionIndex(censusCorpus(2_000))
    expect(true).toBe(true)
  }, BENCH_TIMEOUT_MS)

  it('reports where the 2026-08-07 table stands after #179/#184/#342', () => {
    const results: Array<{ n: number; ms: number }> = []
    for (const n of [5_000, 25_000, 55_000]) {
      const ms = measure(censusCorpus(n))
      results.push({ n, ms })
      report(`#274 · buildSessionIndex(${n} events): ${ms.toFixed(1)} ms · ${((ms / n) * 1000).toFixed(2)} µs/event`)
    }

    const first = results[0] as { n: number; ms: number }
    const last = results[results.length - 1] as { n: number; ms: number }
    const perEventRatio = last.ms / last.n / (first.ms / first.n)
    // Reported, not asserted (the file header says why): whether today's
    // reading is a line or a curve is the human call, and the honest
    // comparison is against the 2026-08-07 instrument's own ~11.6× per-event
    // rise across these same three sizes.
    report(
      `#274 · µs/event grew ${perEventRatio.toFixed(2)}× across ${(last.n / first.n).toFixed(0)}× the events ` +
        `(the 2026-08-07 instrument read ~11.6× here)`,
    )

    expect(results).toHaveLength(3)
    expect(last.ms).toBeGreaterThan(0)
  }, BENCH_TIMEOUT_MS)
})
