import { describe, expect, it } from 'vitest'
import { createEventFactory, type EventFactory } from './fixtures.js'
import { reduceAll } from './reduce.js'
import type { EventType, RhizomorphEvent } from './events/index.js'

/**
 * `packages/core` carries no `lib.dom` and no `@types/node` (it runs in the
 * browser too — see `basename`'s own comment in `fixtures.ts`), so neither
 * global is declared for `tsc`. Both genuinely exist at runtime under
 * vitest's `node` environment (`vitest.config.ts`); these are the minimal
 * shapes this file actually calls, declared locally rather than reaching for
 * a package-wide `lib`/`types` change that is out of this issue's fence.
 */
declare const performance: { now(): number }
declare const process: { stdout: { write(chunk: string): void } }

/**
 * MEASUREMENT LANE (#174), against the 2026-08-05 adversarial audit's P2
 * finding: `reduce.ts`'s telemetry fold scans a growing array per event —
 * `dedupedUsage`'s `findIndex` (:473) over `telemetry.usage`, and
 * `withTelemetry`'s `placeCosts` (:711, a `.map` over `telemetry.costs`) on
 * every telemetry event. Both arrays grow with the session, so a from-scratch
 * `reduceAll` is claimed to cost O(n²) in the telemetry event count.
 *
 * **This file measures. It does not fix.** No production code changes here —
 * see the fence in prompts/174. If the curve below confirms the claim, the
 * index fix (usage by `requestId`, costs by `sessionId`) is a separate,
 * groomed lane; this issue's whole job is to say honestly whether that lane
 * is worth opening.
 *
 * **Discipline, copied from `scene/perf.test.ts`** (its own header explains
 * why): timings are *reported*, never asserted. A wall clock under
 * `--maxWorkers` measures the box, not the code — the same 55k-event fold
 * that takes under a second on a quiet box can take several times that
 * alongside sibling worktrees' suites. So every `expect` below is a shape or
 * a count (event totals, record totals, a generous hang timeout), and the
 * ms/event numbers go in prose, read by a human, not asserted by the suite.
 *
 * **The corpus.** A deterministic event stream built from the audit's own
 * census of a real 55,049-event session (§"P2 — Reducer telemetry fold"):
 * ~49% `pane.activity`, ~19% `llm.usage`, ~13% `trace.span`, plus
 * `tool.activity`/`agent.activeTime`/`llm.cost` and a handful of git/pane
 * bookkeeping types, spread across six lanes with unique `requestId`s (the
 * worst case for `dedupedUsage`'s scan — every call runs to the end of the
 * array without a match, exactly what the audit's own dedup sweep found true
 * of 197 real session logs: "single-slot dedup... zero" cross-collector
 * repeats). No `Math.random`, no wall-clock seed — the same corpus every run.
 *
 * ---
 *
 * **THE CURVE, MEASURED ON THE DEV BOX** (median of 3 runs per N, after a
 * warmup pass):
 *
 * | N      | reduceAll   | µs/event |
 * | ------ | ----------- | -------- |
 * | 5,000  | 73.29 ms    | 14.66    |
 * | 15,000 | 602.92 ms   | 40.19    |
 * | 30,000 | 2,767.96 ms | 92.27    |
 * | 55,000 | 11,201.44 ms| 203.66   |
 *
 * A flat cost-per-event would read the same at every N; instead it grew
 * **13.9×** while N grew 11×, and roughly doubled with every doubling of N —
 * 14.7 → 40.2 → 92.3 → 203.7 µs/event is a near-perfect quadratic signature,
 * not sampling noise (repeat runs varied in absolute ms with the box's load,
 * exactly as `scene/perf.test.ts`'s own header describes, but never in this
 * shape — the ratio between adjacent N's held across every run taken while
 * writing this). At the real session's own size the fold already costs
 * eleven seconds; `cli/index.ts`'s boot recovery pays this once per resume
 * of a long-running session, and every ledger refold (audit finding P1) pays
 * it again from zero.
 *
 * **Verdict: CONFIRMED.** The audit's O(n²) claim survives measurement.
 * `dedupedUsage`'s `findIndex` and `withTelemetry`'s `placeCosts`/`placeLanes`
 * scans are the mechanism this file exists to weigh, and the curve is exactly
 * what re-scanning a growing array on every telemetry event predicts. This
 * lane stops here, per the brief — the index fix (usage by `requestId`,
 * costs/lanes by `sessionId`) is a separate, groomed lane now that the curve
 * has confirmed it is worth opening.
 *
 * ---
 *
 * ## #179 — THE FIX, RE-MEASURED ON THIS INSTRUMENT
 *
 * The index landed (`UsageIndex` in `reduce.ts`, plus the place join's
 * change-guard). Same corpus, same prefixes, same three-run median. The box
 * was under real load while these ran (`load average: 13`, sibling worktrees'
 * suites), so per the discipline above the **ratios** are the claim and the
 * absolute ms are not; every configuration was measured three times and the
 * least-contended pass is quoted, with all three ratios given so the spread is
 * visible.
 *
 * **The telemetry fold — what #179 owns** (the `spanless` lane below):
 *
 * | N      | before        | after      | before µs/ev | after µs/ev | faster |
 * | ------ | ------------- | ---------- | ------------ | ----------- | ------ |
 * | 5,000  |    19.12 ms   |   6.52 ms  |     3.82     |    1.30     |  2.9×  |
 * | 15,000 |   139.31 ms   |  36.74 ms  |     9.29     |    2.45     |  3.8×  |
 * | 30,000 |   584.76 ms   | 124.92 ms  |    19.49     |    4.16     |  4.7×  |
 * | 55,000 | 2,740.03 ms   | 491.12 ms  |    49.82     |    8.93     |  5.6×  |
 *
 * µs/event growth across an 11× growth in N: **13.0× → 6.9×** (the three
 * passes read 14.7× / 12.7× / 13.0× before, and 6.9× / 5.9× / 4.5× after).
 * The per-event cost at the real session's own size fell 5.6×, and what
 * remained of the rise more than halved. Each of the three scans the audit
 * named is now a lookup that does not grow: `byRequest` for the dedup,
 * `sessionlogSessions` for the coverage rule, `requestlessOtelBySession` for
 * the retirement, and the cost/lane join gated on the place actually moving.
 *
 * **The residual, named rather than left as "noise".** The remaining rise is
 * not a scan: it is the immutable append itself. `[...telemetry.usage, record]`
 * copies an array that grows with the session, and `{ ...state.commits, [sha]:
 * commit }` copies a Record that does too. Measured standalone at this
 * corpus's record counts, that is ~210 ms of the 491 ms at N=55k, and there is
 * no cheaper legal spelling — `[...a, x]` beat both `a.concat(x)` (1.8×
 * slower) and `slice()`+`push` on this runtime. Removing it means mutating the
 * arrays a previous frame still holds, which the purity laws in
 * `reduce.telemetry.test.ts` and `state.test.ts` forbid outright. It is the
 * state contract's own cost, and it is now the whole of the telemetry fold's
 * curve.
 *
 * **The full-mix lane did not flatten, and here is why** (13.62 → 9.82 µs/ev
 * at 5k, 229.20 → 186.35 at 55k; ratio 16.8× → 19.0×, which is *worse* on
 * paper). After #179 that lane is ~90% one line of `traceSpan`: `{
 * ...traces.byTrace, [traceId]: [...] }`, an immutable insert into a Record
 * that gains a key per span, because this corpus deliberately gives every span
 * its own `traceId`. Standalone, that pattern alone costs 50 / 518 / 2,367 /
 * 8,866 ms at these four N — it was ~70% of the fold #174 measured, and taking
 * the telemetry cost out only raised its share. See {@link SPANLESS_CORPUS}
 * for why it cannot be fixed from here: `TraceState`'s key set is pinned by an
 * oracle this lane may not touch, so moving that index out of recorded state
 * is prd9's own state-contract argument to have, with its own oracle in front
 * of it. **It is now measured rather than suspected, which is the honest
 * hand-off.** (#184 took the hand-off and flattened this lane without needing
 * the argument — the section below.)
 *
 * ---
 *
 * ## #184 — THE OTHER ELEVEN SECONDS, RE-MEASURED ON THIS INSTRUMENT
 *
 * The hand-off was taken. `byTrace`/`bySession` stopped being accumulated a
 * Record copy at a time and became a projection of `spans`, materialised on
 * demand (`traceStateOf` in `state.ts`); the one question the fold asks per
 * span moved to a carried-forward table (`TraceIndex` in `reduce.ts`). Same
 * corpus, same prefixes, same three-run median, and the same discipline: the
 * box was under real load for most of these (`load average` 11–40, sibling
 * worktrees' suites), so the **ratios** are the claim, and the least-contended
 * pass of each configuration is quoted with the spread given below it.
 *
 * **The full-mix lane — what #184 owns:**
 *
 * | N      | before        | after      | before µs/ev | after µs/ev | faster |
 * | ------ | ------------- | ---------- | ------------ | ----------- | ------ |
 * | 5,000  |     61.95 ms  |  18.03 ms  |     12.39    |     3.61    |  3.4×  |
 * | 15,000 |    597.93 ms  |  59.61 ms  |     39.86    |     3.97    | 10.0×  |
 * | 30,000 |  2,813.80 ms  | 172.59 ms  |     93.79    |     5.75    | 16.3×  |
 * | 55,000 | 10,268.97 ms  | 665.87 ms  |    186.71    |    12.11    | 15.4×  |
 *
 * µs/event growth across an 11× growth in N: **15.1× → 3.4×** (three passes
 * read 15.1× / 15.7× / 15.7× before, and 3.4× / 2.8× / 3.3× after). **The
 * curve flattened**: what was a near-perfect quadratic signature — the per-event
 * cost doubling with every doubling of N — now rises 3.4× across an 11× growth
 * in N, and every one of that rise's remaining terms is the immutable append
 * #179 named and the purity laws forbid making faster.
 *
 * **And it flattened onto the spanless lane's curve**, which is the shape of
 * the claim rather than its size. Per event at 55k, full-mix cost 24.2× the
 * spanless lane before (186.71 vs 7.99 µs/event in the same pass) and costs
 * 1.5× it after (12.11 vs 7.99). The two lanes now differ by roughly what
 * their event mixes differ by, not by a mechanism. The spanless lane itself is
 * untouched by #184 and moved only with the box's load — which is exactly what
 * makes it usable as this lane's control.
 *
 * **Boot recovery, end to end.** The number the operator actually waits on: a
 * 55k-event session file read off disk, parsed line by line, folded, and the
 * two selectors `cli/index.ts`'s boot line prints. Median of three, same box,
 * back to back — **11,481 ms → 1,081 ms**, of which the fold is 11,178 → 742
 * ms (15.1×). What is left of the wait is reading and parsing 55k JSONL lines
 * (~340 ms), which no fold change can touch.
 */

