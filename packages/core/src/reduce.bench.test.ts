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
      // Its own trace every call, so the reducer's own small per-trace dedup
      // (`traces.byTrace[traceId].some(...)`) never has anything to scan —
      // that check is not the audit's finding, only `usage`/`costs` are.
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

/** Built once, at the largest N; every smaller N reads a prefix of it. */
const CORPUS = buildCorpus(N_VALUES[N_VALUES.length - 1]!)

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

const results: Result[] = []

describe('reduceAll at N = 5k / 15k / 30k / 55k, a realistic telemetry mix', () => {
  // One small warmup fold before any measured size, so the first measured N
  // is not also paying for JIT warmup — the reducer's hot functions
  // (`dedupedUsage`, `placeCosts`, `withTelemetry`) get exercised once here.
  it('warms up', () => {
    reduceAll(CORPUS.slice(0, 1_000))
    expect(true).toBe(true)
  }, BENCH_TIMEOUT_MS)

  for (const n of N_VALUES) {
    it(`folds ${n} events`, () => {
      const events = CORPUS.slice(0, n)
      expect(events).toHaveLength(n)

      const { medianMs: ms, state: folded } = measureFold(events, 3)
      const msPerEvent = ms / n
      results.push({ n, ms, msPerEvent })

      report(
        `reduceAll(${n} events): ${ms.toFixed(2)} ms · ${(msPerEvent * 1000).toFixed(3)} µs/event`,
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

  it('reports the curve — confirmed or killed, said plainly', () => {
    expect(results).toHaveLength(N_VALUES.length)

    const table = results
      .map((r) => `N=${r.n}: ${r.ms.toFixed(2)} ms, ${(r.msPerEvent * 1000).toFixed(3)} µs/event`)
      .join(' · ')
    report(`curve: ${table}`)

    const first = results[0] as Result
    const last = results[results.length - 1] as Result
    const nRatio = last.n / first.n
    const perEventRatio = last.msPerEvent / first.msPerEvent

    // Reported, not asserted (see the header): whether this ratio reads as a
    // line or a curve is exactly the honest human judgment call the issue
    // asks for, not a threshold this suite should bake in and silently rot.
    report(
      `N grew ${nRatio.toFixed(1)}× (${first.n} → ${last.n}); ms/event grew ` +
        `${perEventRatio.toFixed(2)}× (${(first.msPerEvent * 1000).toFixed(3)} → ` +
        `${(last.msPerEvent * 1000).toFixed(3)} µs/event). A flat ms/event across ` +
        `that N growth is a straight line — kills the O(n²) claim. A ms/event ` +
        `that grows with N is a curve — confirms it.`,
    )

    expect(nRatio).toBeGreaterThan(1)
  }, BENCH_TIMEOUT_MS)
})
