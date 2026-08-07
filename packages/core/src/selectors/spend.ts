import type { AgentRole, AgentThread, TelemetryOrigin, TokenUsagePayload } from '../events/index.js'
import { AGENT_ROLES, ZERO_TOKENS, addTokens, totalTokens } from '../events/index.js'
import type { CostRecord, SessionState, ToolActivityRecord, UsageRecord } from '../state.js'
import {
  type SpendCursor,
  type SpendGroupResult,
  type SpendGrouping,
  emptySpendTotals,
  fromOrigin,
  groupSpendBy,
  inWindow,
  spendCursor,
} from './spend-cursor.js'
import { compareStrings } from './touches.js'

/**
 * prd1's money layer, derived. The reducer records requests, dollars and tool
 * calls whole; every total, rate, split and ratio is computed here, so the live
 * ticker and a replay scrubbed to the same moment cannot disagree.
 *
 * Three honesty rules run through the whole file:
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
 * 3. **A lane with no cost telemetry at all gets a flagged estimate, never a
 *    silent gap.** prd9 ruling 7: when a lane has never reported a single
 *    `llm.cost` (authoritative or otherwise), its `llm.usage` tokens are
 *    priced on read from the vendored table (`../pricing`) — per usage
 *    record, so a model the table's patterns miss stays an honest gap even
 *    inside an otherwise-priced lane. The moment a lane reports even one real
 *    cost event, this file leaves it alone entirely — see
 *    {@link SpendTotals.estimateSources}.
 *
 * **Where the loops went (#267).** Six rollups here used to hand-roll the same
 * create-acc / loop-usage-costs-tools / finalise shape, and each call rescanned
 * the whole telemetry history — 214 ms of one 25,000-event `buildFleet`'s
 * 226 ms. They are now thin wrappers over one grouping, `groupSpendBy`, in
 * `./spend-cursor.js`, which also carries the incremental twin every selector
 * below has: `xSpendCursor(filter)` plus `spendFrom(cursor, state)` answers the
 * same question about a longer prefix for the cost of the records appended
 * since, instead of the whole history. The public selectors keep their exact
 * signatures and their exact cost; the cursor is additive, and a caller opts in.
 */

/**
 * The four cache tiers plus `total`, their all-tier sum. `total` stays for
 * callers that want the raw sum, but prd2's ruling is that no display ranks or
 * headlines by it: tiers differ in cost by up to ~50x (see
 * {@link RoleSpendSplit.overheadRatio}), so an unlabelled all-tier total is
 * not a unit anything should sort or lead with. {@link bySpend} and every
 * other tiebreak in this file rank by `output` instead.
 */
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
  /**
   * Which vendored pricing tables contributed a dollar to this total, e.g.
   * `['langfuse-prices@cfac485']` — empty whenever `estimatedCostUsd` is zero.
   * `estimatedCostUsd` is never a bare number: this is the "flagged" half of
   * prd9 ruling 7's estimate vocabulary at the selector level (the per-event
   * half is `CostRecord.estimateSource`). Optional only so a hand-built
   * `SpendTotals` literal predating this field (a formatter unit test, say)
   * still type-checks; every selector in this file always sets it.
   */
  estimateSources?: string[]
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

/**
 * One thread's slice of a lane. `thread: null` is the "the source didn't say"
 * bucket — present so the sub-totals still add up to the lane's own total, and
 * rendered as unknown rather than folded into `main`.
 */
export interface ThreadSpend extends SpendTotals {
  thread: AgentThread | null
}

