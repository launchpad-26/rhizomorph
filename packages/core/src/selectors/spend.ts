import type { AgentRole, TelemetryOrigin, TokenUsagePayload } from '../events/index.js'
import { AGENT_ROLES, ZERO_TOKENS, addTokens, totalTokens } from '../events/index.js'
import type { CostRecord, SessionState, ToolActivityRecord, UsageRecord } from '../state.js'
import { compareStrings } from './touches.js'

/**
 * prd1's money layer, derived. The reducer records requests, dollars and tool
 * calls whole; every total, rate, split and ratio is computed here, so the live
 * ticker and a replay scrubbed to the same moment cannot disagree.
 *
 * Two honesty rules run through the whole file:
 *
 * 1. **Dollars are never invented.** `costUsd` counts only what a `llm.cost`
 *    event carried, and `costIsAuthoritative` says whether the agent CLI
 *    computed it (OTel) or we estimated it. A session with tokens and no cost
 *    events reports `costUsd: 0` with `costIsAuthoritative: null` — "we do not
 *    know", not "it was free".
 * 2. **Nothing is silently deduplicated.** When both collectors are live they
 *    can report the same request twice, once each. That is a real fact about the
 *    log, not a bug to paper over here, so every selector takes an `origins`
 *    filter and the caller picks a token authority (`origins: ['sessionlog']`
 *    is the usual answer, since it is the one with cache-tier detail).
 */

/** The four cache tiers plus the one number everything sorts by. */
export interface TokenTotals extends TokenUsagePayload {
  total: number
}

/** Which dollars to count. Estimates and authoritative numbers never mix silently. */
export type CostAuthority = 'all' | 'authoritative' | 'estimated'

export interface SpendFilter {
  /** Collectors to count. Defaults to all of them — see the dedup note above. */
  origins?: readonly TelemetryOrigin[]
  /** Defaults to `'all'`; the split stays readable either way. */
  costs?: CostAuthority
  /** Inclusive lower bound on record ts. */
  since?: number
  /** Inclusive upper bound on record ts. Replay's "as of now". */
  until?: number
}

export interface SpendTotals {
  tokens: TokenTotals
  /** Authoritative and estimated dollars together, as filtered. */
  costUsd: number
  authoritativeCostUsd: number
  estimatedCostUsd: number
  /**
   * True when every dollar counted came from the agent CLI itself, false when
   * any of it is our estimate, and null when no dollars were counted at all.
   * The null case is the one the UI must not render as `$0.00`.
   */
  costIsAuthoritative: boolean | null
  /** `llm.usage` events counted — one per model request. */
  requestCount: number
  costEventCount: number
  /** How many of those were our estimate rather than the CLI's own number. */
  estimatedCostEventCount: number
  toolCallCount: number
  /** Distinct models, alphabetical. */
  models: string[]
  /** Distinct roles seen, in `worker, conductor, auxiliary, unattributed` order. */
  roles: AgentRole[]
  /** Distinct collectors that contributed, alphabetical. */
  origins: TelemetryOrigin[]
  /** Span of the records counted; null when nothing was. */
  firstTs: number | null
  lastTs: number | null
}

export interface LaneSpend extends SpendTotals {
  lane: string
  worktreePath: string | null
  branch: string | null
  sessionIds: string[]
  /** Tool name to call count, for this lane. */
  toolCounts: Record<string, number>
}

export interface ModelSpend extends SpendTotals {
  model: string
  /** Lanes that used this model, alphabetical. */
  lanes: string[]
}

export interface WorktreeSpend extends SpendTotals {
  worktreePath: string
  lanes: string[]
}

export interface BranchSpend extends SpendTotals {
  branch: string
  /** Leading digits of the branch name, e.g. `'48'` for `48-branch-ledger`. Null when it has none. */
  issue: string | null
  /** Lanes (telemetry identities) that have reported spend against this branch. */
  lanes: string[]
  /** Last worktree path git ever associated with this branch — stays populated once the worktree is gone. */
  worktreePath: string | null
  /** True once the worktree that carried this branch has seen `worktree.removed`. */
  landed: boolean
  /** `lastTs - firstTs`; null until at least one record has arrived. */
  elapsedMs: number | null
}

