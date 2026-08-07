import { describe, expect, it } from 'vitest'
import type { AgentRole, AgentThread, RhizomorphEvent, TelemetryOrigin } from '../events/index.js'
import { AGENT_ROLES, AGENT_THREADS, ZERO_TOKENS, addTokens, totalTokens } from '../events/index.js'
import { FIXTURE_START_TS, createEventFactory, fixtureSession, fixtureTelemetrySession } from '../fixtures.js'
import { PRICE_SOURCE_NAME, estimateCostUsd } from '../pricing/index.js'
import { reduceAll } from '../reduce.js'
import { type CostRecord, type SessionState, type ToolActivityRecord, type UsageRecord, initialSessionState } from '../state.js'
import { compareStrings } from './touches.js'
import {
  type BranchSpend,
  type LaneRoleSpend,
  type LaneSpend,
  type ModelSpend,
  type RoleSpendSplit,
  type SpendFilter,
  type SpendTotals,
  type ThreadSpend,
  type WorktreeSpend,
  branchSpendCursor,
  laneRoleSpendCursor,
  laneSpendCursor,
  modelSpendCursor,
  roleSpendCursor,
  selectLaneSpend,
  selectModelSpend,
  selectRoleSpend,
  selectSessionSpend,
  selectSpendByBranch,
  selectSpendByLaneRole,
  selectSpendByWorktree,
  sessionSpendCursor,
  spendFrom,
  worktreeSpendCursor,
} from './spend.js'
import { DEFAULT_SPEND_KEYFRAME_INTERVAL, type SpendCursor } from './spend-cursor.js'

/**
 * #267's three laws, and the oracle all three are stated against.
 *
 * The oracle is {@link reference} below: a deliberately dumb rescan of the whole
 * telemetry history, written from prd1/prd2/prd9's rules rather than from
 * `spend-cursor.ts` — filter the records, take a coverage pre-pass over every
 * cost record, loop, total, sort. It is the implementation the six selectors
 * *used* to be, six times over, and it is kept here precisely so the collapsed
 * engine and the cursor have something independent to be equal to.
 *
 * 1. **Identity** — every collapsed selector, and every cursor, returns what
 *    the oracle returns: over the existing fixture corpus, over an amplified
 *    one, and under five filters.
 * 2. **Complexity** — advancing a cursor visits only the records appended since
 *    its last snapshot. Asserted by counting record visits through
 *    `cursor.visited`, which `advanceInto` increments once per record it
 *    examines. Never a wall clock: a clock measures the box (see
 *    `reduce.bench.test.ts`'s own header on that), a visit count measures the
 *    code.
 * 3. **Order** — spend at `ts` is spend over the **append-order** prefix at
 *    `ts` (#205). Pinned with a log whose `ts` goes backwards mid-stream, which
 *    is what a tailed real log does.
 */

// --- the oracle -------------------------------------------------------------

interface Admitted {
  usage: UsageRecord[]
  costs: CostRecord[]
  tools: ToolActivityRecord[]
}

function inWindow(ts: number, filter: SpendFilter): boolean {
  if (filter.since !== undefined && ts < filter.since) return false
  if (filter.until !== undefined && ts > filter.until) return false
  return true
}

function fromOrigin(origin: TelemetryOrigin, filter: SpendFilter): boolean {
  return filter.origins === undefined || filter.origins.includes(origin)
}

/** Every record the filter admits, in the order the log wrote them. */
function admitted(state: SessionState, filter: SpendFilter): Admitted {
  const authority = filter.costs ?? 'all'
  return {
    usage: state.telemetry.usage.filter(
      (record) => inWindow(record.ts, filter) && fromOrigin(record.origin, filter),
    ),
    costs: state.telemetry.costs.filter(
      (record) =>
        inWindow(record.ts, filter) &&
        fromOrigin(record.origin, filter) &&
        (authority === 'all' ||
          (authority === 'authoritative' ? record.authoritative : !record.authoritative)),
    ),
    tools: state.telemetry.tools.filter(
      (record) => inWindow(record.ts, filter) && fromOrigin(record.origin, filter),
    ),
  }
}

interface Coverage {
  lanes: Set<string>
  sessions: Set<string>
}

