import { beforeEach, describe, expect, it } from 'vitest'
import {
  FIXTURE_NOW,
  FIXTURE_START_TS,
  createEventFactory,
  fixtureSession,
  fixtureTelemetrySession,
} from '../fixtures.js'
import type { ObservatoryEvent } from '../events/index.js'
import * as core from '../index.js'
import { reduceAll } from '../reduce.js'
import { type SessionState, initialSessionState } from '../state.js'
import {
  DEFAULT_SPEND_WINDOW_MS,
  selectLaneSpend,
  selectLaneSpendIndex,
  selectModelSpend,
  selectOverheadRatio,
  selectRecentToolActivity,
  selectRoleSpend,
  selectSessionSpend,
  selectSpendByBranch,
  selectSpendByBranchIndex,
  selectSpendByWorktree,
  selectSpendForBranch,
  selectSpendForLane,
  selectSpendRate,
  selectSpendRateByLane,
  selectTelemetryOrigins,
  selectToolUsage,
} from './spend.js'

const T = FIXTURE_START_TS
const minute = 60_000
const WT = (name: string) => `/repo/observatory-wt/${name}`

/** The fixture log, folded once — the numbers below are its real arithmetic. */
const swarm = reduceAll(fixtureTelemetrySession())

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

/** Fold a hand-built log without any of the v0 noise. */
function fold(...events: ObservatoryEvent[]): SessionState {
  return reduceAll(events)
}

const tokens = (
  input: number,
  output: number,
  cacheRead = 0,
  cacheCreation = 0,
): { input: number; output: number; cacheRead: number; cacheCreation: number } => ({
  input,
  output,
  cacheRead,
  cacheCreation,
})

