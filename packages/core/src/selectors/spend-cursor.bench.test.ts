import { describe, expect, it } from 'vitest'
import type { EventType, RhizomorphEvent } from '../events/index.js'
import { type EventFactory, createEventFactory } from '../fixtures.js'
import { reduce, reduceAll } from '../reduce.js'
import type { SessionState } from '../state.js'
import {
  laneSpendCursor,
  roleSpendCursor,
  selectLaneSpend,
  selectRoleSpend,
  selectSessionSpend,
  sessionSpendCursor,
  spendFrom,
} from './spend.js'

/**
 * `packages/core` carries no `lib.dom` and no `@types/node` (it runs in the
 * browser too), so neither global is declared for `tsc` — the same locally
 * declared shapes `reduce.bench.test.ts` uses, for the same reason.
 */
declare const performance: { now(): number }
declare const process: { stdout: { write(chunk: string): void } }

/**
 * MEASUREMENT LANE (#267 / #268's DoD), against prd21's Evidence.
 *
 * **Discipline, inherited from `reduce.bench.test.ts` and `scene/perf.test.ts`:
 * timings are reported, never asserted.** A wall clock under `--maxWorkers`
 * measures the box, not the code — and it measured exactly that while this file
 * was written: the dev box sat at 100% CPU with eight sibling `node` processes,
 * and the same configuration read 340 ms in one pass and 1,110 ms in another.
 * So **no assertion in this file reads a clock.** All four `expect`s per size are
 * counts or identities — the drag's record-visit total against the records
 * appended, that total against what rescanning would have cost, the primed
 * cursor's position against the prefix it consumed, and one cursor answer
 * against the selector it replaces. Every duration is printed and asserted
 * nowhere, so a loaded box cannot fail this file; the CI oracle for the work is
 * the visit-count law in `spend-cursor.test.ts`.
 *
 * **The corpus.** Built to reproduce prd21's own measured record census rather
 * than a guessed one: at 466 events this yields 167 usage / 194 tool records
 * (Gabe measured 176 / 203 on the real 447-event log amplified), and at 5,000 it
 * yields 1,867 / 2,166 against his 1,871 / 2,172. Four lanes, four branches,
 * twelve panes — the derived entities his amplification held constant while
 * telemetry grew. Two of the four lanes report real `llm.cost`, two do not, so
 * prd9 ruling 7's per-record pricing runs on roughly half the usage records.
 *
 * ---
 *
 * ## WHERE THE 58 ms ACTUALLY WENT — the attribution prd21 asked for
 *
 * prd21 named three selectors accounting for ~22 ms of `buildFleet`'s 58 ms at
 * 5,000 events and left "the remaining ~36 ms spread across the other ~13
 * selectors and the draft loop". **Measured against `main`'s own code, that
 * reading is wrong.** `buildFleet` calls the spend selectors *twice each* —
 * once token-filtered, once for dollars (`buildFleet.ts:138-149`) — and prd21's
 * table timed one call of each. Every other selector it calls is flat.
 *
 * Per `buildFleet`, on `main`, same box (jsdom, `packages/web`, median of 5):
 *
 * | | 466 ev | 5,000 ev | 25,000 ev |
 * |---|---|---|---|
 * | `selectSessionSpend` x2 | 1.35 ms | 10.8 ms | 55.9 ms |
 * | `selectLaneSpend` x2 | 2.40 ms | 25.2 ms | 114.3 ms |
 * | `selectRoleSpend` x2 | 1.13 ms | 16.1 ms | 59.4 ms |
 * | `selectSpendRateByLane` x2 | 2.13 ms | 6.1 ms | 7.1 ms |
 * | **spend selectors, subtotal** | **7.02 ms** | **58.2 ms** | **236.7 ms** |
 * | every other selector + plumbing | 0.19 ms | 1.09 ms | 3.5 ms |
 * | **`buildFleet` whole** | **9.95 ms** | **56.6 ms** | **225.7 ms** |
 *
 * The eight spend calls alone cost as much as the entire rebuild (the subtotal
 * runs slightly over the whole because timing each call in isolation pays its
 * own warmup and GC). Everything else — `selectWorktreeViews`,
 * `selectCollisions`, `selectTouchesByBranch`, `selectActiveSecondsByLaneIndex`,
 * `recentToolsByHandle`, `outputTokenEventsByHandle`, `latestSpanTsByLane`,
 * `latestCommitTsByBranch`, `spanDecisionsByKey` and the draft loop — is
 * **1.5% of the measured parts at 25,000 events**. The instrument reproduces
 * prd21's own figures within ~15% (`selectLaneSpend` 14.0 vs his 14.3 ms;
 * `buildFleet` 56.6 vs his 58.0), which is what licenses the correction.
 *
 * Two costs inside that subtotal are worth naming separately, because they are
 * not what anyone expected:
 *
 * - **`estimateCostUsd` is ~2.7 µs per uncovered usage record, against ~0.5 µs
 *   for the whole of the rest of a record's accumulation.** It walks 149
 *   anchored patterns in table order (`pricing/prices.ts:113`, `findRate`) and
 *   `claude-opus-5` matches at entry 121 of 149. Nothing memoises the model to
 *   its rate, so the same scan runs again for every record. It is the single
 *   largest per-record cost in the spend path and it lives outside this file's
 *   fence.
 * - **`main`'s `selectLaneSpend` paid that scan twice per record** — once for
 *   the lane accumulator and again for the thread sub-row. The collapse prices
 *   each record once and hands the result to both, which is most of the direct
 *   path's speed-up below.
 *
 * ---
 *
 * ## THE FIX, MEASURED — `main`'s `spend.ts` beside this branch's
 *
 * `main`'s file was imported side by side with this branch's and the two were
 * timed in interleaved passes, same box, same node environment, same corpus.
 * **Three separate sessions of that comparison disagreed on absolute
 * milliseconds by up to 4x** (the six calls at 5,000 events read 46, 56 and
 * 244 ms across sessions; a single 25,000-event configuration read 65 ms on its
 * fastest pass and 394 ms on its median in the *same* seven-pass loop). The
 * mechanism is visible in the numbers: the six-call row allocates six rollups
 * per pass and eats the major GC that the single-selector rows dodge, and eight
 * sibling `node` processes had the box at 100%. So the direct path's absolute
 * numbers are not reportable, and what follows is only what came out the same
 * way in every session:
 *
 * - **`selectLaneSpend` is reliably 1.6-2.2x faster**, at every size, in every
 *   pass. It used to pay `estimateCostUsd` twice per usage record (lane row,
 *   then thread sub-row); it now prices each record once and hands the result to
 *   both. `selectSpendByWorktree` rides on it and reads 1.1-2.0x.
 *   `selectSpendRateByLane` reads 1.4-2.3x for the same reason.
 * - **`selectSpendByBranch`'s two passes became one** (its "a branch mentioned
 *   anywhere gets a row" pre-pass now rides the same walk), but it was never one
 *   of the expensive calls, and the measurement cannot resolve the difference:
 *   0.83-1.13x across sessions, i.e. noise.
 * - **`selectSessionSpend`, `selectRoleSpend`, `selectModelSpend` and
 *   `selectSpendByLaneRole` read 0.9-1.1x — no resolvable change.** One session
 *   read `selectSessionSpend` at 0.8x and it would be dishonest to hide that:
 *   the collapse does add per-record work to these (an indirect key call and a
 *   group lookup where a hand-rolled loop had a captured variable), and a
 *   single-group rollup has nothing to amortise it against. Bounded by a
 *   constant, invisible against this box's variance, and the reason the
 *   deferred-estimate map is keyed lane-then-session rather than on a composite
 *   string: the first version of it allocated a key per record and that *was*
 *   measurable.
 * - **The six calls together read 1.11-1.40x faster** in all three sessions.
 *
 * **The incremental path — what the issue is actually for.** Six answers
 * (session/lane/role x the token and cost filters), advanced one seek at a time
 * through freshly folded states, against the same six rescanned per seek. This
 * is what the test bodies below print, on a quiet pass:
 *
 * | N | rescan / rebuild | cursor / seek | faster | record visits over the drag |
 * |---|---|---|---|---|
 * | 466 | 4.32 ms | 0.111 ms | 39x | 240 vs 104,340 |
 * | 5,000 | 52.89 ms | 0.121 ms | 439x | 2,490 vs 12,399,000 |
 * | 25,000 | 234.07 ms | 0.400 ms | 585x | 12,450 vs 310,995,000 |
 *
 * Across five sessions of that same measurement the ratio column read
 * 26-46x / 187-439x / 585-6,457x. The visit column read the same three pairs
 * every time.
 *
 * **The visit counts are the only load-immune column, and they are the claim.**
 * They are identical on any box, they are asserted below
 * (`dragVisits === 6 x records-appended`), and they are what makes the ratio
 * credible where the clock is not: a rescan reads every record on every seek and
 * a cursor reads each appended record once, so the ratio grows with session
 * length by construction rather than by measurement. The wall-clock column
 * agrees with that shape and should be read for its order of magnitude only.
 *
 * **What remains, said plainly.**
 *
 * 1. **The first read still costs a full scan.** A cursor primed on a
 *    25,000-event session pays 0.2-0.9 s for six answers before it is cheap —
 *    the same work the selectors always did, now paid once instead of per frame.
 *    A consumer that wants the *first* frame fast needs the pricing memo below,
 *    not this cursor.
 * 2. **`estimateCostUsd`'s 149-pattern scan is untouched** and is now the
 *    dominant term in that prime. Memoising model to rate inside
 *    `packages/core/src/pricing/prices.ts` is a one-line index, out of #267's
 *    fence, and worth roughly 2.7 µs to 0.05 µs per uncovered usage record.
 * 3. **`selectSpendRateByLane` has no cursor twin**, on purpose: a rolling
 *    window's `since` moves every call, so records leave the window as well as
 *    enter it, and a `Set` of models cannot be un-added. It measured 7.1 ms of a
 *    226 ms rebuild at 25,000 events, because its window predicate rejects
 *    almost every record before any accumulation — the cheapest of the eight
 *    calls, and not worth a second mechanism.
 * 4. **The consumers are not wired.** Until #269 (the seek path), `FleetContext`
 *    and #246's server re-fold hold a cursor, `buildFleet` still pays the
 *    rescan column. The seam they wire into is `laneSpendCursor`'s doc comment.
 */