/** Lanes and sessions with real dollars — a whole-array pre-pass, never narrowed by `filter.costs`. */
function coverageOf(state: SessionState, filter: SpendFilter): Coverage {
  const lanes = new Set<string>()
  const sessions = new Set<string>()
  for (const record of state.telemetry.costs) {
    if (!inWindow(record.ts, filter) || !fromOrigin(record.origin, filter)) continue
    lanes.add(record.lane)
    if (record.sessionId !== null) sessions.add(record.sessionId)
  }
  return { lanes, sessions }
}

function covered(lane: string, sessionId: string | null, coverage: Coverage): boolean {
  return coverage.lanes.has(lane) || (sessionId !== null && coverage.sessions.has(sessionId))
}

/** Totals over exactly these records. One pass, nothing carried between calls. */
function totalsOf(records: Admitted, coverage: Coverage): SpendTotals {
  let tokens = ZERO_TOKENS
  let authoritativeCostUsd = 0
  let estimatedCostUsd = 0
  let costEventCount = 0
  let estimatedCostEventCount = 0
  let firstTs: number | null = null
  let lastTs: number | null = null
  const estimateSources = new Set<string>()
  const models = new Set<string>()
  const roles = new Set<AgentRole>()
  const origins = new Set<TelemetryOrigin>()

  const touch = (ts: number, origin: TelemetryOrigin): void => {
    origins.add(origin)
    firstTs = firstTs === null ? ts : Math.min(firstTs, ts)
    lastTs = lastTs === null ? ts : Math.max(lastTs, ts)
  }

  for (const record of records.usage) {
    tokens = addTokens(tokens, record.tokens)
    models.add(record.model)
    roles.add(record.role)
    touch(record.ts, record.origin)
    if (covered(record.lane, record.sessionId, coverage)) continue
    const estimate = estimateCostUsd(record.model, record.tokens)
    if (estimate === null) continue
    estimatedCostUsd += estimate.costUsd
    estimatedCostEventCount += 1
    costEventCount += 1
    estimateSources.add(estimate.source)
  }
  for (const record of records.costs) {
    if (record.authoritative) authoritativeCostUsd += record.costUsd
    else {
      estimatedCostUsd += record.costUsd
      estimatedCostEventCount += 1
    }
    costEventCount += 1
    models.add(record.model)
    roles.add(record.role)
    touch(record.ts, record.origin)
  }
  for (const record of records.tools) {
    if (record.role !== null) roles.add(record.role)
    touch(record.ts, record.origin)
  }

  return {
    tokens: { ...tokens, total: totalTokens(tokens) },
    costUsd: authoritativeCostUsd + estimatedCostUsd,
    authoritativeCostUsd,
    estimatedCostUsd,
    costIsAuthoritative: costEventCount === 0 ? null : estimatedCostEventCount === 0,
    requestCount: records.usage.length,
    costEventCount,
    estimatedCostEventCount,
    estimateSources: [...estimateSources].sort(compareStrings),
    toolCallCount: records.tools.length,
    models: [...models].sort(compareStrings),
    roles: AGENT_ROLES.filter((role) => roles.has(role)),
    origins: [...origins].sort(compareStrings),
    firstTs,
    lastTs,
  }
}

function only(records: Admitted, keep: (record: { lane: string }) => boolean): Admitted {
  return {
    usage: records.usage.filter(keep),
    costs: records.costs.filter(keep),
    tools: records.tools.filter(keep),
  }
}

function bySpend<T extends SpendTotals>(name: (entry: T) => string) {
  return (a: T, b: T): number =>
    b.costUsd - a.costUsd || b.tokens.output - a.tokens.output || compareStrings(name(a), name(b))
}

function threadRowsOf(records: Admitted, coverage: Coverage): ThreadSpend[] {
  const threads = new Set<AgentThread | null>()
  for (const record of [...records.usage, ...records.costs, ...records.tools]) threads.add(record.thread)
  if (![...threads].some((thread) => thread !== null)) return []
  const order = (thread: AgentThread | null): number =>
    thread === null ? AGENT_THREADS.length : AGENT_THREADS.indexOf(thread)
  return [...threads]
    .map((thread) => ({
      ...totalsOf(
        {
          usage: records.usage.filter((record) => record.thread === thread),
          costs: records.costs.filter((record) => record.thread === thread),
          tools: records.tools.filter((record) => record.thread === thread),
        },
        coverage,
      ),
      thread,
    }))
    .sort(
      (a, b) => b.costUsd - a.costUsd || b.tokens.output - a.tokens.output || order(a.thread) - order(b.thread),
    )
}