const BENCH_TIMEOUT_MS = 120_000

const LANES = ['2-core', '3-git', '7-web', '9-ui', '11-judge', '14-lab'] as const

const WT_ROOT = '/repo/rhizomorph-wt'
const worktreeFor = (lane: string): string => `${WT_ROOT}/${lane}`
const sessionFor = (lane: string): string => `sess-${lane}`
const paneFor = (lane: string): string => `%${LANES.indexOf(lane as (typeof LANES)[number]) + 1}`

/**
 * The audit's own type census on the real 55,049-event session (parts per
 * mille, rounded — the two-point rounding slack lands on `pane.activity`,
 * the largest bucket, where it changes nothing about the shape). Anything
 * the audit didn't itemise (a long tail of collector/lab/judge types) is a
 * fraction of a percent in the real log and is left out rather than guessed.
 */
const CENSUS: readonly (readonly [EventType, number])[] = [
  ['pane.activity', 496],
  ['llm.usage', 188],
  ['trace.span', 132],
  ['tool.activity', 84],
  ['agent.activeTime', 38],
  ['llm.cost', 28],
  ['worktree.dirty', 12],
  ['commit.landed', 10],
  ['branch.updated', 6],
  ['pane.discovered', 2],
  ['agent.status', 2],
  ['pane.closed', 2],
]