describe('selectSessionSpend', () => {
  it('reports honest nothing for a state with no telemetry', () => {
    const totals = selectSessionSpend(initialSessionState())
    expect(totals).toEqual({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
      costUsd: 0,
      authoritativeCostUsd: 0,
      estimatedCostUsd: 0,
      costIsAuthoritative: null,
      requestCount: 0,
      costEventCount: 0,
      estimatedCostEventCount: 0,
      toolCallCount: 0,
      models: [],
      roles: [],
      origins: [],
      firstTs: null,
      lastTs: null,
    })
  })

  it('reports nothing for a v0 log too — telemetry is purely additive', () => {
    expect(selectSessionSpend(reduceAll(fixtureSession())).tokens.total).toBe(0)
  })

  it('sums every tier across the whole swarm', () => {
    const totals = selectSessionSpend(swarm)
    expect(totals.tokens).toEqual({
      input: 4 + 3 + 12 + 310 + 2 + 8,
      output: 3_100 + 1_900 + 5_600 + 40 + 2_400 + 4_200,
      cacheRead: 180_000 + 120_000 + 410_000 + 0 + 96_000 + 330_000,
      cacheCreation: 6_400 + 4_100 + 9_800 + 0 + 3_300 + 7_100,
      total: 1_184_279,
    })
    expect(totals.requestCount).toBe(6)
    expect(totals.toolCallCount).toBe(4)
  })

  it('splits authoritative dollars from estimates and never blends them silently', () => {
    const totals = selectSessionSpend(swarm)
    expect(totals.authoritativeCostUsd).toBeCloseTo(2.310591, 6)
    expect(totals.estimatedCostUsd).toBeCloseTo(0.31, 6)
    expect(totals.costUsd).toBeCloseTo(2.620591, 6)
    expect(totals.costEventCount).toBe(6)
    expect(totals.estimatedCostEventCount).toBe(1)
    // One estimate in the mix is enough to lose the claim of authority.
    expect(totals.costIsAuthoritative).toBe(false)
  })

  it('claims authority only when every dollar came from the CLI', () => {
    const state = fold(
      f.llmCost({ lane: 'a', costUsd: 1, authoritative: true }),
      f.llmCost({ lane: 'b', costUsd: 2, authoritative: true }),
    )
    expect(selectSessionSpend(state).costIsAuthoritative).toBe(true)
  })

  it('says "unknown", not "free", for a session with tokens and no dollars', () => {
    const state = fold(f.llmUsage({ lane: 'a', tokens: tokens(1, 2) }))
    const totals = selectSessionSpend(state)
    expect(totals.tokens.total).toBe(3)
    expect(totals.costUsd).toBe(0)
    expect(totals.costIsAuthoritative).toBeNull()
  })

  it('treats a genuine authoritative zero as authoritative', () => {
    const state = fold(f.llmCost({ lane: 'a', costUsd: 0, authoritative: true }))
    expect(selectSessionSpend(state).costIsAuthoritative).toBe(true)
  })

  it('does not let a zero-dollar estimate pass as authoritative', () => {
    const state = fold(f.llmCost({ lane: 'a', costUsd: 0, authoritative: false }))
    expect(selectSessionSpend(state).costIsAuthoritative).toBe(false)
  })

  it('lists models, roles and origins it actually saw', () => {
    const totals = selectSessionSpend(swarm)
    expect(totals.models).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-opus-5',
      'claude-sonnet-5',
    ])
    // Role order is the dimension's own order, not alphabetical.
    expect(totals.roles).toEqual(['worker', 'conductor', 'auxiliary'])
    expect(totals.origins).toEqual(['otel', 'sessionlog'])
  })

  it('spans from the first telemetry fact to the last', () => {
    const totals = selectSessionSpend(swarm)
    expect(totals.firstTs).toBe(T + minute)
    expect(totals.lastTs).toBe(T + 6 * minute + 1_000)
  })

  it('counts only the origins asked for — the cross-validation dedup lever', () => {
    const state = fold(
      f.llmUsage({ lane: 'a', tokens: tokens(1, 10) }),
      f.llmUsage({ lane: 'a', tokens: tokens(1, 10) }, { source: 'otel' }),
    )
    expect(selectSessionSpend(state).tokens.total).toBe(22)
    expect(selectSessionSpend(state, { origins: ['sessionlog'] }).tokens.total).toBe(11)
    expect(selectSessionSpend(state, { origins: ['otel'] }).tokens.total).toBe(11)
    expect(selectSessionSpend(state, { origins: [] }).tokens.total).toBe(0)
  })

  it('counts only authoritative or only estimated dollars on request', () => {
    expect(selectSessionSpend(swarm, { costs: 'authoritative' }).costUsd).toBeCloseTo(2.310591, 6)
    expect(selectSessionSpend(swarm, { costs: 'estimated' }).costUsd).toBeCloseTo(0.31, 6)
    expect(selectSessionSpend(swarm, { costs: 'estimated' }).costIsAuthoritative).toBe(false)
    expect(selectSessionSpend(swarm, { costs: 'authoritative' }).costIsAuthoritative).toBe(true)
  })

  it('honours an inclusive since/until window on both ends', () => {
    const state = fold(
      f.llmUsage({ lane: 'a', tokens: tokens(0, 1) }, { ts: 1_000 }),
      f.llmUsage({ lane: 'a', tokens: tokens(0, 2) }, { ts: 2_000 }),
      f.llmUsage({ lane: 'a', tokens: tokens(0, 4) }, { ts: 3_000 }),
    )
    expect(selectSessionSpend(state, { since: 2_000 }).tokens.total).toBe(6)
    expect(selectSessionSpend(state, { until: 2_000 }).tokens.total).toBe(3)
    expect(selectSessionSpend(state, { since: 2_000, until: 2_000 }).tokens.total).toBe(2)
    expect(selectSessionSpend(state, { since: 9_000 }).tokens.total).toBe(0)
  })

  it('never mutates the state it reads', () => {
    const snapshot = JSON.stringify(swarm.telemetry)
    selectSessionSpend(swarm)
    selectLaneSpend(swarm)
    selectModelSpend(swarm)
    selectRoleSpend(swarm)
    selectSpendRate(swarm, { now: FIXTURE_NOW })
    expect(JSON.stringify(swarm.telemetry)).toBe(snapshot)
  })
})