export interface LaneSpend extends SpendTotals {
  lane: string
  worktreePath: string | null
  branch: string | null
  sessionIds: string[]
  /** Tool name to call count, for this lane. */
  toolCounts: Record<string, number>
  /**
   * Per-thread sub-totals — prd2's sub-rows under the parent lane, dearest
   * first. Empty when no record in this lane named a thread at all: an
   * un-parsed source has no sub-rows to show, which is not the same as one
   * sub-row of unknowns. When it is non-empty it partitions the lane, so
   * summing it reproduces the lane's own totals exactly.
   */
  threads: ThreadSpend[]
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

// --- the six groupings ------------------------------------------------------

/**
 * Every rollup below is one of these plus a `present` function. The three
 * telemetry record kinds share `lane`, `branch`, `model` and `thread`, so one
 * key function usually serves all three — which is the whole reason six
 * hand-rolled loops could collapse into six declarations.
 */
const laneOf = (record: { lane: string }): string => record.lane
const branchOf = (record: { branch: string | null }): string | null => record.branch
const modelOf = (record: { model: string }): string => record.model
const roleOf = (record: { role: AgentRole | null }): AgentRole | null => record.role

/** The whole session in one group. Seeded so an empty log still reports zeroes. */
const BY_SESSION: SpendGrouping = {
  keys: { usage: () => '', cost: () => '', tool: () => '' },
  seed: () => [''],
}

/**
 * One group per lane, seeded from every lane the log has ever mentioned: a cost
 * column that hides an idle lane is indistinguishable from one whose telemetry
 * never arrived.
 */
const BY_LANE: SpendGrouping = {
  keys: { usage: laneOf, cost: laneOf, tool: laneOf },
  seed: (state) => Object.keys(state.telemetry.lanes),
  toolCounts: true,
  threads: true,
}

/**
 * One group per branch. `presence` is the rule that makes a branch row exist
 * because git or telemetry ever mentioned the branch, while the filter still
 * decides which of its spend counts — evaluated on every record the pass walks,
 * before the window applies.
 */
const BY_BRANCH: SpendGrouping = {
  keys: { usage: branchOf, cost: branchOf, tool: branchOf },
  presence: { usage: branchOf, cost: branchOf, tool: branchOf },
  seed: (state) => Object.keys(state.branches),
  lanes: true,
}

/** One group per model. Tool calls carry no model, so they are skipped. */
const BY_MODEL: SpendGrouping = {
  keys: { usage: modelOf, cost: modelOf },
  lanes: true,
}

/**
 * One group per role, all four always present. A tool call whose collector
 * named no role returns `null` here and is skipped: it is counted in the
 * session totals but never attributed to a role it did not claim.
 */
const BY_ROLE: SpendGrouping = {
  keys: { usage: roleOf, cost: roleOf, tool: roleOf },
  seed: () => AGENT_ROLES,
  lanes: true,
}

/**
 * `role`, then the lane — a composite key split back apart in
 * {@link presentLaneRoleSpend}. `AgentRole` is a closed vocabulary with no
 * separator in it, so the role is always the part before the first separator
 * however exotic a lane handle gets.
 */
const LANE_ROLE_SEPARATOR = '\u0000'
const laneRoleKey = (role: AgentRole, lane: string): string =>
  `${role}${LANE_ROLE_SEPARATOR}${lane}`
const BY_LANE_ROLE: SpendGrouping = {
  keys: {
    usage: (record: UsageRecord) => laneRoleKey(record.role, record.lane),
    cost: (record: CostRecord) => laneRoleKey(record.role, record.lane),
    // Same rule as BY_ROLE: an unattributed-role tool call is a session fact,
    // not a (lane, role) fact.
    tool: (record: ToolActivityRecord) =>
      record.role === null ? null : laneRoleKey(record.role, record.lane),
  },
}

// --- session totals ---------------------------------------------------------

function presentSessionSpend(
  _state: SessionState,
  groups: readonly SpendGroupResult[],
): SpendTotals {
  return groups[0]?.totals ?? emptySpendTotals()
}

export function selectSessionSpend(state: SessionState, filter: SpendFilter = {}): SpendTotals {
  return presentSessionSpend(state, groupSpendBy(state, filter, BY_SESSION))
}

/** The session totals, incrementally — see {@link laneSpendCursor} for the seam. */
export function sessionSpendCursor(
  filter: SpendFilter = {},
  keyframeInterval?: number,
): SpendCursor<SpendTotals> {
  return spendCursor({ grouping: BY_SESSION, filter, present: presentSessionSpend, keyframeInterval })
}

// --- per lane ---------------------------------------------------------------

function presentLaneSpend(
  state: SessionState,
  groups: readonly SpendGroupResult[],
): LaneSpend[] {
  return groups
    .map((group) => {
      const attribution = state.telemetry.lanes[group.key]
      return {
        ...group.totals,
        lane: group.key,
        worktreePath: attribution?.worktreePath ?? null,
        branch: attribution?.branch ?? null,
        sessionIds: attribution?.sessionIds ?? [],
        toolCounts: group.toolCounts,
        threads: group.threads,
      }
    })
    .sort(bySpend((entry) => entry.lane))
}

/**
 * One row per lane the log has ever mentioned, dearest first. Lanes with no
 * spend inside the filter still appear, zeroed: a cost column that hides an
 * idle lane is indistinguishable from one whose telemetry never arrived.
 */
export function selectLaneSpend(state: SessionState, filter: SpendFilter = {}): LaneSpend[] {
  return presentLaneSpend(state, groupSpendBy(state, filter, BY_LANE))
}

/**
 * **The cursor seam (#267).** `selectLaneSpend`'s answer, incrementally:
 *
 * ```ts
 * const cursor = useRef(laneSpendCursor({ origins: TOKEN_ORIGINS }))
 * cursor.current = spendFrom(cursor.current, state)   // O(records appended)
 * const lanes = cursor.current.value                  // LaneSpend[], as before
 * ```
 *
 * The cursor is a value, not a cache: hold it in a ref, hand it the next
 * state — including the *fresh* state object every seek folds, which is why a
 * state-keyed memo cannot work here (prd21 ruling 1) — and read `.value`. It
 * tracks position in the telemetry slices' own append order (#205), checks the
 * record identities at that position rather than trusting them, and falls back
 * to a keyframe when a scrub goes backward. One cursor per (question, filter);
 * `buildFleet`'s two-pass token/cost split therefore wants two.
 */
export function laneSpendCursor(
  filter: SpendFilter = {},
  keyframeInterval?: number,
): SpendCursor<LaneSpend[]> {
  return spendCursor({ grouping: BY_LANE, filter, present: presentLaneSpend, keyframeInterval })
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

function presentLaneRoleSpend(
  _state: SessionState,
  groups: readonly SpendGroupResult[],
): LaneRoleSpend[] {
  const rows: LaneRoleSpend[] = []
  for (const group of groups) {
    const cut = group.key.indexOf(LANE_ROLE_SEPARATOR)
    const role = AGENT_ROLES.find((candidate) => candidate === group.key.slice(0, cut))
    // Unreachable: every key here was built from AGENT_ROLES by `laneRoleKey`.
    if (role === undefined) continue
    rows.push({ ...group.totals, lane: group.key.slice(cut + 1), role })
  }
  return rows.sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      b.tokens.output - a.tokens.output ||
      compareStrings(a.lane, b.lane) ||
      compareStrings(a.role, b.role),
  )
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
  return presentLaneRoleSpend(state, groupSpendBy(state, filter, BY_LANE_ROLE))
}

/** {@link selectSpendByLaneRole}'s answer, incrementally — see {@link laneSpendCursor}. */
export function laneRoleSpendCursor(
  filter: SpendFilter = {},
  keyframeInterval?: number,
): SpendCursor<LaneRoleSpend[]> {
  return spendCursor({ grouping: BY_LANE_ROLE, filter, present: presentLaneRoleSpend, keyframeInterval })
}

function presentWorktreeSpend(
  state: SessionState,
  groups: readonly SpendGroupResult[],
): Record<string, WorktreeSpend> {
  const grouped = new Map<string, LaneSpend[]>()
  for (const lane of presentLaneSpend(state, groups)) {
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

/**
 * Lane spend rolled up by worktree — the worktree table's cost column. Lanes we
 * could not attribute to a path (OTel with no `lane=` resource attribute, and
 * the conductor, which lives outside every worktree) are absent by construction;
 * `selectLaneSpend` is where their dollars stay visible.
 *
 * A rollup of {@link selectLaneSpend}'s rows rather than its own grouping, and
 * deliberately so: the worktree a lane belongs to is read from
 * `state.telemetry.lanes`, not off the records, so grouping by it per record
 * would bind a cursor to one snapshot of that attribution.
 */
export function selectSpendByWorktree(
  state: SessionState,
  filter: SpendFilter = {},
): Record<string, WorktreeSpend> {
  return presentWorktreeSpend(state, groupSpendBy(state, filter, BY_LANE))
}

/** {@link selectSpendByWorktree}'s answer, incrementally — see {@link laneSpendCursor}. */
export function worktreeSpendCursor(
  filter: SpendFilter = {},
  keyframeInterval?: number,
): SpendCursor<Record<string, WorktreeSpend>> {
  return spendCursor({ grouping: BY_LANE, filter, present: presentWorktreeSpend, keyframeInterval })
}

// --- per branch --------------------------------------------------------------

function presentBranchSpend(
  state: SessionState,
  groups: readonly SpendGroupResult[],
): BranchSpend[] {
  return groups
    .map((group) => {
      const totals = group.totals
      return {
        ...totals,
        branch: group.key,
        issue: issueOf(group.key),
        lanes: group.lanes,
        worktreePath: state.branches[group.key]?.worktreePath ?? null,
        landed: isBranchLanded(state, group.key),
        elapsedMs:
          totals.firstTs === null || totals.lastTs === null ? null : totals.lastTs - totals.firstTs,
      }
    })
    .sort(bySpend((entry) => entry.branch))
}

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
  return presentBranchSpend(state, groupSpendBy(state, filter, BY_BRANCH))
}

/** {@link selectSpendByBranch}'s answer, incrementally — see {@link laneSpendCursor}. */
export function branchSpendCursor(
  filter: SpendFilter = {},
  keyframeInterval?: number,
): SpendCursor<BranchSpend[]> {
  return spendCursor({ grouping: BY_BRANCH, filter, present: presentBranchSpend, keyframeInterval })
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

function presentModelSpend(
  _state: SessionState,
  groups: readonly SpendGroupResult[],
): ModelSpend[] {
  return groups
    .map((group) => ({ ...group.totals, model: group.key, lanes: group.lanes }))
    .sort(bySpend((entry) => entry.model))
}

/** Dearest model first. Model badges and the per-model bars read this. */
export function selectModelSpend(state: SessionState, filter: SpendFilter = {}): ModelSpend[] {
  return presentModelSpend(state, groupSpendBy(state, filter, BY_MODEL))
}

/** {@link selectModelSpend}'s answer, incrementally — see {@link laneSpendCursor}. */
export function modelSpendCursor(
  filter: SpendFilter = {},
  keyframeInterval?: number,
): SpendCursor<ModelSpend[]> {
  return spendCursor({ grouping: BY_MODEL, filter, present: presentModelSpend, keyframeInterval })
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
   * Conductor OUTPUT tokens divided by worker OUTPUT tokens — the empirical
   * price of the brain/hands split, and prd1's headline metric.
   *
   * **prd2 ruling, output basis, not `.total`:** a "token" is not one unit —
   * across current Claude models an output token costs roughly 5x an input
   * token, a cache read roughly 0.1x, a cache write roughly 1.25x. Summing all
   * four tiers before dividing let a polling conductor's cache-read traffic
   * (re-sending the same growing context every poll) inflate the ratio far
   * past what its actual work — output — cost. Output is what the model
   * produced, immune to that inflation, so it is the basis for this ratio.
   * This is a deliberate change from prd1's original total-token ratio.
   *
   * Null unless *both* sides reported output tokens. That is deliberate, not
   * just divide-by-zero defence: with no conductor telemetry the honest
   * answer is "unknown", and rendering the 0.0 that arithmetic would give is
   * precisely the undercount prd1 exists to expose. The two token totals sit
   * alongside (full tiers, not just output) so a caller can tell "no
   * conductor instrumented" from "conductor idle".
   *
   * `unattributed` sits in neither side of this division. An undeclared
   * session is a setup gap, not evidence about the brain/hands ratio — letting
   * it inflate either side would misprice the split it is supposed to explain.
   */
  overheadRatio: number | null
}

function presentRoleSpend(
  _state: SessionState,
  groups: readonly SpendGroupResult[],
): RoleSpendSplit {
  const roleSpend = (role: AgentRole): RoleSpend => {
    const group = groups.find((entry) => entry.key === role)
    return { ...(group?.totals ?? emptySpendTotals()), role, lanes: group?.lanes ?? [] }
  }

  const worker = roleSpend('worker')
  const conductor = roleSpend('conductor')

  return {
    worker,
    conductor,
    auxiliary: roleSpend('auxiliary'),
    unattributed: roleSpend('unattributed'),
    overheadRatio: overhead(conductor.tokens.output, worker.tokens.output),
  }
}

export function selectRoleSpend(state: SessionState, filter: SpendFilter = {}): RoleSpendSplit {
  return presentRoleSpend(state, groupSpendBy(state, filter, BY_ROLE))
}

/** {@link selectRoleSpend}'s answer, incrementally — see {@link laneSpendCursor}. */
export function roleSpendCursor(
  filter: SpendFilter = {},
  keyframeInterval?: number,
): SpendCursor<RoleSpendSplit> {
  return spendCursor({ grouping: BY_ROLE, filter, present: presentRoleSpend, keyframeInterval })
}

/** prd1's headline number on its own, for a ticker that wants nothing else. */
export function selectOverheadRatio(
  state: SessionState,
  filter: SpendFilter = {},
): number | null {
  return selectRoleSpend(state, filter).overheadRatio
}

/**
 * Null unless both sides produced output. See {@link RoleSpendSplit.overheadRatio}
 * for why this divides output tokens, never `.total`.
 */
function overhead(conductorOutputTokens: number, workerOutputTokens: number): number | null {
  if (conductorOutputTokens <= 0 || workerOutputTokens <= 0) return null
  return conductorOutputTokens / workerOutputTokens
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
 *
 * **No cursor twin, and the reason is structural.** A cursor answers one fixed
 * filter; a rolling window's `since` moves on every call, so records leave the
 * window as well as enter it, and un-accumulating a record is not the same
 * problem as accumulating one (a `Set` of models cannot be subtracted, nor can
 * a `firstTs` minimum). Measured, this path is also not where the cost is:
 * both rate calls together were 7.1 ms of a 25,000-event `buildFleet`'s 226 ms,
 * because the window predicate rejects nearly every record before any
 * accumulation happens. See `spend-cursor.bench.test.ts`.
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

/**
 * Adds already-finalised totals — used to roll lanes up into a worktree. Plain
 * arithmetic over the public shape rather than a second trip through the
 * accumulator: these dollars have already had prd9 ruling 7's coverage rule
 * applied to them, and applying it twice is how a rollup would double-decide
 * the same tokens.
 */
function mergeTotals(entries: readonly SpendTotals[]): SpendTotals {
  let tokens: TokenUsagePayload = ZERO_TOKENS
  let authoritativeCostUsd = 0
  let estimatedCostUsd = 0
  let requestCount = 0
  let costEventCount = 0
  let estimatedCostEventCount = 0
  let toolCallCount = 0
  let firstTs: number | null = null
  let lastTs: number | null = null
  const estimateSources = new Set<string>()
  const models = new Set<string>()
  const roles = new Set<AgentRole>()
  const origins = new Set<TelemetryOrigin>()

  for (const entry of entries) {
    tokens = addTokens(tokens, entry.tokens)
    authoritativeCostUsd += entry.authoritativeCostUsd
    estimatedCostUsd += entry.estimatedCostUsd
    requestCount += entry.requestCount
    costEventCount += entry.costEventCount
    estimatedCostEventCount += entry.estimatedCostEventCount
    toolCallCount += entry.toolCallCount
    for (const source of entry.estimateSources ?? []) estimateSources.add(source)
    for (const model of entry.models) models.add(model)
    for (const role of entry.roles) roles.add(role)
    for (const origin of entry.origins) origins.add(origin)
    if (entry.firstTs !== null) firstTs = firstTs === null ? entry.firstTs : Math.min(firstTs, entry.firstTs)
    if (entry.lastTs !== null) lastTs = lastTs === null ? entry.lastTs : Math.max(lastTs, entry.lastTs)
  }

  return {
    tokens: { ...tokens, total: totalTokens(tokens) },
    costUsd: authoritativeCostUsd + estimatedCostUsd,
    authoritativeCostUsd,
    estimatedCostUsd,
    // No cost events at all is "unknown", not "authoritatively free".
    costIsAuthoritative: costEventCount === 0 ? null : estimatedCostEventCount === 0,
    requestCount,
    costEventCount,
    estimatedCostEventCount,
    estimateSources: [...estimateSources].sort(compareStrings),
    toolCallCount,
    models: [...models].sort(compareStrings),
    roles: AGENT_ROLES.filter((role) => roles.has(role)),
    origins: [...origins].sort(compareStrings),
    firstTs,
    lastTs,
  }
}

// --- filtering --------------------------------------------------------------

function toolsIn(state: SessionState, filter: SpendFilter): ToolActivityRecord[] {
  return state.telemetry.tools.filter(
    (record) => inWindow(record.ts, filter) && fromOrigin(record.origin, filter),
  )
}

/**
 * Dearest first, then most output tokens, then a stable name tiebreak.
 * Output, not `.total`: prd2's ruling is that a display surface never ranks
 * by the all-tier sum (see {@link TokenTotals}).
 */
function bySpend<T extends SpendTotals>(name: (entry: T) => string) {
  return (a: T, b: T): number =>
    b.costUsd - a.costUsd || b.tokens.output - a.tokens.output || compareStrings(name(a), name(b))
}

// --- the incremental path ---------------------------------------------------

/**
 * The cursor API, re-exported here so `./index.js` (which #251 owns) needs no
 * change and every consumer keeps importing spend from one place.
 * {@link laneSpendCursor} documents the seam.
 */
export {
  DEFAULT_SPEND_KEYFRAME_INTERVAL,
  spendFrom,
  type SpendCursor,
  type SpendCursorSpec,
  type SpendGroupKeys,
  type SpendGroupResult,
  type SpendGrouping,
  type SpendMarks,
  type SpendPosition,
} from './spend-cursor.js'