export interface RoleSpend extends SpendTotals {
  role: AgentRole
  lanes: string[]
}

export interface LaneRoleSpend extends SpendTotals {
  lane: string
  role: AgentRole
}

// --- session totals ---------------------------------------------------------

export function selectSessionSpend(state: SessionState, filter: SpendFilter = {}): SpendTotals {
  const acc = createAcc()
  for (const record of usageIn(state, filter)) addUsage(acc, record)
  for (const record of costsIn(state, filter)) addCost(acc, record)
  for (const record of toolsIn(state, filter)) addTool(acc, record)
  return finalise(acc)
}

// --- per lane ---------------------------------------------------------------

/**
 * One row per lane the log has ever mentioned, dearest first. Lanes with no
 * spend inside the filter still appear, zeroed: a cost column that hides an
 * idle lane is indistinguishable from one whose telemetry never arrived.
 */
export function selectLaneSpend(state: SessionState, filter: SpendFilter = {}): LaneSpend[] {
  const accs = new Map<string, Acc>()
  const tools = new Map<string, Record<string, number>>()

  const laneAcc = (lane: string): Acc => {
    const existing = accs.get(lane)
    if (existing !== undefined) return existing
    const fresh = createAcc()
    accs.set(lane, fresh)
    return fresh
  }

  for (const lane of Object.keys(state.telemetry.lanes)) laneAcc(lane)
  for (const record of usageIn(state, filter)) addUsage(laneAcc(record.lane), record)
  for (const record of costsIn(state, filter)) addCost(laneAcc(record.lane), record)
  for (const record of toolsIn(state, filter)) {
    addTool(laneAcc(record.lane), record)
    const counts = tools.get(record.lane) ?? {}
    counts[record.tool] = (counts[record.tool] ?? 0) + 1
    tools.set(record.lane, counts)
  }

  return [...accs.entries()]
    .map(([lane, acc]) => {
      const attribution = state.telemetry.lanes[lane]
      return {
        ...finalise(acc),
        lane,
        worktreePath: attribution?.worktreePath ?? null,
        branch: attribution?.branch ?? null,
        sessionIds: attribution?.sessionIds ?? [],
        toolCounts: tools.get(lane) ?? {},
      }
    })
    .sort(bySpend((entry) => entry.lane))
}

export function selectLaneSpendIndex(
  state: SessionState,
  filter: SpendFilter = {},
): Record<string, LaneSpend> {
  const index: Record<string, LaneSpend> = {}
  for (const entry of selectLaneSpend(state, filter)) index[entry.lane] = entry
  return index
}

/** Null for a lane the log has never mentioned — which is not the same as zero. */
export function selectSpendForLane(
  state: SessionState,
  lane: string,
  filter: SpendFilter = {},
): LaneSpend | null {
  return selectLaneSpendIndex(state, filter)[lane] ?? null
}

/**
 * One row per (lane, role) pair the filtered window actually saw — "conductor
 * spend within lane X" as a direct lookup instead of an unaskable question
 * (audit §C). A lane that only ever spoke as one role has exactly one row;
 * the "both hats" lane from {@link selectRoleSpend}'s tests gets two. Unlike
 * {@link selectLaneSpend}, rows are not seeded from every known lane — a
 * (lane, role) pair the log never mentioned inside the filter has nothing
 * honest to zero, so it is simply absent rather than a wall of empty rows for
 * combinations that never occurred.
 */