/** Every rollup the six selectors produce, computed the long way. */
function reference(state: SessionState, filter: SpendFilter = {}) {
  const records = admitted(state, filter)
  const coverage = coverageOf(state, filter)
  const all = [...records.usage, ...records.costs, ...records.tools]

  const laneKeys = new Set<string>(Object.keys(state.telemetry.lanes))
  for (const record of all) laneKeys.add(record.lane)

  const lanes: LaneSpend[] = [...laneKeys]
    .map((lane) => {
      const mine = only(records, (record) => record.lane === lane)
      const toolCounts: Record<string, number> = {}
      for (const record of mine.tools) toolCounts[record.tool] = (toolCounts[record.tool] ?? 0) + 1
      const attribution = state.telemetry.lanes[lane]
      return {
        ...totalsOf(mine, coverage),
        lane,
        worktreePath: attribution?.worktreePath ?? null,
        branch: attribution?.branch ?? null,
        sessionIds: attribution?.sessionIds ?? [],
        toolCounts,
        threads: threadRowsOf(mine, coverage),
      }
    })
    .sort(bySpend((entry) => entry.lane))

  const worktrees: Record<string, WorktreeSpend> = {}
  for (const lane of lanes) {
    if (lane.worktreePath === null) continue
    const siblings = lanes.filter((entry) => entry.worktreePath === lane.worktreePath)
    if (worktrees[lane.worktreePath] !== undefined) continue
    const mine = only(records, (record) => siblings.some((sibling) => sibling.lane === record.lane))
    worktrees[lane.worktreePath] = {
      ...totalsOf(mine, coverage),
      worktreePath: lane.worktreePath,
      lanes: siblings.map((sibling) => sibling.lane).sort(compareStrings),
    }
  }

  // A branch's row exists because git or telemetry ever mentioned it; the
  // filter only decides which of its spend counts.
  const branchKeys = new Set<string>(Object.keys(state.branches))
  for (const record of [...state.telemetry.usage, ...state.telemetry.costs, ...state.telemetry.tools]) {
    if (record.branch !== null) branchKeys.add(record.branch)
  }
  const branches: BranchSpend[] = [...branchKeys]
    .map((branch) => {
      const mine: Admitted = {
        usage: records.usage.filter((record) => record.branch === branch),
        costs: records.costs.filter((record) => record.branch === branch),
        tools: records.tools.filter((record) => record.branch === branch),
      }
      const totals = totalsOf(mine, coverage)
      const worktreePath = state.branches[branch]?.worktreePath ?? null
      const worktree = worktreePath === null ? undefined : state.worktrees[worktreePath]
      return {
        ...totals,
        branch,
        issue: /^\d+/.exec(branch)?.[0] ?? null,
        lanes: [
          ...new Set([...mine.usage, ...mine.costs, ...mine.tools].map((record) => record.lane)),
        ].sort(compareStrings),
        worktreePath,
        landed: worktree !== undefined && !worktree.present,
        elapsedMs: totals.firstTs === null || totals.lastTs === null ? null : totals.lastTs - totals.firstTs,
      }
    })
    .sort(bySpend((entry) => entry.branch))

  const modelKeys = new Set<string>([...records.usage, ...records.costs].map((record) => record.model))
  const models: ModelSpend[] = [...modelKeys]
    .map((model) => {
      const mine: Admitted = {
        usage: records.usage.filter((record) => record.model === model),
        costs: records.costs.filter((record) => record.model === model),
        tools: [],
      }
      return {
        ...totalsOf(mine, coverage),
        model,
        lanes: [...new Set([...mine.usage, ...mine.costs].map((record) => record.lane))].sort(compareStrings),
      }
    })
    .sort(bySpend((entry) => entry.model))

  const roleRow = (role: AgentRole) => {
    const mine: Admitted = {
      usage: records.usage.filter((record) => record.role === role),
      costs: records.costs.filter((record) => record.role === role),
      tools: records.tools.filter((record) => record.role === role),
    }
    return {
      ...totalsOf(mine, coverage),
      role,
      lanes: [
        ...new Set([...mine.usage, ...mine.costs, ...mine.tools].map((record) => record.lane)),
      ].sort(compareStrings),
    }
  }
  const worker = roleRow('worker')
  const conductor = roleRow('conductor')
  const roles: RoleSpendSplit = {
    worker,
    conductor,
    auxiliary: roleRow('auxiliary'),
    unattributed: roleRow('unattributed'),
    overheadRatio:
      conductor.tokens.output <= 0 || worker.tokens.output <= 0
        ? null
        : conductor.tokens.output / worker.tokens.output,
  }

  const pairs = new Set<string>()
  for (const record of [...records.usage, ...records.costs]) pairs.add(`${record.role}|${record.lane}`)
  for (const record of records.tools) if (record.role !== null) pairs.add(`${record.role}|${record.lane}`)
  const laneRoles: LaneRoleSpend[] = [...pairs]
    .map((pair) => {
      const [role, lane] = [pair.slice(0, pair.indexOf('|')), pair.slice(pair.indexOf('|') + 1)]
      const mine: Admitted = {
        usage: records.usage.filter((record) => record.role === role && record.lane === lane),
        costs: records.costs.filter((record) => record.role === role && record.lane === lane),
        tools: records.tools.filter((record) => record.role === role && record.lane === lane),
      }
      return { ...totalsOf(mine, coverage), lane, role: role as AgentRole }
    })
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        b.tokens.output - a.tokens.output ||
        compareStrings(a.lane, b.lane) ||
        compareStrings(a.role, b.role),
    )

  return {
    session: totalsOf(records, coverage),
    lanes,
    worktrees,
    branches,
    models,
    roles,
    laneRoles,
  }
}