/**
 * Spreads the census evenly across a run of `total` slots instead of
 * clumping each type into one block, so a prefix of any length still reads
 * as a plausible interleaved stream. Deterministic (Webster's apportionment
 * method — "give the next slot to whichever type is furthest behind its
 * target share"), so the same pattern comes out every run.
 */
function buildPattern(weights: readonly (readonly [EventType, number])[]): EventType[] {
  const total = weights.reduce((sum, [, w]) => sum + w, 0)
  const produced = weights.map(() => 0)
  const pattern: EventType[] = []
  for (let slot = 1; slot <= total; slot += 1) {
    let bestIndex = 0
    let bestDeficit = -Infinity
    for (let j = 0; j < weights.length; j += 1) {
      const [, weight] = weights[j] as (typeof weights)[number]
      const deficit = (weight * slot) / total - (produced[j] as number)
      if (deficit > bestDeficit) {
        bestDeficit = deficit
        bestIndex = j
      }
    }
    produced[bestIndex] = (produced[bestIndex] as number) + 1
    pattern.push((weights[bestIndex] as (typeof weights)[number])[0])
  }
  return pattern
}

const CENSUS_PATTERN = buildPattern(CENSUS)

/** One event of `type`, on `lane`, distinguished by the stream index `i`. */
function emit(f: EventFactory, type: EventType, lane: string, i: number): void {
  const worktreePath = worktreeFor(lane)
  const sessionId = sessionFor(lane)
  const paneId = paneFor(lane)

  switch (type) {
    case 'pane.activity':
      f.paneActivity({ paneId, contentHash: `hash-${i}`, preview: `activity line ${i}` })
      return
    case 'llm.usage':
      // A fresh `requestId` every call: the worst case for `dedupedUsage`'s
      // `findIndex`, and the case the audit's own cross-collector sweep
      // found true of every real session it checked.
      f.llmUsage({
        lane,
        role: 'worker',
        model: i % 3 === 0 ? 'claude-sonnet-5' : 'claude-opus-5',
        tokens: {
          input: 2 + (i % 5),
          output: 500 + (i % 900),
          cacheRead: 50_000 + (i % 20_000),
          cacheCreation: 1_000 + (i % 3_000),
        },
        requestId: `req-${lane}-${i}`,
        durationMs: 4_000 + (i % 6_000),
        sessionId,
        worktreePath,
        branch: lane,
      })
      return
    case 'llm.cost':
      f.llmCost({
        lane,
        role: 'worker',
        model: 'claude-opus-5',
        costUsd: 0.01 + (i % 50) / 1_000,
        authoritative: true,
        sessionId,
        worktreePath,
        branch: lane,
      })
      return
    case 'trace.span':
      // Its own trace every call. That was chosen so the reducer's per-trace
      // re-delivery check never had anything to scan — not the audit's
      // finding, only `usage`/`costs` were — and it is also, as #179 found
      // out, the worst case for the `byTrace` Record this mix grows a key in
      // per span. #184 kept the corpus and removed the growth; the check is a
      // `Set` lookup now, and would be flat here either way.
      f.traceSpan({
        lane,
        role: 'worker',
        traceId: `trace-${lane}-${i}`,
        spanId: `span-${lane}-${i}`,
        parentSpanId: null,
        requestId: `req-span-${lane}-${i}`,
        sessionId,
        worktreePath,
        branch: lane,
      })
      return
    case 'tool.activity':
      f.toolActivity({
        lane,
        tool: i % 2 === 0 ? 'Bash' : 'Edit',
        role: 'worker',
        sessionId,
        worktreePath,
        branch: lane,
        toolUseId: `toolu-${lane}-${i}`,
      })
      return
    case 'agent.activeTime':
      f.agentActiveTime({
        lane,
        role: 'worker',
        activeSeconds: 30 + (i % 600),
        sessionId,
        worktreePath,
        branch: lane,
      })
      return
    case 'worktree.dirty':
      f.worktreeDirty({
        path: worktreePath,
        branch: lane,
        files: [{ path: `src/file-${i}.ts`, status: 'modified' }],
      })
      return
    case 'commit.landed':
      f.commitLanded({
        sha: `sha-${lane}-${i}`,
        branch: lane,
        message: `feat: change ${i}`,
        author: { name: 'Agent', email: 'agent@example.com' },
        files: [{ path: `src/file-${i}.ts`, status: 'modified', insertions: 4, deletions: 1 }],
        insertions: 4,
        deletions: 1,
      })
      return
    case 'branch.updated':
      f.branchUpdated({ branch: lane, head: `sha-${lane}-${i}` })
      return
    case 'pane.discovered':
      f.paneDiscovered({
        paneId,
        windowName: lane,
        currentPath: worktreePath,
        currentCommand: 'node',
        worktreePath,
      })
      return
    case 'agent.status':
      f.agentStatus({
        handle: lane,
        status: i % 2 === 0 ? 'working' : 'waiting',
        worktreePath,
        branch: lane,
      })
      return
    case 'pane.closed':
      f.paneClosed({ paneId })
      return
    default:
      throw new Error(`reduce.bench.test.ts: unhandled census type ${type}`)
  }
}