describe('selectLaneSpend', () => {
  it('gives the swarm one row per lane, dearest first', () => {
    expect(selectLaneSpend(swarm).map((lane) => lane.lane)).toEqual([
      'conductor',
      '2-core',
      '7-web',
      '3-git',
    ])
  })

  it('totals a lane across the roles and models inside it', () => {
    const core = selectSpendForLane(swarm, '2-core')
    // 2-core is a worker lane that also carries the CLI's own haiku call.
    expect(core?.tokens.total).toBe(189_504 + 350)
    expect(core?.costUsd).toBeCloseTo(0.420591, 6)
    expect(core?.requestCount).toBe(2)
    expect(core?.roles).toEqual(['worker', 'auxiliary'])
    expect(core?.models).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5'])
  })

  it('carries the attribution the lane index learned', () => {
    expect(selectSpendForLane(swarm, '3-git')).toMatchObject({
      worktreePath: WT('3-git'),
      branch: '3-git',
      sessionIds: ['sess-3-git'],
    })
    // The conductor lives outside every worktree, and says so.
    expect(selectSpendForLane(swarm, 'conductor')).toMatchObject({
      worktreePath: null,
      branch: null,
    })
  })

  it('counts tool calls per tool, per lane', () => {
    expect(selectSpendForLane(swarm, '2-core')?.toolCounts).toEqual({ Write: 1, Bash: 1 })
    expect(selectSpendForLane(swarm, '3-git')?.toolCounts).toEqual({ Bash: 1 })
    expect(selectSpendForLane(swarm, 'conductor')?.toolCounts).toEqual({})
  })

  it('flags the lane whose dollars are only an estimate', () => {
    expect(selectSpendForLane(swarm, '7-web')?.costIsAuthoritative).toBe(false)
    expect(selectSpendForLane(swarm, '3-git')?.costIsAuthoritative).toBe(true)
  })

  it('keeps a known lane visible at zero rather than dropping it', () => {
    // A lane that only ever ran tools has no tokens, but it is not missing.
    const state = fold(
      f.llmUsage({ lane: 'spender', tokens: tokens(1, 1) }),
      f.toolActivity({ lane: 'quiet', tool: 'Read' }),
    )
    const rows = selectLaneSpend(state)
    expect(rows.map((row) => row.lane)).toEqual(['spender', 'quiet'])
    expect(rows[1]).toMatchObject({ tokens: { total: 0 }, costUsd: 0, toolCallCount: 1 })
  })

  it('still lists every lane, zeroed, when the filter excludes everything', () => {
    const rows = selectLaneSpend(swarm, { since: FIXTURE_NOW + minute })
    expect(rows.map((row) => row.lane)).toEqual(['2-core', '3-git', '7-web', 'conductor'])
    for (const row of rows) {
      expect(row.tokens.total, row.lane).toBe(0)
      expect(row.costIsAuthoritative, row.lane).toBeNull()
    }
  })

  it('indexes by lane, and reports null for a lane nobody mentioned', () => {
    expect(Object.keys(selectLaneSpendIndex(swarm)).sort()).toEqual([
      '2-core',
      '3-git',
      '7-web',
      'conductor',
    ])
    expect(selectSpendForLane(swarm, 'no-such-lane')).toBeNull()
  })

  it('breaks a cost tie by tokens, then by lane name', () => {
    const state = fold(
      f.llmUsage({ lane: 'b', tokens: tokens(0, 5) }),
      f.llmUsage({ lane: 'a', tokens: tokens(0, 5) }),
      f.llmUsage({ lane: 'c', tokens: tokens(0, 9) }),
    )
    expect(selectLaneSpend(state).map((row) => row.lane)).toEqual(['c', 'a', 'b'])
  })
})

describe('selectSpendByWorktree', () => {
  it('joins lane spend onto the worktree table', () => {
    const byWorktree = selectSpendByWorktree(swarm)
    expect(Object.keys(byWorktree).sort()).toEqual([WT('2-core'), WT('3-git'), WT('7-web')])
    expect(byWorktree[WT('2-core')]?.tokens.total).toBe(189_504 + 350)
    expect(byWorktree[WT('3-git')]?.costUsd).toBeCloseTo(0.28, 6)
  })

  it('leaves out spend it cannot attribute to a path, without losing it', () => {
    // The conductor's 766,720 tokens are absent here and present in lane spend.
    const byWorktree = selectSpendByWorktree(swarm)
    expect(byWorktree.conductor).toBeUndefined()
    const attributed = Object.values(byWorktree).reduce(
      (sum, entry) => sum + entry.tokens.total,
      0,
    )
    expect(attributed).toBe(1_184_279 - 766_720)
    expect(selectSpendForLane(swarm, 'conductor')?.tokens.total).toBe(766_720)
  })

  it('merges two lanes sharing one worktree, tiers and flags included', () => {
    const path = WT('shared')
    const state = fold(
      f.llmUsage({ lane: 'first', worktreePath: path, tokens: tokens(1, 2, 3, 4) }),
      f.llmCost({ lane: 'first', worktreePath: path, costUsd: 1, authoritative: true }),
      f.llmUsage({ lane: 'second', worktreePath: path, tokens: tokens(10, 20, 30, 40) }),
      f.llmCost({ lane: 'second', worktreePath: path, costUsd: 2, authoritative: false }),
    )
    const entry = selectSpendByWorktree(state)[path]
    expect(entry?.lanes).toEqual(['first', 'second'])
    expect(entry?.tokens).toEqual({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheCreation: 44,
      total: 110,
    })
    expect(entry?.costUsd).toBeCloseTo(3, 6)
    expect(entry?.authoritativeCostUsd).toBeCloseTo(1, 6)
    expect(entry?.estimatedCostUsd).toBeCloseTo(2, 6)
    expect(entry?.costIsAuthoritative).toBe(false)
  })
})