// --- the corpora ------------------------------------------------------------

const T = FIXTURE_START_TS
const minute = 60_000

/**
 * The amplified corpus: four lanes across three branches, two threads, three
 * models, both collectors, and three deliberate traps —
 *
 * - `7-web` reports usage for a while and only *then* its first `llm.cost`, so
 *   every estimate this file made for it has to be retracted mid-stream;
 * - `9-ui` never reports a cost event at all, so its estimates stand;
 * - one usage record names a model the vendored table cannot match, which must
 *   stay an honest gap rather than a zero.
 */
function amplifiedEvents(perLane = 120): RhizomorphEvent[] {
  const f = createEventFactory({ stepMs: 250, idPrefix: 'amp' })
  const lanes = ['2-core', '3-git', '7-web', '9-ui'] as const
  const wt = (lane: string) => `/repo/rhizomorph-wt/${lane}`

  f.sessionStarted({ sessionId: 'amp', repoPath: '/repo/rhizomorph', repoName: 'rhizomorph', mainBranch: 'main' })
  f.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', head: 'sha-main', isMain: true })
  for (const lane of lanes) {
    f.worktreeDiscovered({ path: wt(lane), branch: lane, head: `sha-${lane}`, isMain: false })
  }
  // A landed branch: its worktree is gone, its spend is not.
  f.worktreeRemoved({ path: wt('2-core') })

  for (let i = 0; i < perLane; i += 1) {
    for (const lane of lanes) {
      const thread: AgentThread | null = i % 3 === 0 ? 'main' : i % 3 === 1 ? 'subagent' : null
      f.llmUsage({
        lane,
        role: i % 5 === 0 ? 'conductor' : 'worker',
        model:
          i === 7 && lane === '9-ui'
            ? 'claude-opus-5[1m]'
            : i % 3 === 0
              ? 'claude-sonnet-5'
              : 'claude-opus-5',
        tokens: {
          input: 1 + (i % 4),
          output: 100 + (i % 700),
          cacheRead: 1_000 * (i % 9),
          cacheCreation: 50 * (i % 5),
        },
        requestId: `req-${lane}-${i}`,
        sessionId: `sess-${lane}`,
        worktreePath: wt(lane),
        branch: i % 11 === 0 ? null : lane,
        thread,
      })
      f.toolActivity({
        lane,
        tool: ['Bash', 'Edit', 'Read'][i % 3] as string,
        role: i % 4 === 0 ? null : 'worker',
        sessionId: `sess-${lane}`,
        worktreePath: wt(lane),
        branch: i % 11 === 0 ? null : lane,
        toolUseId: `toolu-${lane}-${i}`,
        thread,
      })
      // '2-core' and '3-git' are covered from the first record. '7-web' only
      // becomes covered halfway through. '9-ui' never does.
      const reportsCost =
        lane === '2-core' || lane === '3-git' || (lane === '7-web' && i > perLane / 2)
      if (reportsCost && i % 4 === 0) {
        f.llmCost(
          {
            lane,
            role: 'worker',
            model: 'claude-opus-5',
            costUsd: 0.01 + (i % 7) / 100,
            authoritative: i % 8 !== 0,
            sessionId: `sess-${lane}`,
            worktreePath: wt(lane),
            branch: lane,
          },
          { source: 'otel' },
        )
      }
    }
  }
  return f.all()
}