/**
 * A deterministic corpus of `size` telemetry-realistic events, plus the
 * small bootstrap prelude every real session opens with (session start,
 * worktrees discovered, panes discovered, agents reporting in). The prelude
 * is fixed-size and tiny (19 events) next to the sizes this file measures at,
 * so `events.slice(0, N)` below is, for every practical purpose, "the first N
 * events of the stream" — which is exactly what boot recovery folds.
 */
function buildCorpus(size: number): readonly RhizomorphEvent[] {
  const f = createEventFactory({ stepMs: 250, idPrefix: 'bench' })

  f.sessionStarted({
    sessionId: 'bench-session',
    repoPath: '/repo/rhizomorph',
    repoName: 'rhizomorph',
    mainBranch: 'main',
  })
  for (const lane of LANES) {
    f.worktreeDiscovered({ path: worktreeFor(lane), branch: lane, head: `sha-${lane}-0`, isMain: false })
    f.paneDiscovered({
      paneId: paneFor(lane),
      windowName: lane,
      currentPath: worktreeFor(lane),
      currentCommand: 'node',
      worktreePath: worktreeFor(lane),
    })
    f.agentStatus({ handle: lane, status: 'working', worktreePath: worktreeFor(lane), branch: lane })
  }

  for (let i = 0; i < size; i += 1) {
    const type = CENSUS_PATTERN[i % CENSUS_PATTERN.length] as EventType
    const lane = LANES[i % LANES.length] as string
    emit(f, type, lane, i)
  }

  return f.all()
}

