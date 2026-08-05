import { createEventFactory, reduceAll, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'

/**
 * THE BEFORE/AFTER, MEASURED (#171, the audit's P1).
 *
 * Before this fix, `LedgerPanel` called `reduceAll(state.events)` on every
 * arriving event — a from-scratch re-fold of the whole log. After, it reads
 * `state.session`, the same fold `streamState.ts` already maintains
 * incrementally: a reference read, not a re-fold. This bench reports both
 * costs at three sizes so the claim is a number rather than an assertion.
 *
 * Same discipline as `scene/perf.test.ts` (#157's lesson): rounds are
 * **interleaved** (one `before` sample, one `after` sample, repeated) so a
 * sibling worktree's test run landing mid-bench inflates both sides equally
 * rather than "finding" a regression that was the load average. Timings are
 * reported, never asserted — a wall clock under concurrent workers measures
 * the box, not the code. The law beside the report is a shape: `before`
 * measurably grows with N (it is a genuine O(N) re-fold), `after` does not
 * (it's a property read, flat regardless of N).
 *
 * The event mixture below is synthetic rather than the real 55,049-event
 * session the audit measured on the live box (`~/.local/share/rhizomorph/…`)
 * — a test that reads a path outside the repo isn't hermetic on a stranger's
 * machine. It is shaped like that log's own census (pane.activity the
 * plurality, llm.usage/trace.span/tool.activity next, spread across many
 * branches) so `reduceAll`'s real cost shape — the telemetry fold scanning
 * `usage`/`costs` per event (audit P2) — is exercised the way a real fleet
 * exercises it, not by a single straight-line branch.
 *
 * **What it measured, on the dev box** (median of 3 interleaved rounds):
 *
 * | N (events) | before (reduceAll) | after (state.session) | ratio     |
 * | ---------- | ------------------- | ---------------------- | --------- |
 * | 5,000      | 73.590 ms           | 0.001 ms                | ~73,590x  |
 * | 15,000     | 874.960 ms          | 0.001 ms                | ~874,960x |
 * | 55,000     | 18,471.427 ms       | 0.001 ms                | ~18.4M x  |
 *
 * 11x the events (5k→55k) costs 251x the time — the O(n)-per-event telemetry
 * fold (audit P2) makes a single `reduceAll` call superlinear, not just
 * linear, on top of the O(N) re-fold-per-arriving-event this issue removes.
 * At the audit's real 55,049-event session, every arriving event used to pay
 * ~18.5 seconds of main-thread work; it now pays a reference read. Re-run
 * with `npm test -- packages/web/src/panels/ledger/perf.test.ts` and read the
 * `console.log` lines for this box's own numbers — the law below is what's
 * asserted, not these pinned figures.
 */

const SIZES = [5_000, 15_000, 55_000]
/**
 * A `reduceAll` call at N=55,000 costs ~18 seconds on its own (that number
 * *is* the finding) — so unlike `scene/perf.test.ts`'s sub-millisecond
 * canvas-stub calls, extra rounds here are expensive in wall-clock, not just
 * noisy. Three is enough to take a median without multiplying an
 * eighteen-second call by ten.
 */
const ROUNDS = 3
const BRANCH_COUNT = 24
/**
 * Generous, and it has to be: three sizes up to 55k real events, each folded
 * `ROUNDS + 1` times, at up to ~18s per fold — measured serial cost alone is
 * near a minute, and this suite runs under concurrency alongside every other
 * test file.
 */
const BENCH_TIMEOUT_MS = 300_000

/**
 * A deterministic session shaped like the real log's own census (the
 * 2026-08-05 audit): pane.activity the plurality, llm.usage/trace.span/
 * tool.activity next, a thin tail of cost/active-time — spread round-robin
 * over `BRANCH_COUNT` branches so the fold's per-branch and per-telemetry-
 * array work (`reduce.ts`'s `dedupedUsage`/`foldSessionCoverage`/`placeCosts`)
 * is exercised the way a real fleet exercises it.
 */
function syntheticSession(n: number): RhizomorphEvent[] {
  const f = createEventFactory({ idPrefix: 'bench', stepMs: 250 })
  f.sessionStarted()
  const branches = Array.from({ length: BRANCH_COUNT }, (_unused, i) => `bench-branch-${i}`)
  for (const branch of branches) {
    f.worktreeDiscovered({ path: `/repo-wt/${branch}`, branch, head: `sha-${branch}-0` })
  }

  type Emit = (branch: string, path: string) => void
  const emitPane: Emit = (branch) =>
    void f.paneActivity({ paneId: `%${branch}`, contentHash: `hash-${f.now()}` })
  const emitUsage: Emit = (branch, path) =>
    void f.llmUsage({ lane: branch, branch, worktreePath: path, requestId: `req-${f.now()}-${branch}` })
  const emitSpan: Emit = (branch, path) =>
    void f.traceSpan({
      lane: branch,
      branch,
      worktreePath: path,
      traceId: `trace-${f.now()}-${branch}`,
      spanId: `span-${f.now()}-${branch}`,
    })
  const emitTool: Emit = (branch, path) => void f.toolActivity({ lane: branch, branch, worktreePath: path })
  const emitCost: Emit = (branch, path) => void f.llmCost({ lane: branch, branch, worktreePath: path })
  const emitActiveTime: Emit = (branch, path) => void f.agentActiveTime({ lane: branch, branch, worktreePath: path })

  // Roughly the real log's proportions: pane.activity ~49%, llm.usage ~19%,
  // trace.span ~13%, tool.activity ~8%, the rest (~11%) split across cost and
  // active-time.
  const cycle: Emit[] = [
    ...Array.from({ length: 10 }, () => emitPane),
    ...Array.from({ length: 4 }, () => emitUsage),
    ...Array.from({ length: 3 }, () => emitSpan),
    ...Array.from({ length: 2 }, () => emitTool),
    emitCost,
    emitActiveTime,
  ]

  let produced = BRANCH_COUNT + 1 // sessionStarted + one worktree.discovered per branch
  let i = 0
  while (produced < n) {
    const branch = branches[i % branches.length]!
    const path = `/repo-wt/${branch}`
    cycle[i % cycle.length]!(branch, path)
    produced += 1
    i += 1
  }
  return f.all()
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function report(line: string): void {
  // eslint-disable-next-line no-console -- the measurement is the deliverable
  console.log(line)
}

describe('the ledger refold cost, before vs after (#171)', () => {
  it('reports reduceAll(events) against a folded-reference read, interleaved, at 5k/15k/55k', () => {
    const rows: { n: number; beforeMs: number; afterMs: number }[] = []

    for (const n of SIZES) {
      const events = syntheticSession(n)
      // What `streamState.ts` already maintains incrementally — the "after"
      // side never re-folds, it just holds the reference.
      const folded = reduceAll(events)

      const beforeSamples: number[] = []
      const afterSamples: number[] = []
      for (let round = 0; round < ROUNDS; round += 1) {
        // BEFORE — the panel's old `useMemo(() => reduceAll(state.events), …)`.
        const t0 = performance.now()
        const before = reduceAll(events)
        beforeSamples.push(performance.now() - t0)
        expect(before.eventCount).toBe(events.length)

        // AFTER — `const session = state.session`. Interleaved with `before`
        // in the same round so both see the same machine at the same instant.
        const t1 = performance.now()
        const after = folded
        afterSamples.push(performance.now() - t1)
        expect(after.eventCount).toBe(events.length)
      }

      const beforeMs = median(beforeSamples)
      const afterMs = median(afterSamples)
      rows.push({ n, beforeMs, afterMs })
      report(
        `N=${n}: before (reduceAll) ${beforeMs.toFixed(3)} ms · ` +
          `after (state.session) ${afterMs.toFixed(3)} ms · ` +
          `${(beforeMs / Math.max(afterMs, 0.001)).toFixed(0)}x`,
      )
    }

    report(
      `growth, before: 5k→55k is ${(rows[2]!.beforeMs / Math.max(rows[0]!.beforeMs, 0.001)).toFixed(1)}x ` +
        `for 11x the events`,
    )

    // THE LAW, and it is a shape rather than a pinned number (#157's own
    // discipline — a wall clock under concurrent workers measures the box).
    // `before` is a genuine re-fold: it must cost measurably more at 55k
    // events than at 5k. `after` is a reference read: it must stay flat and
    // cheap regardless of N.
    expect(rows[1]!.beforeMs).toBeGreaterThan(rows[0]!.beforeMs)
    expect(rows[2]!.beforeMs).toBeGreaterThan(rows[1]!.beforeMs)
    expect(rows.every((row) => row.afterMs < 1)).toBe(true)
  }, BENCH_TIMEOUT_MS)
})