const BENCH_TIMEOUT_MS = 300_000

const LANES = ['2-core', '3-git', '7-web', '9-ui'] as const
const TOKEN_ORIGINS = ['sessionlog'] as const
const wt = (lane: string): string => `/repo/rhizomorph-wt/${lane}`
const paneFor = (lane: string, k: number): string =>
  `%${LANES.indexOf(lane as (typeof LANES)[number]) * 3 + k + 1}`

/**
 * prd21's measured census, as weights per thousand events. See the header for
 * how closely the record counts this produces track the ones Gabe measured.
 */
const CENSUS: readonly (readonly [EventType, number])[] = [
  ['tool.activity', 435],
  ['llm.usage', 375],
  ['pane.activity', 120],
  ['llm.cost', 40],
  ['worktree.dirty', 10],
  ['commit.landed', 10],
  ['branch.updated', 5],
  ['agent.status', 5],
]

/**
 * Spreads the census evenly across a run of slots instead of clumping each type
 * into a block, so a prefix of any length still reads as an interleaved stream.
 * Webster's apportionment, deterministic — the same pattern every run, copied
 * from `reduce.bench.test.ts` so the two benches share one corpus shape.
 */
function buildPattern(weights: readonly (readonly [EventType, number])[]): EventType[] {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0)
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