describe('selectSpendByBranch', () => {
  const BRANCH = '48-branch-ledger'
  const PATH = WT(BRANCH)

  it('keeps a branch\'s full spend after its worktree is removed — the whole point of keying by branch', () => {
    const state = fold(
      f.worktreeDiscovered({ path: PATH, branch: BRANCH, head: 'sha-0', isMain: false }),
      f.llmUsage({
        lane: BRANCH,
        branch: BRANCH,
        worktreePath: PATH,
        tokens: tokens(2, 500, 40_000, 1_000),
      }),
      f.llmCost({ lane: BRANCH, branch: BRANCH, worktreePath: PATH, costUsd: 0.75, authoritative: true }),
      f.worktreeRemoved({ path: PATH }),
    )
    const row = selectSpendForBranch(state, BRANCH)
    expect(row).not.toBeNull()
    expect(row?.landed).toBe(true)
    expect(row?.tokens.total).toBe(2 + 500 + 40_000 + 1_000)
    expect(row?.costUsd).toBeCloseTo(0.75, 6)
    expect(row?.costIsAuthoritative).toBe(true)
    expect(row?.worktreePath).toBe(PATH)
  })

  it('reports landed: false while the worktree is still present', () => {
    const state = fold(
      f.worktreeDiscovered({ path: PATH, branch: BRANCH, head: 'sha-0', isMain: false }),
      f.llmUsage({ lane: BRANCH, branch: BRANCH, worktreePath: PATH, tokens: tokens(0, 1) }),
    )
    expect(selectSpendForBranch(state, BRANCH)?.landed).toBe(false)
  })

  it('reports landed: false for a branch telemetry has seen but git never discovered', () => {
    const state = fold(
      f.llmUsage({ lane: 'x', branch: 'ghost-branch', worktreePath: null, tokens: tokens(0, 1) }),
    )
    const row = selectSpendForBranch(state, 'ghost-branch')
    expect(row?.landed).toBe(false)
    expect(row?.worktreePath).toBeNull()
  })

  it('extracts the issue number from a fenced-issue branch name, and null otherwise', () => {
    const state = fold(
      f.llmUsage({ lane: BRANCH, branch: BRANCH, tokens: tokens(0, 1) }),
      f.llmUsage({ lane: 'main', branch: 'main', tokens: tokens(0, 1) }),
    )
    expect(selectSpendForBranch(state, BRANCH)?.issue).toBe('48')
    expect(selectSpendForBranch(state, 'main')?.issue).toBeNull()
  })

  it('rolls up every lane recorded against a branch', () => {
    const state = fold(
      f.llmUsage({ lane: 'lane-a', branch: BRANCH, tokens: tokens(0, 5) }),
      f.llmUsage({ lane: 'lane-b', branch: BRANCH, tokens: tokens(0, 7) }),
    )
    const row = selectSpendForBranch(state, BRANCH)
    expect(row?.lanes).toEqual(['lane-a', 'lane-b'])
    expect(row?.tokens.total).toBe(12)
  })

  it('drops telemetry with no branch attribution — the conductor lives outside every branch', () => {
    const state = fold(
      f.llmUsage({ lane: 'conductor', branch: null, role: 'conductor', tokens: tokens(0, 999) }),
    )
    expect(selectSpendByBranch(state)).toEqual([])
  })

  it('still lists a known branch at zero when the filter excludes its only telemetry', () => {
    const state = fold(
      f.llmUsage({ lane: BRANCH, branch: BRANCH, tokens: tokens(0, 5) }, { ts: 1_000 }),
    )
    const rows = selectSpendByBranch(state, { since: 5_000 })
    expect(rows.map((row) => row.branch)).toEqual([BRANCH])
    expect(rows[0]?.tokens.total).toBe(0)
    expect(rows[0]?.costIsAuthoritative).toBeNull()
  })

  it('computes elapsed working time from first to last activity, null when nothing arrived', () => {
    const state = fold(
      f.llmUsage({ lane: BRANCH, branch: BRANCH, tokens: tokens(0, 1) }, { ts: 1_000 }),
      f.llmCost({ lane: BRANCH, branch: BRANCH, costUsd: 1, authoritative: true }, { ts: 9_000 }),
    )
    expect(selectSpendForBranch(state, BRANCH)?.elapsedMs).toBe(8_000)
    expect(selectSpendForBranch(state, 'no-such-branch')).toBeNull()
  })

  it('indexes by branch, and reports null for one nobody mentioned', () => {
    const state = fold(f.llmUsage({ lane: BRANCH, branch: BRANCH, tokens: tokens(0, 1) }))
    expect(Object.keys(selectSpendByBranchIndex(state))).toEqual([BRANCH])
    expect(selectSpendForBranch(state, 'nope')).toBeNull()
  })

  it('reads the swarm fixture the same way selectLaneSpend does for workers, since lane and branch coincide there', () => {
    const byBranch = selectSpendByBranchIndex(swarm)
    for (const laneName of ['2-core', '3-git', '7-web']) {
      const lane = selectSpendForLane(swarm, laneName)
      const branch = byBranch[laneName]
      expect(branch?.tokens).toEqual(lane?.tokens)
      expect(branch?.costUsd).toBeCloseTo(lane?.costUsd ?? NaN, 6)
      expect(branch?.costIsAuthoritative).toBe(lane?.costIsAuthoritative ?? null)
    }
    // The conductor has no branch attribution at all — it never appears here.
    expect(byBranch.conductor).toBeUndefined()
    // Every branch fixtureSession's git events discovered shows up, main included, zeroed.
    expect(byBranch.main).toMatchObject({ tokens: { total: 0 }, landed: false, issue: null })
  })

  it('never mutates the state it reads', () => {
    const snapshot = JSON.stringify(swarm.telemetry)
    selectSpendByBranch(swarm)
    expect(JSON.stringify(swarm.telemetry)).toBe(snapshot)
  })
})