const AMPLIFIED_EVENTS = amplifiedEvents()
const amplified = reduceAll(AMPLIFIED_EVENTS)
const swarm = reduceAll(fixtureTelemetrySession())

const CORPORA: readonly (readonly [string, SessionState])[] = [
  ['an empty session', initialSessionState()],
  ['a v0 log with no telemetry', reduceAll(fixtureSession())],
  ['the fixture swarm', swarm],
  ['an amplified session', amplified],
]

const FILTERS: readonly (readonly [string, SpendFilter])[] = [
  ['no filter', {}],
  ['sessionlog only', { origins: ['sessionlog'] }],
  ['authoritative dollars only', { costs: 'authoritative' }],
  ['estimated dollars only', { costs: 'estimated' }],
  ['a mid-session window', { since: T + minute, until: T + 20 * minute }],
]

function recordCount(state: SessionState): number {
  return state.telemetry.usage.length + state.telemetry.costs.length + state.telemetry.tools.length
}

const DOLLAR_FIELDS = new Set(['costUsd', 'authoritativeCostUsd', 'estimatedCostUsd'])

/**
 * Everything compared exactly, except that dollars are rounded to ten decimal
 * places — a hundred-millionth of a cent — before comparison.
 *
 * Not a softened law, a named one. The oracle sums prd9-ruling-7 estimates in
 * record order across every lane at once; the engine parks each lane's
 * estimates under their owner ({@link OwnerEstimate}, which is what lets a late
 * `llm.cost` retract them) and sums owner by owner. Same addends, different
 * association, and IEEE-754 addition is not associative — the observed spread is
 * 3e-16 on a $1.67 total. Bit-equality of a float sum is an accident of
 * evaluation order, not a fact about spend, which is why this file's own
 * neighbours (`spend.test.ts`) assert dollars with `toBeCloseTo(…, 6)` and
 * `(…, 10)` throughout. Token counts, event counts, flags, ids, names and
 * timestamps are all still compared exactly.
 */
function comparable<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => comparable(entry)) as unknown as T
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      DOLLAR_FIELDS.has(key) && typeof entry === 'number'
        ? Number(entry.toFixed(10))
        : comparable(entry)
  }
  return out as T
}

/** Every rollup, read through a one-shot cursor advance. */
function throughCursors(state: SessionState, filter: SpendFilter) {
  return {
    session: spendFrom(sessionSpendCursor(filter), state).value,
    lanes: spendFrom(laneSpendCursor(filter), state).value,
    worktrees: spendFrom(worktreeSpendCursor(filter), state).value,
    branches: spendFrom(branchSpendCursor(filter), state).value,
    models: spendFrom(modelSpendCursor(filter), state).value,
    roles: spendFrom(roleSpendCursor(filter), state).value,
    laneRoles: spendFrom(laneRoleSpendCursor(filter), state).value,
  }
}

/** Every rollup, read through the public selectors. */
function throughSelectors(state: SessionState, filter: SpendFilter) {
  return {
    session: selectSessionSpend(state, filter),
    lanes: selectLaneSpend(state, filter),
    worktrees: selectSpendByWorktree(state, filter),
    branches: selectSpendByBranch(state, filter),
    models: selectModelSpend(state, filter),
    roles: selectRoleSpend(state, filter),
    laneRoles: selectSpendByLaneRole(state, filter),
  }
}

// --- LAW 1: identity --------------------------------------------------------