const N_VALUES = [5_000, 15_000, 30_000, 55_000] as const

/**
 * Built once, with headroom; every N reads a prefix of it. The prelude and the
 * per-index emission below depend on `i`, never on `size`, so a prefix of this
 * corpus is byte-for-byte the corpus #174 measured at that N — the before/after
 * comparison is against the same events, not merely the same recipe. The
 * headroom exists so {@link SPANLESS_CORPUS} still reaches 55k after filtering.
 */
const CORPUS = buildCorpus(70_000)

/**
 * The same stream with prd9's `trace.span` withheld — the telemetry fold on its
 * own (#179).
 *
 * The full-mix lane above measures a sum, and after #179 that sum was dominated
 * by a mechanism #179 did not own: `traceSpan`'s `{ ...traces.byTrace,
 * [traceId]: [...] }`, an immutable insert into a Record that gains a key per
 * span, because this corpus deliberately gives every span its own `traceId`
 * (see `emit`). Standalone, that pattern alone cost 50 / 518 / 2367 / 8866 ms
 * at these four N — ~90% of the post-#179 full-mix fold, and ~70% of the fold
 * #174 measured. #179 read that as a state-contract change for prd9's slice,
 * with its own oracle to argue in front of, and stopped. **#184 took it, and
 * did not need the argument**: the two indexes are a projection of `spans`, so
 * deriving them on demand left `TraceState`'s key set, its bytes and its
 * oracle exactly where they were. The before/after is in this file's header.
 *
 * The lane keeps earning its place afterwards. It is the control for the one
 * above — code #184 never touched, folded on the same instrument in the same
 * pass, which is how a full-mix number can be read as the work changing rather
 * than the box's load changing. And filtering *raises* telemetry density (30.0%
 * → 34.6% of events are usage/cost/tool/activeTime), so it stays the harder
 * workload per event for the mechanisms #179 fixed, not a softer one.
 */
const SPANLESS_CORPUS = CORPUS.filter((event) => event.type !== 'trace.span')

function report(line: string): void {
  process.stdout.write(`${line}\n`)
}

interface FoldMeasurement {
  /** Median wall time, across `runs` timed calls. */
  medianMs: number
  /** The fold itself, from the last run — reused for the correctness checks
   * below instead of paying for a fifth `reduceAll(55_000 events)` call. */
  state: ReturnType<typeof reduceAll>
}

/** Median of `runs` timed calls to `reduceAll` over `events`. */
function measureFold(events: readonly RhizomorphEvent[], runs: number): FoldMeasurement {
  const samples: number[] = []
  let state: ReturnType<typeof reduceAll> | undefined
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now()
    state = reduceAll(events)
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return { medianMs: samples[Math.floor(samples.length / 2)] as number, state: state! }
}

interface Result {
  n: number
  ms: number
  msPerEvent: number
}