describe('selectModelSpend', () => {
  it('breaks the swarm down by model, dearest first', () => {
    const models = selectModelSpend(swarm)
    expect(models.map((model) => model.model)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-haiku-4-5-20251001',
    ])
    expect(models[0]).toMatchObject({ tokens: { total: 766_720 }, lanes: ['conductor'] })
    expect(models[1]?.tokens.total).toBe(417_209)
    expect(models[1]?.lanes).toEqual(['2-core', '3-git', '7-web'])
    expect(models[2]?.tokens.total).toBe(350)
  })

  it('adds up to the session total', () => {
    const models = selectModelSpend(swarm)
    expect(models.reduce((sum, model) => sum + model.tokens.total, 0)).toBe(1_184_279)
    expect(models.reduce((sum, model) => sum + model.costUsd, 0)).toBeCloseTo(2.620591, 6)
  })

  it('is empty for a session with no model traffic', () => {
    expect(selectModelSpend(initialSessionState())).toEqual([])
    expect(selectModelSpend(fold(f.toolActivity({ lane: 'a', tool: 'Bash' })))).toEqual([])
  })
})

describe('selectRoleSpend — the worker/conductor/auxiliary split', () => {
  it('splits the swarm three ways', () => {
    const split = selectRoleSpend(swarm)
    expect(split.worker.tokens.total).toBe(417_209)
    expect(split.conductor.tokens.total).toBe(766_720)
    expect(split.auxiliary.tokens.total).toBe(350)
    expect(split.worker.lanes).toEqual(['2-core', '3-git', '7-web'])
    expect(split.conductor.lanes).toEqual(['conductor'])
    expect(split.auxiliary.lanes).toEqual(['2-core'])
  })

  it('adds up to the session total', () => {
    const split = selectRoleSpend(swarm)
    const total = split.worker.tokens.total + split.conductor.tokens.total + split.auxiliary.tokens.total
    expect(total).toBe(selectSessionSpend(swarm).tokens.total)
    const cost = split.worker.costUsd + split.conductor.costUsd + split.auxiliary.costUsd
    expect(cost).toBeCloseTo(selectSessionSpend(swarm).costUsd, 6)
  })

  it('always returns all three roles, zeroed when unseen', () => {
    const split = selectRoleSpend(initialSessionState())
    for (const role of ['worker', 'conductor', 'auxiliary'] as const) {
      expect(split[role].role, role).toBe(role)
      expect(split[role].tokens.total, role).toBe(0)
      expect(split[role].lanes, role).toEqual([])
    }
  })

  it('attributes a tool call to a role only when the collector named one', () => {
    const state = fold(
      f.toolActivity({ lane: 'a', tool: 'Bash', role: 'conductor' }),
      f.toolActivity({ lane: 'a', tool: 'Bash', role: null }),
    )
    expect(selectRoleSpend(state).conductor.toolCallCount).toBe(1)
    // The unattributed call is still a fact about the session.
    expect(selectSessionSpend(state).toolCallCount).toBe(2)
  })
})