describe('LAW 1 — identity: the collapsed selectors and the cursor are the naive rescan', () => {
  it('the amplified corpus is actually big enough, and hits all three traps', () => {
    expect(recordCount(amplified)).toBeGreaterThan(1_000)
    // '9-ui' never reported a cost event, so its dollars are all our estimate.
    const ui = selectLaneSpend(amplified).find((lane) => lane.lane === '9-ui')
    expect(ui?.estimatedCostUsd).toBeGreaterThan(0)
    expect(ui?.authoritativeCostUsd).toBe(0)
    expect(ui?.estimateSources).toEqual([PRICE_SOURCE_NAME])
    // '7-web' reported one late, which retracts every estimate made for it.
    const web = selectLaneSpend(amplified).find((lane) => lane.lane === '7-web')
    expect(web?.estimatedCostUsd).toBeGreaterThan(0) // from non-authoritative cost EVENTS
    expect(web?.authoritativeCostUsd).toBeGreaterThan(0)
    expect(web?.estimateSources).toEqual([]) // ...but none of it priced on read
    // The unmatched model stayed a gap: nothing invented a dollar for it.
    expect(estimateCostUsd('claude-opus-5[1m]', { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 })).toBeNull()
  })

  for (const [corpusName, state] of CORPORA) {
    for (const [filterName, filter] of FILTERS) {
      it(`${corpusName}, ${filterName}: selectors match the oracle`, () => {
        expect(comparable(throughSelectors(state, filter))).toEqual(comparable(reference(state, filter)))
      })

      it(`${corpusName}, ${filterName}: cursors match the oracle`, () => {
        expect(comparable(throughCursors(state, filter))).toEqual(comparable(reference(state, filter)))
      })
    }
  }

  it('a cursor walked one prefix at a time lands where a single advance lands', () => {
    const steps = [0, 1, 17, 200, 1_000, AMPLIFIED_EVENTS.length]
    let walked = laneSpendCursor()
    for (const step of steps) {
      const state = reduceAll(AMPLIFIED_EVENTS.slice(0, step))
      walked = spendFrom(walked, state)
      // Every intermediate answer is also the oracle's answer for that prefix,
      // so this is not just "the ends agree".
      expect(comparable(walked.value)).toEqual(comparable(reference(state).lanes))
    }
    expect(walked.value).toEqual(spendFrom(laneSpendCursor(), amplified).value)
  })

  it('reading the same state twice changes nothing', () => {
    const once = spendFrom(sessionSpendCursor(), amplified)
    const twice = spendFrom(once, amplified)
    expect(twice.value).toEqual(once.value)
    expect(twice.visited).toBe(0)
  })
})

// --- LAW 2: complexity ------------------------------------------------------