const PATTERN = buildPattern(CENSUS)

/** Half the lanes report real dollars; half never do, so both prd9 ruling 7 branches run. */
const COVERED = new Set<string>(['2-core', '3-git'])

function emit(f: EventFactory, type: EventType, lane: string, i: number): void {
  const sessionId = `sess-${lane}`
  switch (type) {
    case 'llm.usage':
      f.llmUsage({
        lane,
        role: i % 7 === 0 ? 'conductor' : 'worker',
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
        worktreePath: wt(lane),
        branch: lane,
        thread: i % 5 === 0 ? 'main' : 'subagent',
      })
      return
    case 'llm.cost':
      // An uncovered lane spends its cost slot on pane noise instead, so the
      // event mix stays fixed while the coverage split changes.
      if (!COVERED.has(lane)) {
        f.paneActivity({ paneId: paneFor(lane, 0), contentHash: `h-${i}`, preview: `line ${i}` })
        return
      }
      f.llmCost({
        lane,
        role: 'worker',
        model: 'claude-opus-5',
        costUsd: 0.01 + (i % 50) / 1_000,
        authoritative: true,
        sessionId,
        worktreePath: wt(lane),
        branch: lane,
      })
      return
    case 'tool.activity':
      f.toolActivity({
        lane,
        tool: ['Bash', 'Edit', 'Read', 'Grep'][i % 4] as string,
        role: i % 7 === 0 ? 'conductor' : 'worker',
        sessionId,
        worktreePath: wt(lane),
        branch: lane,
        toolUseId: `toolu-${lane}-${i}`,
        thread: i % 5 === 0 ? 'main' : 'subagent',
      })
      return
    case 'pane.activity':
      f.paneActivity({ paneId: paneFor(lane, i % 3), contentHash: `h-${i}`, preview: `line ${i}` })
      return
    case 'worktree.dirty':
      f.worktreeDirty({
        path: wt(lane),
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
    case 'agent.status':
      f.agentStatus({
        handle: lane,
        status: i % 2 === 0 ? 'working' : 'waiting',
        worktreePath: wt(lane),
        branch: lane,
      })
      return
    default:
      throw new Error(`spend-cursor.bench.test.ts: unhandled census type ${type}`)
  }
}

/**
 * `size` telemetry-realistic events after a fixed 22-event bootstrap prelude.
 * The prelude and every emission depend on `i`, never on `size`, so a prefix of
 * this corpus is the same corpus at that N — before/after comparisons are
 * against the same events, not merely the same recipe.
 */
function buildCorpus(size: number): readonly RhizomorphEvent[] {
  const f = createEventFactory({ stepMs: 250, idPrefix: 'spend-bench' })
  f.sessionStarted({
    sessionId: 'spend-bench',
    repoPath: '/repo/rhizomorph',
    repoName: 'rhizomorph',
    mainBranch: 'main',
  })
  f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', head: 'sha-main', isMain: true })
  for (const lane of LANES) {
    f.worktreeDiscovered({ path: wt(lane), branch: lane, head: `sha-${lane}-0`, isMain: false })
    for (let k = 0; k < 3; k += 1) {
      f.paneDiscovered({
        paneId: paneFor(lane, k),
        windowName: lane,
        currentPath: wt(lane),
        currentCommand: 'node',
        worktreePath: wt(lane),
      })
    }
  }
  for (const lane of LANES.slice(0, 3)) {
    f.agentStatus({ handle: lane, status: 'working', worktreePath: wt(lane), branch: lane })
  }
  for (let i = 0; i < size; i += 1) {
    emit(f, PATTERN[i % PATTERN.length] as EventType, LANES[i % LANES.length] as string, i)
  }
  return f.all()
}

const CORPUS = buildCorpus(26_000)
const N_VALUES = [466, 5_000, 25_000] as const

function report(line: string): void {
  process.stdout.write(`${line}\n`)
}

function recordCount(state: SessionState): number {
  return state.telemetry.usage.length + state.telemetry.costs.length + state.telemetry.tools.length
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function fastest(samples: number[]): number {
  return Math.min(...samples)
}

/**
 * The six unwindowed spend calls `buildFleet` makes per rebuild — two passes
 * over each of session, lane and role spend, one for tokens (the collector with
 * cache-tier detail) and one for dollars (the collector with authority).
 */
function rescanTheSix(state: SessionState): void {
  selectSessionSpend(state, { origins: TOKEN_ORIGINS })
  selectSessionSpend(state)
  selectLaneSpend(state, { origins: TOKEN_ORIGINS })
  selectLaneSpend(state)
  selectRoleSpend(state, { origins: TOKEN_ORIGINS })
  selectRoleSpend(state)
}

interface Cursors {
  sessionTokens: ReturnType<typeof sessionSpendCursor>
  sessionCosts: ReturnType<typeof sessionSpendCursor>
  laneTokens: ReturnType<typeof laneSpendCursor>
  laneCosts: ReturnType<typeof laneSpendCursor>
  roleTokens: ReturnType<typeof roleSpendCursor>
  roleCosts: ReturnType<typeof roleSpendCursor>
}

/** The same six answers, as cursors — one per (question, filter). */
function freshCursors(): Cursors {
  return {
    sessionTokens: sessionSpendCursor({ origins: TOKEN_ORIGINS }),
    sessionCosts: sessionSpendCursor(),
    laneTokens: laneSpendCursor({ origins: TOKEN_ORIGINS }),
    laneCosts: laneSpendCursor(),
    roleTokens: roleSpendCursor({ origins: TOKEN_ORIGINS }),
    roleCosts: roleSpendCursor(),
  }
}

function advanceAll(cursors: Cursors, state: SessionState): Cursors {
  return {
    sessionTokens: spendFrom(cursors.sessionTokens, state),
    sessionCosts: spendFrom(cursors.sessionCosts, state),
    laneTokens: spendFrom(cursors.laneTokens, state),
    laneCosts: spendFrom(cursors.laneCosts, state),
    roleTokens: spendFrom(cursors.roleTokens, state),
    roleCosts: spendFrom(cursors.roleCosts, state),
  }
}

function visitsOf(cursors: Cursors): number {
  return (
    cursors.sessionTokens.visited +
    cursors.sessionCosts.visited +
    cursors.laneTokens.visited +
    cursors.laneCosts.visited +
    cursors.roleTokens.visited +
    cursors.roleCosts.visited
  )
}

describe('the spend path per rebuild: rescan vs cursor, at 466 / 5k / 25k events', () => {
  for (const n of N_VALUES) {
    it(
      `reports ${n} events`,
      () => {
        const events = CORPUS.slice(0, n)
        const state = reduceAll(events)
        const records = recordCount(state)

        // Warmup, so the first measured pass is not also paying for JIT.
        rescanTheSix(state)
        advanceAll(freshCursors(), state)

        const rescans: number[] = []
        for (let pass = 0; pass < 5; pass += 1) {
          const started = performance.now()
          rescanTheSix(state)
          rescans.push(performance.now() - started)
        }

        // A drag over the last tenth of the session: one seek per event
        // crossed, each seek handed its own freshly folded state — the shape
        // `useReplaySession` produces, where a state-keyed memo cannot help.
        const from = Math.max(1, Math.floor(n * 0.9))
        const head = reduceAll(events.slice(0, from))
        const seekStates: SessionState[] = []
        let rolling = head
        for (let i = from; i < n; i += 1) {
          rolling = reduce(rolling, events[i] as RhizomorphEvent)
          seekStates.push(rolling)
        }

        let primeMs = 0
        let perSeekMs = 0
        let dragVisits = 0
        let primed: Cursors = freshCursors()
        for (let pass = 0; pass < 5; pass += 1) {
          let cursors = freshCursors()
          let started = performance.now()
          cursors = advanceAll(cursors, head)
          primeMs = pass === 0 ? performance.now() - started : Math.min(primeMs, performance.now() - started)
          primed = cursors

          let visits = 0
          started = performance.now()
          for (const seek of seekStates) {
            cursors = advanceAll(cursors, seek)
            visits += visitsOf(cursors)
          }
          const elapsed = (performance.now() - started) / seekStates.length
          perSeekMs = pass === 0 ? elapsed : Math.min(perSeekMs, elapsed)
          dragVisits = visits
        }

        const rescanPerSeek = median(rescans)
        report(
          `\nN=${n} · ${records} telemetry records (usage=${state.telemetry.usage.length} costs=${state.telemetry.costs.length} tools=${state.telemetry.tools.length})` +
            `\n  rescan, six answers per rebuild : ${rescanPerSeek.toFixed(2)} ms median · ${fastest(rescans).toFixed(2)} ms fastest pass` +
            `\n  cursor, six answers per seek    : ${perSeekMs.toFixed(4)} ms over ${seekStates.length} seeks → ${(rescanPerSeek / perSeekMs).toFixed(0)}x` +
            `\n  cursor, prime (fresh load)      : ${primeMs.toFixed(2)} ms — the scan the selectors always paid, paid once` +
            `\n  RECORD VISITS over the drag     : ${dragVisits} vs ${6 * seekStates.length * records} rescanning (${Math.round((6 * seekStates.length * records) / Math.max(1, dragVisits))}x fewer)`,
        )

        // THE LAWS, and every one of them is a count or an identity — nothing
        // below reads the clock, so no measurement in this file can fail a gate
        // (the durations above are printed for a human and asserted nowhere).
        // The drag visited each appended record once per cursor and nothing
        // else; a rescan would have visited every record on every seek.
        expect(dragVisits).toBe(6 * (records - recordCount(head)))
        expect(dragVisits).toBeLessThan(6 * seekStates.length * records)
        // And the cursors still agree with the selectors they replace.
        const last = seekStates[seekStates.length - 1] as SessionState
        expect(primed.laneCosts.position.usage).toBe(head.telemetry.usage.length)
        expect(spendFrom(primed.sessionCosts, last).value.requestCount).toBe(
          selectSessionSpend(last).requestCount,
        )
      },
      BENCH_TIMEOUT_MS,
    )
  }
})