describe('the overhead ratio', () => {
  const ratioOf = (workerTokens: number, conductorTokens: number): number | null =>
    selectOverheadRatio(
      fold(
        f.llmUsage({ lane: 'w', role: 'worker', tokens: tokens(0, workerTokens) }),
        f.llmUsage({ lane: 'c', role: 'conductor', tokens: tokens(0, conductorTokens) }),
      ),
    )

  it('is conductor tokens divided by worker tokens', () => {
    expect(ratioOf(1_000, 500)).toBeCloseTo(0.5, 10)
    expect(ratioOf(500, 1_000)).toBeCloseTo(2, 10)
    expect(ratioOf(1_000, 1_000)).toBe(1)
  })

  it('reads the fixture swarm as a conductor costing more than all three workers', () => {
    const ratio = selectOverheadRatio(swarm)
    expect(ratio).toBeCloseTo(766_720 / 417_209, 10)
    expect(ratio).toBeGreaterThan(1)
    expect(selectRoleSpend(swarm).overheadRatio).toBe(ratio)
  })

  it('is null when there are no workers — never Infinity', () => {
    const state = fold(f.llmUsage({ lane: 'c', role: 'conductor', tokens: tokens(0, 900) }))
    const split = selectRoleSpend(state)
    expect(split.overheadRatio).toBeNull()
    // The raw sides stay readable so a caller can explain the null.
    expect(split.conductor.tokens.total).toBe(900)
    expect(split.worker.tokens.total).toBe(0)
  })

  it('is null when no conductor is instrumented — reporting 0.0 would undercount', () => {
    const state = fold(f.llmUsage({ lane: 'w', role: 'worker', tokens: tokens(0, 900) }))
    const split = selectRoleSpend(state)
    expect(split.overheadRatio).toBeNull()
    expect(split.worker.tokens.total).toBe(900)
    expect(split.conductor.tokens.total).toBe(0)
  })

  it('is null when both sides are zero, and for an empty session', () => {
    expect(ratioOf(0, 0)).toBeNull()
    expect(selectOverheadRatio(initialSessionState())).toBeNull()
    expect(selectOverheadRatio(reduceAll(fixtureSession()))).toBeNull()
  })

  it('is null when only auxiliary traffic exists', () => {
    const state = fold(f.llmUsage({ lane: 'a', role: 'auxiliary', tokens: tokens(5, 5) }))
    expect(selectOverheadRatio(state)).toBeNull()
  })

  it('ignores auxiliary tokens on both sides of the division', () => {
    const state = fold(
      f.llmUsage({ lane: 'w', role: 'worker', tokens: tokens(0, 1_000) }),
      f.llmUsage({ lane: 'c', role: 'conductor', tokens: tokens(0, 500) }),
      f.llmUsage({ lane: 'w', role: 'auxiliary', tokens: tokens(0, 9_999) }),
    )
    expect(selectOverheadRatio(state)).toBeCloseTo(0.5, 10)
  })

  it('is unmoved by dollars and tool calls — it is a token ratio', () => {
    const state = fold(
      f.llmUsage({ lane: 'w', role: 'worker', tokens: tokens(0, 1_000) }),
      f.llmUsage({ lane: 'c', role: 'conductor', tokens: tokens(0, 500) }),
      f.llmCost({ lane: 'c', role: 'conductor', costUsd: 99, authoritative: true }),
      f.toolActivity({ lane: 'c', tool: 'Bash', role: 'conductor' }),
    )
    expect(selectOverheadRatio(state)).toBeCloseTo(0.5, 10)
  })

  it('respects the same filters as everything else', () => {
    const state = fold(
      f.llmUsage({ lane: 'w', role: 'worker', tokens: tokens(0, 100) }, { ts: 1_000 }),
      f.llmUsage({ lane: 'c', role: 'conductor', tokens: tokens(0, 400) }, { ts: 2_000 }),
      f.llmUsage({ lane: 'c', role: 'conductor', tokens: tokens(0, 400) }, { ts: 9_000 }),
    )
    expect(selectOverheadRatio(state)).toBeCloseTo(8, 10)
    expect(selectOverheadRatio(state, { until: 2_000 })).toBeCloseTo(4, 10)
    // A window that keeps the conductor but loses the worker cannot divide.
    expect(selectOverheadRatio(state, { since: 2_000 })).toBeNull()
  })

  it('counts a lane by the role of each request, not by its name', () => {
    // One lane, both hats: the conductor lane also did worker-role work.
    const state = fold(
      f.llmUsage({ lane: 'both', role: 'worker', tokens: tokens(0, 200) }),
      f.llmUsage({ lane: 'both', role: 'conductor', tokens: tokens(0, 100) }),
    )
    expect(selectOverheadRatio(state)).toBeCloseTo(0.5, 10)
    expect(selectRoleSpend(state).worker.lanes).toEqual(['both'])
    expect(selectRoleSpend(state).conductor.lanes).toEqual(['both'])
  })
})