describe('LAW 2 — complexity: an advance visits only what was appended', () => {
  /** States at rising prefixes — a fresh object each time, exactly as a seek folds. */
  function seeks(counts: readonly number[]): SessionState[] {
    return counts.map((count) => reduceAll(AMPLIFIED_EVENTS.slice(0, count)))
  }

  it('visits exactly the records the new prefix added, at every step', () => {
    const states = seeks([100, 300, 301, 700, 1_400, AMPLIFIED_EVENTS.length])
    let cursor: SpendCursor<LaneSpend[]> = laneSpendCursor()
    let previous = 0
    for (const state of states) {
      cursor = spendFrom(cursor, state)
      expect(cursor.visited).toBe(recordCount(state) - previous)
      expect(cursor.rewound).toBe(false)
      previous = recordCount(state)
    }
  })

  it('costs a fraction of what the same walk costs by rescanning', () => {
    const counts = [200, 400, 600, 800, 1_000, 1_200, AMPLIFIED_EVENTS.length]
    const states = seeks(counts)
    let cursor: SpendCursor<SpendTotals> = sessionSpendCursor()
    let cursorVisits = 0
    let rescanVisits = 0
    for (const state of states) {
      cursor = spendFrom(cursor, state)
      cursorVisits += cursor.visited
      rescanVisits += recordCount(state)
    }
    // The whole walk reads each record once; a rescan reads every prefix again.
    expect(cursorVisits).toBe(recordCount(states[states.length - 1] as SessionState))
    expect(cursorVisits).toBeLessThan(rescanVisits / 3)
    expect(cursor.visitedTotal).toBe(cursorVisits)
  })

  it('every one of the seven cursors obeys it, not just the lane one', () => {
    const [before, after] = seeks([900, 1_100]) as [SessionState, SessionState]
    const added = recordCount(after) - recordCount(before)
    const makers: readonly (readonly [string, () => SpendCursor<unknown>])[] = [
      ['session', () => sessionSpendCursor()],
      ['lane', () => laneSpendCursor()],
      ['worktree', () => worktreeSpendCursor()],
      ['branch', () => branchSpendCursor()],
      ['model', () => modelSpendCursor()],
      ['role', () => roleSpendCursor()],
      ['laneRole', () => laneRoleSpendCursor()],
    ]
    for (const [name, make] of makers) {
      const first = spendFrom(make(), before)
      const second = spendFrom(first, after)
      expect(first.visited, name).toBe(recordCount(before))
      expect(second.visited, name).toBe(added)
    }
  })

  it('a backward scrub re-reads from a keyframe, not from event zero', () => {
    // Drag forward the way a drag does — many small seeks — then scrub back.
    let forward = laneSpendCursor()
    for (const state of seeks([200, 400, 600, 800, 1_000, AMPLIFIED_EVENTS.length])) {
      forward = spendFrom(forward, state)
    }
    expect(forward.keyframes.length).toBeGreaterThan(0)

    const back = reduceAll(AMPLIFIED_EVENTS.slice(0, Math.floor(AMPLIFIED_EVENTS.length * 0.6)))
    const scrubbed = spendFrom(forward, back)
    expect(scrubbed.rewound).toBe(true)
    expect(comparable(scrubbed.value)).toEqual(comparable(reference(back).lanes))
    // The whole point: fewer records than the prefix holds, and no more than
    // the keyframe spacing plus whatever lies between it and the target.
    expect(scrubbed.visited).toBeLessThan(recordCount(back))
    expect(scrubbed.visited).toBeLessThanOrEqual(DEFAULT_SPEND_KEYFRAME_INTERVAL)
  })

  it('one bulk advance still leaves keyframes behind it', () => {
    // A fresh load, or a drag straight to the end: nothing incremental to
    // continue from, so the catch-up chunks itself and snapshots as it goes —
    // otherwise the backward scrub that follows would start from zero.
    const bulk = spendFrom(laneSpendCursor(), amplified)
    expect(bulk.visited).toBe(recordCount(amplified))
    expect(bulk.keyframes.length).toBeGreaterThanOrEqual(
      Math.floor(recordCount(amplified) / DEFAULT_SPEND_KEYFRAME_INTERVAL),
    )

    const back = reduceAll(AMPLIFIED_EVENTS.slice(0, Math.floor(AMPLIFIED_EVENTS.length * 0.6)))
    const scrubbed = spendFrom(bulk, back)
    expect(comparable(scrubbed.value)).toEqual(comparable(reference(back).lanes))
    expect(scrubbed.visited).toBeLessThan(recordCount(back))
  })

  it('a state from another session is rebuilt, never continued', () => {
    const cursor = spendFrom(sessionSpendCursor(), amplified)
    const stranger = spendFrom(cursor, swarm)
    expect(stranger.rewound).toBe(true)
    expect(comparable(stranger.value)).toEqual(comparable(reference(swarm).session))
    expect(stranger.visited).toBe(recordCount(swarm))
  })
})

// --- LAW 3: order -----------------------------------------------------------