/**
 * One measured lane. Both lanes below run *this* code, so the two curves are
 * the same instrument pointed at two corpora — a difference between them is a
 * difference in the work, never in how the work was timed.
 */
function curveLane(title: string, corpus: readonly RhizomorphEvent[], prefix: string): void {
  const results: Result[] = []

  describe(title, () => {
    // One small warmup fold before any measured size, so the first measured N
    // is not also paying for JIT warmup — the reducer's hot functions
    // (`dedupedUsage`, `placeCosts`, `withTelemetry`) get exercised once here.
    it('warms up', () => {
      reduceAll(corpus.slice(0, 1_000))
      expect(true).toBe(true)
    }, BENCH_TIMEOUT_MS)

    for (const n of N_VALUES) {
      it(`folds ${n} events`, () => {
        const events = corpus.slice(0, n)
        expect(events).toHaveLength(n)

        const { medianMs: ms, state: folded } = measureFold(events, 3)
        const msPerEvent = ms / n
        results.push({ n, ms, msPerEvent })

        report(
          `${prefix}reduceAll(${n} events): ${ms.toFixed(2)} ms · ${(msPerEvent * 1000).toFixed(3)} µs/event`,
        )

        // THE LAW, and it is shape rather than a clock (see the header): the
        // fold actually ran over every event, and produced telemetry records
        // rather than silently dropping them.
        expect(folded.eventCount).toBe(n)
        expect(folded.telemetry.usage.length).toBeGreaterThan(0)
        expect(folded.telemetry.usage.length).toBeLessThanOrEqual(n)
        expect(folded.telemetry.costs.length).toBeGreaterThan(0)
        expect(folded.telemetry.costs.length).toBeLessThanOrEqual(n)
        expect(ms).toBeGreaterThan(0)
      }, BENCH_TIMEOUT_MS)
    }

    /**
     * THE OTHER LAW, and the one #179 exists under: an index is an
     * accelerator, so the fold's *output* must not be able to tell it is
     * there. Two folds of one corpus, compared as the serialised bytes rather
     * than by `toEqual`, at a size where every mechanism the reshape touched
     * (dedup, session coverage, the cost/lane join) has run thousands of
     * times. The deep laws — an index rebuilt from scratch mid-fold, two folds
     * branching off one state — are pinned in `reduce.test.ts`; this is the
     * bench's own corner of them, at bench scale.
     */
    it('folds the same events to byte-identical state, twice', () => {
      const events = corpus.slice(0, 5_000)
      const once = JSON.stringify(reduceAll(events))
      const twice = JSON.stringify(reduceAll(events))
      expect(twice).toBe(once)
      expect(once.length).toBeGreaterThan(0)
    }, BENCH_TIMEOUT_MS)

    it('reports the curve — confirmed or killed, said plainly', () => {
      expect(results).toHaveLength(N_VALUES.length)

      const table = results
        .map((r) => `N=${r.n}: ${r.ms.toFixed(2)} ms, ${(r.msPerEvent * 1000).toFixed(3)} µs/event`)
        .join(' · ')
      report(`${prefix}curve: ${table}`)

      const first = results[0] as Result
      const last = results[results.length - 1] as Result
      const nRatio = last.n / first.n
      const perEventRatio = last.msPerEvent / first.msPerEvent

      // Reported, not asserted (see the header): whether this ratio reads as a
      // line or a curve is exactly the honest human judgment call the issue
      // asks for, not a threshold this suite should bake in and silently rot.
      report(
        `${prefix}N grew ${nRatio.toFixed(1)}× (${first.n} → ${last.n}); ms/event grew ` +
          `${perEventRatio.toFixed(2)}× (${(first.msPerEvent * 1000).toFixed(3)} → ` +
          `${(last.msPerEvent * 1000).toFixed(3)} µs/event). A flat ms/event across ` +
          `that N growth is a straight line — kills the O(n²) claim. A ms/event ` +
          `that grows with N is a curve — confirms it.`,
      )

      expect(nRatio).toBeGreaterThan(1)
    }, BENCH_TIMEOUT_MS)
  })
}

curveLane('reduceAll at N = 5k / 15k / 30k / 55k, a realistic telemetry mix', CORPUS, '')
curveLane(
  'reduceAll at N = 5k / 15k / 30k / 55k, the same mix without prd9 spans',
  SPANLESS_CORPUS,
  'spanless · ',
)