describe('selectSpendRate', () => {
  it('defaults to a five-minute window', () => {
    const rate = selectSpendRate(swarm, { now: FIXTURE_NOW })
    expect(rate.windowMs).toBe(DEFAULT_SPEND_WINDOW_MS)
    expect(rate.windowStart).toBe(FIXTURE_NOW - DEFAULT_SPEND_WINDOW_MS)
    expect(rate.windowEnd).toBe(FIXTURE_NOW)
  })

  it('measures the trailing window of the fixture swarm', () => {
    const rate = selectSpendRate(swarm, { now: FIXTURE_NOW })
    // t+5m and t+6m land inside [t+5m, t+10m]; t+1m and t+3m do not.
    expect(rate.totals.requestCount).toBe(2)
    expect(rate.totals.tokens.total).toBe(101_702 + 341_308)
    expect(rate.totals.costUsd).toBeCloseTo(1.02, 6)
    expect(rate.costUsdPerHour).toBeCloseTo(12.24, 6)
    expect(rate.tokensPerMinute).toBeCloseTo(443_010 / 5, 6)
    expect(rate.requestsPerMinute).toBeCloseTo(0.4, 10)
  })

  it('takes the window width as a parameter', () => {
    const wide = selectSpendRate(swarm, { now: FIXTURE_NOW, windowMs: 20 * minute })
    expect(wide.totals.tokens.total).toBe(1_184_279)
    expect(wide.costUsdPerHour).toBeCloseTo(2.620591 * 3, 6)

    const narrow = selectSpendRate(swarm, { now: FIXTURE_NOW, windowMs: minute })
    expect(narrow.totals.tokens.total).toBe(0)
    expect(narrow.costUsdPerHour).toBe(0)
  })

  it('never borrows from the future — replay sees the rate that moment had', () => {
    // Everything from t+1m is in; the t+3m auxiliary call and later are not.
    const midway = selectSpendRate(swarm, { now: T + 2 * minute, windowMs: 20 * minute })
    expect(midway.totals.requestCount).toBe(3)
    expect(midway.totals.costUsd).toBeCloseTo(0.42 + 0.28 + 0.9, 6)
    expect(midway.totals.lastTs).toBe(T + minute + 8_000)
    expect(selectOverheadRatio(swarm, { until: T + 2 * minute })).toBeCloseTo(
      425_412 / (189_504 + 126_003),
      10,
    )
  })

  it('includes both window edges', () => {
    const state = fold(
      f.llmUsage({ lane: 'a', tokens: tokens(0, 1) }, { ts: 1_000 }),
      f.llmUsage({ lane: 'a', tokens: tokens(0, 2) }, { ts: 2_000 }),
      f.llmUsage({ lane: 'a', tokens: tokens(0, 4) }, { ts: 3_000 }),
      f.llmUsage({ lane: 'a', tokens: tokens(0, 8) }, { ts: 4_000 }),
    )
    const rate = selectSpendRate(state, { now: 3_000, windowMs: 2_000 })
    expect(rate.totals.tokens.total).toBe(1 + 2 + 4)
  })

  it('has totals but no rate for a zero-width window', () => {
    const state = fold(f.llmCost({ lane: 'a', costUsd: 5, authoritative: true }, { ts: 1_000 }))
    const rate = selectSpendRate(state, { now: 1_000, windowMs: 0 })
    expect(rate.windowMs).toBe(0)
    expect(rate.totals.costUsd).toBe(5)
    expect(rate.costUsdPerHour).toBe(0)
    expect(rate.tokensPerMinute).toBe(0)
    expect(rate.requestsPerMinute).toBe(0)
  })

  it('clamps a negative window rather than reaching forwards', () => {
    const state = fold(f.llmCost({ lane: 'a', costUsd: 5, authoritative: true }, { ts: 1_000 }))
    const rate = selectSpendRate(state, { now: 1_000, windowMs: -60_000 })
    expect(rate.windowMs).toBe(0)
    expect(rate.windowStart).toBe(1_000)
    expect(rate.costUsdPerHour).toBe(0)
  })

  it('is all zeroes for an empty session', () => {
    const rate = selectSpendRate(initialSessionState(), { now: FIXTURE_NOW })
    expect(rate.totals.costUsd).toBe(0)
    expect(rate.costUsdPerHour).toBe(0)
    expect(rate.totals.costIsAuthoritative).toBeNull()
  })

  it('passes its origin and cost filters through to the window', () => {
    const rate = selectSpendRate(swarm, {
      now: FIXTURE_NOW,
      windowMs: 20 * minute,
      costs: 'authoritative',
    })
    expect(rate.totals.costUsd).toBeCloseTo(2.310591, 6)
    expect(rate.totals.costIsAuthoritative).toBe(true)
  })
})