describe('LAW 3 — order: spend at ts is spend over the append-order prefix at ts', () => {
  /**
   * A log that goes backwards in `ts` mid-stream — what a tailed real log does
   * (#205's own evidence), and the case that kills any cursor tempted to
   * binary-search a sorted array instead of walking append order.
   */
  function nonMonotonicEvents(): RhizomorphEvent[] {
    const f = createEventFactory({ stepMs: 0, idPrefix: 'ooo' })
    const usage = (lane: string, output: number, ts: number) =>
      f.llmUsage(
        {
          lane,
          role: 'worker',
          model: 'claude-opus-5',
          tokens: { input: 1, output, cacheRead: 0, cacheCreation: 0 },
          requestId: `req-${lane}-${output}`,
          sessionId: `sess-${lane}`,
          worktreePath: `/wt/${lane}`,
          branch: lane,
        },
        { ts },
      )
    f.sessionStarted({ sessionId: 'ooo', repoPath: '/r', repoName: 'r', mainBranch: 'main' })
    usage('a', 10, T + 5 * minute)
    usage('a', 20, T + 9 * minute)
    // The late line: written after the one above, but older than it.
    usage('a', 40, T + 7 * minute)
    usage('b', 80, T + 11 * minute)
    // And a cost event that arrives after all of them, retiring lane a's estimates.
    f.llmCost(
      { lane: 'a', role: 'worker', model: 'claude-opus-5', costUsd: 1.5, authoritative: true, sessionId: 'sess-a', worktreePath: '/wt/a', branch: 'a' },
      { source: 'otel', ts: T + 12 * minute },
    )
    return f.all()
  }

  const events = nonMonotonicEvents()

  it('the corpus really is out of order', () => {
    const timestamps = reduceAll(events).telemetry.usage.map((record) => record.ts)
    expect(timestamps).toEqual([T + 5 * minute, T + 9 * minute, T + 7 * minute, T + 11 * minute])
    expect(timestamps[2]).toBeLessThan(timestamps[1] as number)
  })

  it('an `until` counts a late record by its own ts, never by where it was written', () => {
    const state = reduceAll(events)
    // The 40-output record was written third but belongs at t+7m: an `until`
    // of t+8m must include it and exclude the t+9m line written before it.
    const upTo8 = selectSessionSpend(state, { until: T + 8 * minute })
    expect(upTo8.tokens.output).toBe(10 + 40)
    expect(upTo8.requestCount).toBe(2)
    expect(comparable(upTo8)).toEqual(comparable(reference(state, { until: T + 8 * minute }).session))
    // And the cursor agrees — it filters per record, it does not cut by position.
    expect(spendFrom(sessionSpendCursor({ until: T + 8 * minute }), state).value).toEqual(upTo8)
  })

  it('spend over the append-order prefix at ts equals spend at ts, at every ts', () => {
    // The replay mechanism: fold the log's own order up to a count of events at
    // or before ts (never a re-sorted order), then read spend off that state.
    const sorted = [...events].map((event) => event.ts).sort((a, b) => a - b)
    let cursor = spendFrom(sessionSpendCursor(), initialSessionState())
    for (const ts of [T, ...sorted, T + 99 * minute]) {
      const count = events.filter((event) => event.ts <= ts).length
      const prefix = reduceAll(events.slice(0, count))
      cursor = spendFrom(cursor, prefix)
      expect(comparable(cursor.value)).toEqual(comparable(reference(prefix).session))
      expect(cursor.value).toEqual(selectSessionSpend(prefix))
    }
  })

  it('a late cost event retracts the estimates already accumulated for its lane', () => {
    // Before the cost line lands, lane a's dollars are priced on read. After
    // it lands they are the CLI's, with no estimate stacked on top — and the
    // cursor has to get there without re-reading the usage records.
    const beforeCost = reduceAll(events.slice(0, events.length - 1))
    const afterCost = reduceAll(events)

    let cursor = spendFrom(laneSpendCursor(), beforeCost)
    const a = cursor.value.find((lane) => lane.lane === 'a')
    expect(a?.estimatedCostUsd).toBeGreaterThan(0)
    expect(a?.estimateSources).toEqual([PRICE_SOURCE_NAME])

    cursor = spendFrom(cursor, afterCost)
    expect(cursor.visited).toBe(1)
    const settled = cursor.value.find((lane) => lane.lane === 'a')
    expect(settled?.costUsd).toBe(1.5)
    expect(settled?.estimatedCostUsd).toBe(0)
    expect(settled?.estimateSources).toEqual([])
    expect(settled?.costIsAuthoritative).toBe(true)
    expect(comparable(cursor.value)).toEqual(comparable(reference(afterCost).lanes))
  })

  it('nothing here sorts: two logs with the same records in either order agree per prefix', () => {
    // Append order decides which prefix a record is in; it never decides what a
    // record contributes. So a swap of two adjacent lines with different ts
    // changes the intermediate prefixes and nothing about the final total.
    const swapped = [...events]
    const [second, third] = [swapped[2] as RhizomorphEvent, swapped[3] as RhizomorphEvent]
    swapped[2] = third
    swapped[3] = second
    expect(selectSessionSpend(reduceAll(swapped))).toEqual(selectSessionSpend(reduceAll(events)))
    expect(comparable(spendFrom(sessionSpendCursor(), reduceAll(swapped)).value)).toEqual(
      comparable(reference(reduceAll(swapped)).session),
    )
  })
})