export function selectSpendByLaneRole(
  state: SessionState,
  filter: SpendFilter = {},
): LaneRoleSpend[] {
  const keyOf = (lane: string, role: AgentRole): string => `${lane}::${role}`
  const accs = new Map<string, Acc>()
  const keys = new Map<string, { lane: string; role: AgentRole }>()

  const laneRoleAcc = (lane: string, role: AgentRole): Acc => {
    const key = keyOf(lane, role)
    const existing = accs.get(key)
    if (existing !== undefined) return existing
    const fresh = createAcc()
    accs.set(key, fresh)
    keys.set(key, { lane, role })
    return fresh
  }

  for (const record of usageIn(state, filter)) {
    addUsage(laneRoleAcc(record.lane, record.role), record)
  }
  for (const record of costsIn(state, filter)) {
    addCost(laneRoleAcc(record.lane, record.role), record)
  }
  for (const record of toolsIn(state, filter)) {
    // Same rule as selectRoleSpend: an unattributed-role tool call is a
    // session fact, not a (lane, role) fact.
    if (record.role === null) continue
    addTool(laneRoleAcc(record.lane, record.role), record)
  }

  return [...accs.entries()]
    .map(([key, acc]) => ({ ...finalise(acc), ...keys.get(key)! }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        b.tokens.total - a.tokens.total ||
        compareStrings(a.lane, b.lane) ||
        compareStrings(a.role, b.role),
    )
}

/**
 * Lane spend rolled up by worktree — the worktree table's cost column. Lanes we
 * could not attribute to a path (OTel with no `lane=` resource attribute, and
 * the conductor, which lives outside every worktree) are absent by construction;
 * `selectLaneSpend` is where their dollars stay visible.
 */
export function selectSpendByWorktree(
  state: SessionState,
  filter: SpendFilter = {},
): Record<string, WorktreeSpend> {
  const grouped = new Map<string, LaneSpend[]>()
  for (const lane of selectLaneSpend(state, filter)) {
    if (lane.worktreePath === null) continue
    grouped.set(lane.worktreePath, [...(grouped.get(lane.worktreePath) ?? []), lane])
  }

  const result: Record<string, WorktreeSpend> = {}
  for (const [worktreePath, lanes] of grouped) {
    result[worktreePath] = {
      ...mergeTotals(lanes),
      worktreePath,
      lanes: lanes.map((lane) => lane.lane).sort(compareStrings),
    }
  }
  return result
}

// --- per branch --------------------------------------------------------------

/**
 * One row per branch this session has ever seen spend against, dearest first.
 * `workmux merge` deletes the worktree and the branch stops resolving to a
 * live lane, but the branch itself is the durable identity — every event still
 * carries it — so this survives exactly what {@link selectSpendByWorktree}
 * cannot: a finished feature whose worktree is gone still reports its full
 * cost. `landed` is read straight off the existing worktree/branch events
 * (see {@link isBranchLanded}), never a new liveness source, and `issue`
 * exposes the fenced-issue number when the branch name carries one.
 */
export function selectSpendByBranch(state: SessionState, filter: SpendFilter = {}): BranchSpend[] {
  const accs = new Map<string, Acc>()
  const lanes = new Map<string, Set<string>>()

  const branchAcc = (branch: string): Acc => {
    const existing = accs.get(branch)
    if (existing !== undefined) return existing
    const fresh = createAcc()
    accs.set(branch, fresh)
    return fresh
  }

  const track = (branch: string, lane: string): void => {
    lanes.set(branch, (lanes.get(branch) ?? new Set()).add(lane))
  }

  // A branch's identity outlives any window filter: git ever having mentioned
  // it, or telemetry ever having mentioned it — the window below only decides
  // which of its spend counts, not whether the row exists at all. Same rule
  // `selectLaneSpend` applies via `state.telemetry.lanes`.
  for (const branch of Object.keys(state.branches)) branchAcc(branch)
  for (const record of state.telemetry.usage) if (record.branch !== null) branchAcc(record.branch)
  for (const record of state.telemetry.costs) if (record.branch !== null) branchAcc(record.branch)
  for (const record of state.telemetry.tools) if (record.branch !== null) branchAcc(record.branch)

  for (const record of usageIn(state, filter)) {
    if (record.branch === null) continue
    addUsage(branchAcc(record.branch), record)
    track(record.branch, record.lane)
  }
  for (const record of costsIn(state, filter)) {
    if (record.branch === null) continue
    addCost(branchAcc(record.branch), record)
    track(record.branch, record.lane)
  }
  for (const record of toolsIn(state, filter)) {
    if (record.branch === null) continue
    addTool(branchAcc(record.branch), record)
    track(record.branch, record.lane)
  }

  return [...accs.entries()]
    .map(([branch, acc]) => {
      const totals = finalise(acc)
      return {
        ...totals,
        branch,
        issue: issueOf(branch),
        lanes: [...(lanes.get(branch) ?? [])].sort(compareStrings),
        worktreePath: state.branches[branch]?.worktreePath ?? null,
        landed: isBranchLanded(state, branch),
        elapsedMs:
          totals.firstTs === null || totals.lastTs === null ? null : totals.lastTs - totals.firstTs,
      }
    })
    .sort(bySpend((entry) => entry.branch))
}

export function selectSpendByBranchIndex(
  state: SessionState,
  filter: SpendFilter = {},
): Record<string, BranchSpend> {
  const index: Record<string, BranchSpend> = {}
  for (const entry of selectSpendByBranch(state, filter)) index[entry.branch] = entry
  return index
}

/** Null for a branch the log has never mentioned — which is not the same as zero. */
export function selectSpendForBranch(
  state: SessionState,
  branch: string,
  filter: SpendFilter = {},
): BranchSpend | null {
  return selectSpendByBranchIndex(state, filter)[branch] ?? null
}

/**
 * `true` once the worktree that last carried this branch has recorded
 * `worktree.removed` — `workmux merge`'s signature. `BranchState.worktreePath`
 * is never cleared when its worktree goes (the reducer's `worktreeRemoved`
 * never touches `state.branches`), so the stale path is exactly what lets a
 * landed branch keep resolving to the worktree whose `present` flag now says
 * it's gone. A branch git has never associated with a worktree reports
 * `false` — no evidence of removal is not evidence of landing.
 */
function isBranchLanded(state: SessionState, branch: string): boolean {
  const worktreePath = state.branches[branch]?.worktreePath ?? null
  if (worktreePath === null) return false
  const worktree = state.worktrees[worktreePath]
  return worktree !== undefined && !worktree.present
}

/** The fenced-issue convention's number, e.g. `'34'` for `34-sessionlog-collector`. */
function issueOf(branch: string): string | null {
  return /^\d+/.exec(branch)?.[0] ?? null
}

// --- per model --------------------------------------------------------------

/** Dearest model first. Model badges and the per-model bars read this. */
export function selectModelSpend(state: SessionState, filter: SpendFilter = {}): ModelSpend[] {
  const accs = new Map<string, Acc>()
  const lanes = new Map<string, Set<string>>()

  const modelAcc = (model: string, lane: string): Acc => {
    lanes.set(model, (lanes.get(model) ?? new Set()).add(lane))
    const existing = accs.get(model)
    if (existing !== undefined) return existing
    const fresh = createAcc()
    accs.set(model, fresh)
    return fresh
  }

  for (const record of usageIn(state, filter)) addUsage(modelAcc(record.model, record.lane), record)
  for (const record of costsIn(state, filter)) addCost(modelAcc(record.model, record.lane), record)

  return [...accs.entries()]
    .map(([model, acc]) => ({
      ...finalise(acc),
      model,
      lanes: [...(lanes.get(model) ?? [])].sort(compareStrings),
    }))
    .sort(bySpend((entry) => entry.model))
}

// --- the role split, and the headline ratio ---------------------------------

export interface RoleSpendSplit {
  worker: RoleSpend
  conductor: RoleSpend
  auxiliary: RoleSpend
  /**
   * Spend whose source declared no role at all (prd2's `unattributed`, see
   * `events/telemetry.ts`). A first-class bucket alongside the other three,
   * not folded into `worker` — an undeclared session is a setup gap with a
   * number, never a silent worker credit.
   */
  unattributed: RoleSpend
  /**
   * Conductor tokens divided by worker tokens — the empirical price of the
   * brain/hands split, and prd1's headline metric.
   *
   * Null unless *both* sides reported tokens. That is deliberate, not just
   * divide-by-zero defence: with no conductor telemetry the honest answer is
   * "unknown", and rendering the 0.0 that arithmetic would give is precisely
   * the undercount prd1 exists to expose. The two token totals sit alongside
   * so a caller can tell "no conductor instrumented" from "conductor idle".
   *
   * `unattributed` sits in neither side of this division. An undeclared
   * session is a setup gap, not evidence about the brain/hands ratio — letting
   * it inflate either side would misprice the split it is supposed to explain.
   */
  overheadRatio: number | null
}

export function selectRoleSpend(state: SessionState, filter: SpendFilter = {}): RoleSpendSplit {
  const accs = new Map<AgentRole, Acc>(AGENT_ROLES.map((role) => [role, createAcc()]))
  const lanes = new Map<AgentRole, Set<string>>(AGENT_ROLES.map((role) => [role, new Set()]))

  const track = (role: AgentRole, lane: string): Acc => {
    const seen = lanes.get(role) ?? new Set<string>()
    seen.add(lane)
    lanes.set(role, seen)
    const existing = accs.get(role)
    if (existing !== undefined) return existing
    const fresh = createAcc()
    accs.set(role, fresh)
    return fresh
  }

  for (const record of usageIn(state, filter)) addUsage(track(record.role, record.lane), record)
  for (const record of costsIn(state, filter)) addCost(track(record.role, record.lane), record)
  for (const record of toolsIn(state, filter)) {
    // A tool call with no reported role is counted in the session totals but
    // never attributed to a role it did not claim.
    if (record.role === null) continue
    addTool(track(record.role, record.lane), record)
  }

  const roleSpend = (role: AgentRole): RoleSpend => ({
    ...finalise(accs.get(role) ?? createAcc()),
    role,
    lanes: [...(lanes.get(role) ?? [])].sort(compareStrings),
  })

  const worker = roleSpend('worker')
  const conductor = roleSpend('conductor')

  return {
    worker,
    conductor,
    auxiliary: roleSpend('auxiliary'),
    unattributed: roleSpend('unattributed'),
    overheadRatio: overhead(conductor.tokens.total, worker.tokens.total),
  }
}

/** prd1's headline number on its own, for a ticker that wants nothing else. */
export function selectOverheadRatio(
  state: SessionState,
  filter: SpendFilter = {},
): number | null {
  return selectRoleSpend(state, filter).overheadRatio
}

/** Null unless both sides are non-zero. See {@link RoleSpendSplit.overheadRatio}. */
function overhead(conductorTokens: number, workerTokens: number): number | null {
  if (conductorTokens <= 0 || workerTokens <= 0) return null
  return conductorTokens / workerTokens
}

// --- spend rate over a rolling window ---------------------------------------

/** Five minutes: long enough to smooth a poll, short enough to feel live. */
export const DEFAULT_SPEND_WINDOW_MS = 5 * 60_000

export interface SpendRateOptions extends Omit<SpendFilter, 'since' | 'until'> {
  /** Epoch millis to measure against — injected, never read from the clock. */
  now: number
  /** Width of the rolling window. Defaults to {@link DEFAULT_SPEND_WINDOW_MS}. */
  windowMs?: number
}

export interface SpendRate {
  windowMs: number
  /** Inclusive bounds actually used: `[now - windowMs, now]`. */
  windowStart: number
  windowEnd: number
  totals: SpendTotals
  /** The ticker's $/hour, extrapolated from the window. */
  costUsdPerHour: number
  tokensPerMinute: number
  requestsPerMinute: number
}

/**
 * Burn rate over the trailing window. Records newer than `now` are excluded, so
 * a replay scrubbed to the middle of a session sees the rate that moment had —
 * never one borrowed from its future.
 */
export function selectSpendRate(state: SessionState, options: SpendRateOptions): SpendRate {
  const windowMs = Math.max(0, options.windowMs ?? DEFAULT_SPEND_WINDOW_MS)
  const windowStart = options.now - windowMs
  const totals = selectSessionSpend(state, {
    ...withoutWindow(options),
    since: windowStart,
    until: options.now,
  })
  return rateOf(totals, windowMs, windowStart, options.now)
}

/** Same window, one entry per known lane — the ticker's per-lane mini-bars. */
export function selectSpendRateByLane(
  state: SessionState,
  options: SpendRateOptions,
): Record<string, SpendRate> {
  const windowMs = Math.max(0, options.windowMs ?? DEFAULT_SPEND_WINDOW_MS)
  const windowStart = options.now - windowMs
  const lanes = selectLaneSpend(state, {
    ...withoutWindow(options),
    since: windowStart,
    until: options.now,
  })

  const result: Record<string, SpendRate> = {}
  for (const lane of lanes) {
    result[lane.lane] = rateOf(lane, windowMs, windowStart, options.now)
  }
  return result
}

function withoutWindow(options: SpendRateOptions): SpendFilter {
  return {
    ...(options.origins === undefined ? {} : { origins: options.origins }),
    ...(options.costs === undefined ? {} : { costs: options.costs }),
  }
}

function rateOf(
  totals: SpendTotals,
  windowMs: number,
  windowStart: number,
  windowEnd: number,
): SpendRate {
  // A zero-width window has totals but no rate; dividing would be a lie.
  const hours = windowMs / 3_600_000
  const minutes = windowMs / 60_000
  return {
    windowMs,
    windowStart,
    windowEnd,
    totals,
    costUsdPerHour: hours === 0 ? 0 : totals.costUsd / hours,
    tokensPerMinute: minutes === 0 ? 0 : totals.tokens.total / minutes,
    requestsPerMinute: minutes === 0 ? 0 : totals.requestCount / minutes,
  }
}

// --- tool activity ----------------------------------------------------------

export interface ToolUsage {
  tool: string
  count: number
  /** Lanes that called it, alphabetical. */
  lanes: string[]
}

/** Busiest tool first — what a lane's tokens were actually spent doing. */
export function selectToolUsage(state: SessionState, filter: SpendFilter = {}): ToolUsage[] {
  const counts = new Map<string, number>()
  const lanes = new Map<string, Set<string>>()

  for (const record of toolsIn(state, filter)) {
    counts.set(record.tool, (counts.get(record.tool) ?? 0) + 1)
    lanes.set(record.tool, (lanes.get(record.tool) ?? new Set()).add(record.lane))
  }

  return [...counts.entries()]
    .map(([tool, count]) => ({
      tool,
      count,
      lanes: [...(lanes.get(tool) ?? [])].sort(compareStrings),
    }))
    .sort((a, b) => b.count - a.count || compareStrings(a.tool, b.tool))
}

/**
 * Newest first, by observation rather than timestamp — the same rule the commit
 * ticker uses, so a batch of calls read back in a deterministic order.
 */
export function selectRecentToolActivity(
  state: SessionState,
  limit = 20,
  filter: SpendFilter = {},
): ToolActivityRecord[] {
  const records = toolsIn(state, filter)
  return records.slice(Math.max(0, records.length - Math.max(0, limit))).reverse()
}

/** Which collectors have actually reported anything — the honesty badge's input. */
export function selectTelemetryOrigins(state: SessionState): TelemetryOrigin[] {
  const origins = new Set<TelemetryOrigin>()
  for (const record of state.telemetry.usage) origins.add(record.origin)
  for (const record of state.telemetry.costs) origins.add(record.origin)
  for (const record of state.telemetry.tools) origins.add(record.origin)
  return [...origins].sort(compareStrings)
}

// --- accumulation -----------------------------------------------------------

interface Acc {
  tokens: TokenUsagePayload
  authoritativeCostUsd: number
  estimatedCostUsd: number
  requestCount: number
  costEventCount: number
  estimatedCostEventCount: number
  toolCallCount: number
  models: Set<string>
  roles: Set<AgentRole>
  origins: Set<TelemetryOrigin>
  firstTs: number | null
  lastTs: number | null
}

function createAcc(): Acc {
  return {
    tokens: ZERO_TOKENS,
    authoritativeCostUsd: 0,
    estimatedCostUsd: 0,
    requestCount: 0,
    costEventCount: 0,
    estimatedCostEventCount: 0,
    toolCallCount: 0,
    models: new Set(),
    roles: new Set(),
    origins: new Set(),
    firstTs: null,
    lastTs: null,
  }
}

function touch(acc: Acc, ts: number, origin: TelemetryOrigin): void {
  acc.origins.add(origin)
  acc.firstTs = acc.firstTs === null ? ts : Math.min(acc.firstTs, ts)
  acc.lastTs = acc.lastTs === null ? ts : Math.max(acc.lastTs, ts)
}

function addUsage(acc: Acc, record: UsageRecord): void {
  acc.tokens = addTokens(acc.tokens, record.tokens)
  acc.requestCount += 1
  acc.models.add(record.model)
  acc.roles.add(record.role)
  touch(acc, record.ts, record.origin)
}

function addCost(acc: Acc, record: CostRecord): void {
  if (record.authoritative) {
    acc.authoritativeCostUsd += record.costUsd
  } else {
    acc.estimatedCostUsd += record.costUsd
    acc.estimatedCostEventCount += 1
  }
  acc.costEventCount += 1
  acc.models.add(record.model)
  acc.roles.add(record.role)
  touch(acc, record.ts, record.origin)
}

function addTool(acc: Acc, record: ToolActivityRecord): void {
  acc.toolCallCount += 1
  if (record.role !== null) acc.roles.add(record.role)
  touch(acc, record.ts, record.origin)
}

function finalise(acc: Acc): SpendTotals {
  const costUsd = acc.authoritativeCostUsd + acc.estimatedCostUsd
  return {
    tokens: { ...acc.tokens, total: totalTokens(acc.tokens) },
    costUsd,
    authoritativeCostUsd: acc.authoritativeCostUsd,
    estimatedCostUsd: acc.estimatedCostUsd,
    // No cost events at all is "unknown", not "authoritatively free".
    costIsAuthoritative: acc.costEventCount === 0 ? null : acc.estimatedCostEventCount === 0,
    requestCount: acc.requestCount,
    costEventCount: acc.costEventCount,
    estimatedCostEventCount: acc.estimatedCostEventCount,
    toolCallCount: acc.toolCallCount,
    models: [...acc.models].sort(compareStrings),
    roles: AGENT_ROLES.filter((role) => acc.roles.has(role)),
    origins: [...acc.origins].sort(compareStrings),
    firstTs: acc.firstTs,
    lastTs: acc.lastTs,
  }
}

/** Adds already-finalised totals — used to roll lanes up into a worktree. */
function mergeTotals(entries: readonly SpendTotals[]): SpendTotals {
  const acc = createAcc()
  for (const entry of entries) {
    acc.tokens = addTokens(acc.tokens, entry.tokens)
    acc.authoritativeCostUsd += entry.authoritativeCostUsd
    acc.estimatedCostUsd += entry.estimatedCostUsd
    acc.requestCount += entry.requestCount
    acc.costEventCount += entry.costEventCount
    acc.estimatedCostEventCount += entry.estimatedCostEventCount
    acc.toolCallCount += entry.toolCallCount
    for (const model of entry.models) acc.models.add(model)
    for (const role of entry.roles) acc.roles.add(role)
    for (const origin of entry.origins) acc.origins.add(origin)
    if (entry.firstTs !== null) acc.firstTs = acc.firstTs === null ? entry.firstTs : Math.min(acc.firstTs, entry.firstTs)
    if (entry.lastTs !== null) acc.lastTs = acc.lastTs === null ? entry.lastTs : Math.max(acc.lastTs, entry.lastTs)
  }
  return finalise(acc)
}

// --- filtering --------------------------------------------------------------

function inWindow(ts: number, filter: SpendFilter): boolean {
  if (filter.since !== undefined && ts < filter.since) return false
  if (filter.until !== undefined && ts > filter.until) return false
  return true
}

function fromOrigin(origin: TelemetryOrigin, filter: SpendFilter): boolean {
  return filter.origins === undefined || filter.origins.includes(origin)
}

function usageIn(state: SessionState, filter: SpendFilter): UsageRecord[] {
  return state.telemetry.usage.filter(
    (record) => inWindow(record.ts, filter) && fromOrigin(record.origin, filter),
  )
}

function costsIn(state: SessionState, filter: SpendFilter): CostRecord[] {
  const authority = filter.costs ?? 'all'
  return state.telemetry.costs.filter(
    (record) =>
      inWindow(record.ts, filter) &&
      fromOrigin(record.origin, filter) &&
      (authority === 'all' ||
        (authority === 'authoritative' ? record.authoritative : !record.authoritative)),
  )
}

function toolsIn(state: SessionState, filter: SpendFilter): ToolActivityRecord[] {
  return state.telemetry.tools.filter(
    (record) => inWindow(record.ts, filter) && fromOrigin(record.origin, filter),
  )
}

/** Dearest first, then most tokens, then a stable name tiebreak. */
function bySpend<T extends SpendTotals>(name: (entry: T) => string) {
  return (a: T, b: T): number =>
    b.costUsd - a.costUsd || b.tokens.total - a.tokens.total || compareStrings(name(a), name(b))
}