describe('selectSpendRateByLane', () => {
  it('gives every known lane its own window, even an idle one', () => {
    const rates = selectSpendRateByLane(swarm, { now: FIXTURE_NOW })
    expect(Object.keys(rates).sort()).toEqual(['2-core', '3-git', '7-web', 'conductor'])
    expect(rates.conductor?.totals.tokens.total).toBe(341_308)
    expect(rates['7-web']?.totals.tokens.total).toBe(101_702)
    // 2-core and 3-git stopped spending before the window opened.
    expect(rates['2-core']?.totals.tokens.total).toBe(0)
    expect(rates['3-git']?.costUsdPerHour).toBe(0)
  })

  it('agrees with the session rate when summed', () => {
    const rates = selectSpendRateByLane(swarm, { now: FIXTURE_NOW })
    const summed = Object.values(rates).reduce((sum, rate) => sum + rate.totals.costUsd, 0)
    expect(summed).toBeCloseTo(selectSpendRate(swarm, { now: FIXTURE_NOW }).totals.costUsd, 6)
  })

  it('shares the window bounds with the session rate', () => {
    const options = { now: FIXTURE_NOW, windowMs: 3 * minute }
    const session = selectSpendRate(swarm, options)
    for (const rate of Object.values(selectSpendRateByLane(swarm, options))) {
      expect(rate.windowMs).toBe(session.windowMs)
      expect(rate.windowStart).toBe(session.windowStart)
      expect(rate.windowEnd).toBe(session.windowEnd)
    }
  })
})

describe('tool activity', () => {
  it('ranks tools by call count, ties by name', () => {
    const state = fold(
      f.toolActivity({ lane: 'a', tool: 'Bash' }),
      f.toolActivity({ lane: 'b', tool: 'Bash' }),
      f.toolActivity({ lane: 'a', tool: 'Bash' }),
      f.toolActivity({ lane: 'a', tool: 'Write' }),
      f.toolActivity({ lane: 'a', tool: 'Edit' }),
    )
    expect(selectToolUsage(state)).toEqual([
      { tool: 'Bash', count: 3, lanes: ['a', 'b'] },
      { tool: 'Edit', count: 1, lanes: ['a'] },
      { tool: 'Write', count: 1, lanes: ['a'] },
    ])
  })

  it('reads the fixture swarm the way the session logs did', () => {
    expect(selectToolUsage(swarm)).toEqual([
      { tool: 'Bash', count: 2, lanes: ['2-core', '3-git'] },
      { tool: 'Edit', count: 1, lanes: ['7-web'] },
      { tool: 'Write', count: 1, lanes: ['2-core'] },
    ])
  })

  it('respects the window filter', () => {
    expect(selectToolUsage(swarm, { since: T + 4 * minute })).toEqual([
      { tool: 'Edit', count: 1, lanes: ['7-web'] },
    ])
    expect(selectToolUsage(initialSessionState())).toEqual([])
  })

  it('returns recent calls newest first, capped by the limit', () => {
    expect(selectRecentToolActivity(swarm).map((record) => record.tool)).toEqual([
      'Edit',
      'Bash',
      'Bash',
      'Write',
    ])
    expect(selectRecentToolActivity(swarm, 2).map((record) => record.tool)).toEqual(['Edit', 'Bash'])
    expect(selectRecentToolActivity(swarm, 0)).toEqual([])
    expect(selectRecentToolActivity(swarm, -5)).toEqual([])
  })
})

describe('the package barrel', () => {
  it('exports everything the prd1 collectors and panels build against', () => {
    for (const name of [
      // schema
      'agentRoleSchema',
      'telemetryOriginSchema',
      'tokenUsageSchema',
      'llmUsagePayloadSchema',
      'llmCostPayloadSchema',
      'toolActivityPayloadSchema',
      'AGENT_ROLES',
      'UNATTRIBUTED_LANE',
      'ZERO_TOKENS',
      'totalTokens',
      'addTokens',
      // state
      'initialTelemetryState',
      // selectors
      'selectSessionSpend',
      'selectLaneSpend',
      'selectLaneSpendIndex',
      'selectSpendForLane',
      'selectSpendByWorktree',
      'selectSpendByBranch',
      'selectSpendByBranchIndex',
      'selectSpendForBranch',
      'selectModelSpend',
      'selectRoleSpend',
      'selectOverheadRatio',
      'selectSpendRate',
      'selectSpendRateByLane',
      'selectToolUsage',
      'selectRecentToolActivity',
      'selectTelemetryOrigins',
      'DEFAULT_SPEND_WINDOW_MS',
      // fixtures
      'fixtureTelemetrySession',
    ] as const) {
      expect(core[name], `@observatory/core should export ${name}`).toBeDefined()
    }
  })
})

describe('selectTelemetryOrigins', () => {
  it('names the collectors that have actually reported', () => {
    expect(selectTelemetryOrigins(initialSessionState())).toEqual([])
    expect(selectTelemetryOrigins(reduceAll(fixtureSession()))).toEqual([])
    expect(selectTelemetryOrigins(swarm)).toEqual(['otel', 'sessionlog'])
    expect(selectTelemetryOrigins(fold(f.llmUsage({ lane: 'a' })))).toEqual(['sessionlog'])
    expect(selectTelemetryOrigins(fold(f.llmCost({ lane: 'a' })))).toEqual(['otel'])
  })
})
