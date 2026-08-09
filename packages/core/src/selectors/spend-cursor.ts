import type { AgentRole, AgentThread, TelemetryOrigin, TokenUsagePayload } from '../events/index.js'
import { AGENT_ROLES, AGENT_THREADS, ZERO_TOKENS, addTokens, totalTokens } from '../events/index.js'
import { type CostEstimate, estimateCostUsd } from '../pricing/index.js'
import {
  type CostRecord,
  type SessionState,
  type ToolActivityRecord,
  type UsageRecord,
  initialSessionState,
} from '../state.js'
import type { SpendFilter, SpendTotals, ThreadSpend } from './spend.js'
import { compareStrings } from './touches.js'

/**
 * THE SPEND ENGINE, AND THE CURSOR OVER IT.
 *
 * Every rollup in `spend.ts` used to hand-roll the same three-part shape —
 * create an accumulator per key, loop `usage` then `costs` then `tools`,
 * finalise — six times over, and every call rescanned the entire telemetry
 * history. Measured on this box (see `spend-cursor.bench.test.ts`), one
 * `buildFleet` at 25,000 events spent 214 ms of its 226 ms inside six such
 * calls. That is the disease `reduce.ts` had one layer down and #160 cured with
 * keyframed incremental folding; [ADR-0002](../../../../docs/adr/0002-one-reducer-for-live-and-replay.md)
 * records both the fold's cure and why one shared definition is preferred to
 * two that can drift.
 *
 * Two things live here:
 *
 * 1. **{@link groupSpendBy}** — the one generic grouping the six rollups are
 *    now thin wrappers over. `keyOf` says which group each record lands in;
 *    everything else (the window/origin/authority filters, prd9 ruling 7's
 *    per-record pricing, the honesty flags) happens once, in one place.
 * 2. **{@link spendCursor} / {@link spendFrom}** — the incremental path. A
 *    cursor remembers where in the telemetry slices' **append order** it has
 *    read to, so answering the same question about a longer prefix costs the
 *    records appended since, not the whole history.
 *
 * **Why a cursor and not a memo.** Replay folds a *fresh* `SessionState` on
 * every seek (`useReplaySession.ts:178`), so a cache keyed on the state object
 * misses 120x a second by construction — prd21 ruling 1 records that dead end
 * explicitly. A cursor keys on the append-order *position* instead, which is
 * the thing that actually survives a re-fold, and it is checked against the
 * record identities at that position ({@link SpendMarks}) rather than trusted.
 *
 * **Append order, never a sorted one (#205).** A cursor's position is a count
 * of records consumed off `state.telemetry.usage` / `.costs` / `.tools` in the
 * order the log wrote them. Nothing here sorts, binary-searches by `ts`, or
 * assumes `ts` rises with position: a `since`/`until` window is a per-record
 * predicate, exactly as it always was, so a line that arrives late carrying an
 * older `ts` is counted when it arrives and counted in the window it belongs
 * to. `spend-cursor.test.ts` pins that with a deliberately non-monotonic log.
 */

// --- the filters, shared by the direct and incremental paths -----------------

/** Inclusive on both ends — replay's "as of now" is an `until`. */
export function inWindow(ts: number, filter: SpendFilter): boolean {
  if (filter.since !== undefined && ts < filter.since) return false
  if (filter.until !== undefined && ts > filter.until) return false
  return true
}

export function fromOrigin(origin: TelemetryOrigin, filter: SpendFilter): boolean {
  return filter.origins === undefined || filter.origins.includes(origin)
}

/** `filter.costs`' gate on a single cost record — "which dollars should I count". */
function countsUnderAuthority(record: CostRecord, filter: SpendFilter): boolean {
  const authority = filter.costs ?? 'all'
  if (authority === 'all') return true
  return authority === 'authoritative' ? record.authoritative : !record.authoritative
}

// --- what a grouping is -----------------------------------------------------

/**
 * Which group a record belongs to, per record kind. `null` (or an absent
 * function) skips the record: that is how `selectModelSpend` ignores tool calls
 * and how `selectRoleSpend` refuses to attribute a role-less tool call.
 *
 * One function usually serves all three — the three record kinds share `lane`,
 * `ts`, `origin`, `branch` and `thread` — so `{ usage: laneOf, cost: laneOf,
 * tool: laneOf }` is the common shape rather than three separate closures.
 */
export interface SpendGroupKeys {
  usage?: (record: UsageRecord) => string | null
  cost?: (record: CostRecord) => string | null
  tool?: (record: ToolActivityRecord) => string | null
}

/** A rollup's whole definition: where records land, and what rides alongside. */
export interface SpendGrouping {
  /** Which group each record inside the filter is accumulated into. */
  keys: SpendGroupKeys
  /**
   * Groups that must exist even when no record inside the filter feeds them —
   * a known lane at zero is a different fact from a lane whose telemetry never
   * arrived. Read off the state on every advance, so a group that appears
   * later still appears.
   */
  seed?: (state: SessionState) => Iterable<string>
  /**
   * Groups a record's mere existence proves, *regardless of the filter* —
   * `selectSpendByBranch`'s rule that a branch's identity outlives any window,
   * while the window still decides which of its spend counts.
   */
  presence?: SpendGroupKeys
  /** Track which lanes fed each group (model, branch and role rollups). */
  lanes?: boolean
  /** Track per-tool call counts (`selectLaneSpend`'s `toolCounts`). */
  toolCounts?: boolean
  /** Track per-thread sub-accumulators (`selectLaneSpend`'s `threads`). */
  threads?: boolean
}

/** One finalised group, before a wrapper decorates it into its own row type. */
export interface SpendGroupResult {
  key: string
  totals: SpendTotals
  /** Alphabetical; empty unless {@link SpendGrouping.lanes} asked for it. */
  lanes: string[]
  /** Empty unless {@link SpendGrouping.toolCounts} asked for it. */
  toolCounts: Record<string, number>
  /**
   * Dearest first; empty unless {@link SpendGrouping.threads} asked for it —
   * and also empty when nothing in the group named a thread at all (an
   * un-parsed source has no sub-rows, which is not one sub-row of unknowns).
   */
  threads: ThreadSpend[]
}

// --- accumulation ------------------------------------------------------------

/**
 * prd9 ruling 7's estimate for one *owner* — a (lane, sessionId) pair — held
 * back rather than folded straight into the totals.
 *
 * The ruling makes a usage record's estimate-or-not depend on whether its lane
 * (or its session, across the OTel/sessionlog join) ever reports a real
 * `llm.cost`. "Ever" is not knowable when the record is visited: a lane's first
 * cost event can arrive after a thousand of its usage records, and it then
 * retracts every estimate this file made for that lane. The whole-array
 * pre-pass `costCoverage` used to do that for a one-shot rescan; a cursor
 * cannot re-walk records it has already passed, so the estimate is instead
 * *parked under its owner* and admitted at finalise time only if that owner is
 * still uncovered. Coverage only ever grows, so the decision is stable once
 * taken and the same for every grouping — which is what keeps the model rollup
 * and the lane rollup reconciling on the same mixed total.
 */
interface OwnerEstimate {
  lane: string
  sessionId: string | null
  costUsd: number
  /** Usage records this owner contributed an estimate for. */
  count: number
  sources: Set<string>
}

/**
 * One group's running totals. Dollars split three ways on purpose: what the
 * CLI said was authoritative, what a `llm.cost` event itself called an
 * estimate, and what *this file* priced on read (parked in {@link deferred}).
 */
interface Acc {
  tokens: TokenUsagePayload
  authoritativeCostUsd: number
  /** From `llm.cost` events flagged non-authoritative — never our own pricing. */
  estimatedCostUsdFromEvents: number
  estimatedCostEventsFromEvents: number
  /** Every `llm.cost` event counted, authoritative or not. */
  costEventsFromEvents: number
  requestCount: number
  toolCallCount: number
  models: Set<string>
  roles: Set<AgentRole>
  origins: Set<TelemetryOrigin>
  firstTs: number | null
  lastTs: number | null
  /**
   * Lane, then session id (`''` for a record that named none) — nested rather
   * than keyed on a composite string because this is looked up once per usage
   * record on the hottest path in the file, and building a a composite lane-and-session
   * key there allocates a string per record for nothing.
   */
  deferred: Map<string, Map<string, OwnerEstimate>>
}

interface Group {
  acc: Acc
  lanes: Set<string> | null
  toolCounts: Map<string, number> | null
  threads: Map<AgentThread | null, Acc> | null
}

/** Lanes and sessions with at least one real `llm.cost` inside the filter. */
interface Coverage {
  lanes: Set<string>
  sessions: Set<string>
}

/**
 * Everything a cursor carries forward, and everything a one-shot rescan builds
 * and throws away. Treated as owned-and-mutable by whoever holds it: a cursor
 * copies it before advancing ({@link copyGroups}) so the cursor it was handed
 * stays a valid snapshot.
 */
interface SpendAccumulation {
  groups: Map<string, Group>
  coverage: Coverage
}

function createAcc(): Acc {
  return {
    tokens: ZERO_TOKENS,
    authoritativeCostUsd: 0,
    estimatedCostUsdFromEvents: 0,
    estimatedCostEventsFromEvents: 0,
    costEventsFromEvents: 0,
    requestCount: 0,
    toolCallCount: 0,
    models: new Set(),
    roles: new Set(),
    origins: new Set(),
    firstTs: null,
    lastTs: null,
    deferred: new Map(),
  }
}

function copyAcc(acc: Acc): Acc {
  const deferred = new Map<string, Map<string, OwnerEstimate>>()
  for (const [lane, bySession] of acc.deferred) {
    const copy = new Map<string, OwnerEstimate>()
    for (const [session, owner] of bySession) {
      copy.set(session, { ...owner, sources: new Set(owner.sources) })
    }
    deferred.set(lane, copy)
  }
  return {
    ...acc,
    models: new Set(acc.models),
    roles: new Set(acc.roles),
    origins: new Set(acc.origins),
    deferred,
  }
}

function emptyAccumulation(): SpendAccumulation {
  return { groups: new Map(), coverage: { lanes: new Set(), sessions: new Set() } }
}

/**
 * A deep-enough copy that mutating the result cannot be observed through the
 * original: every container a subsequent advance writes into is replaced, and
 * nothing else is. `O(groups)`, and the group count is bounded by lanes,
 * branches, models or roles — dimensions that stay flat while telemetry
 * records grow (prd21's own amplification held `worktrees=4 branches=4` from
 * 466 events to 25,000), which is what keeps an advance's cost about the
 * records it crossed.
 */
function copyGroups(from: SpendAccumulation): SpendAccumulation {
  const groups = new Map<string, Group>()
  for (const [key, group] of from.groups) {
    const threads =
      group.threads === null
        ? null
        : new Map<AgentThread | null, Acc>(
            [...group.threads].map(([thread, acc]) => [thread, copyAcc(acc)]),
          )
    groups.set(key, {
      acc: copyAcc(group.acc),
      lanes: group.lanes === null ? null : new Set(group.lanes),
      toolCounts: group.toolCounts === null ? null : new Map(group.toolCounts),
      threads,
    })
  }
  return {
    groups,
    coverage: {
      lanes: new Set(from.coverage.lanes),
      sessions: new Set(from.coverage.sessions),
    },
  }
}

function groupFor(target: SpendAccumulation, key: string, grouping: SpendGrouping): Group {
  const existing = target.groups.get(key)
  if (existing !== undefined) return existing
  const fresh: Group = {
    acc: createAcc(),
    lanes: grouping.lanes === true ? new Set() : null,
    toolCounts: grouping.toolCounts === true ? new Map() : null,
    threads: grouping.threads === true ? new Map() : null,
  }
  target.groups.set(key, fresh)
  return fresh
}

function threadAccFor(group: Group, thread: AgentThread | null): Acc | null {
  if (group.threads === null) return null
  const existing = group.threads.get(thread)
  if (existing !== undefined) return existing
  const fresh = createAcc()
  group.threads.set(thread, fresh)
  return fresh
}

function touch(acc: Acc, ts: number, origin: TelemetryOrigin): void {
  acc.origins.add(origin)
  acc.firstTs = acc.firstTs === null ? ts : Math.min(acc.firstTs, ts)
  acc.lastTs = acc.lastTs === null ? ts : Math.max(acc.lastTs, ts)
}

function isCovered(lane: string, sessionId: string | null, coverage: Coverage): boolean {
  if (coverage.lanes.has(lane)) return true
  return sessionId !== null && coverage.sessions.has(sessionId)
}

/**
 * prd9 ruling 7, priced once per record and shared by every accumulator that
 * record feeds. Null when the owner already has real dollars (nothing to
 * estimate) or when no vendored pattern covers the model (an honest gap, never
 * a zero).
 *
 * Pricing is by far the most expensive thing this file does per record —
 * `estimateCostUsd` walks 149 anchored patterns, measured at ~2.7 µs against
 * ~0.5 µs for the rest of a record's accumulation — so it happens here, once,
 * rather than inside each `addUsage` call. `selectLaneSpend` used to pay it
 * twice per record, once for the lane and again for the thread sub-row.
 */
function priceOnRead(record: UsageRecord, coverage: Coverage): CostEstimate | null {
  if (isCovered(record.lane, record.sessionId, coverage)) return null
  return estimateCostUsd(record.model, record.tokens)
}

function addUsage(acc: Acc, record: UsageRecord, estimate: CostEstimate | null): void {
  acc.tokens = addTokens(acc.tokens, record.tokens)
  acc.requestCount += 1
  acc.models.add(record.model)
  acc.roles.add(record.role)
  touch(acc, record.ts, record.origin)
  if (estimate === null) return
  const session = record.sessionId ?? ''
  let bySession = acc.deferred.get(record.lane)
  if (bySession === undefined) {
    bySession = new Map()
    acc.deferred.set(record.lane, bySession)
  }
  const existing = bySession.get(session)
  if (existing === undefined) {
    bySession.set(session, {
      lane: record.lane,
      sessionId: record.sessionId,
      costUsd: estimate.costUsd,
      count: 1,
      sources: new Set([estimate.source]),
    })
    return
  }
  existing.costUsd += estimate.costUsd
  existing.count += 1
  existing.sources.add(estimate.source)
}

function addCost(acc: Acc, record: CostRecord): void {
  if (record.authoritative) {
    acc.authoritativeCostUsd += record.costUsd
  } else {
    acc.estimatedCostUsdFromEvents += record.costUsd
    acc.estimatedCostEventsFromEvents += 1
  }
  acc.costEventsFromEvents += 1
  acc.models.add(record.model)
  acc.roles.add(record.role)
  touch(acc, record.ts, record.origin)
}

function addTool(acc: Acc, record: ToolActivityRecord): void {
  acc.toolCallCount += 1
  if (record.role !== null) acc.roles.add(record.role)
  touch(acc, record.ts, record.origin)
}

/**
 * The totals as a caller sees them, with {@link OwnerEstimate}s admitted only
 * for owners the coverage set still says have no real dollars.
 */
function finalise(acc: Acc, coverage: Coverage): SpendTotals {
  let estimatedCostUsd = 0
  let estimatedEvents = 0
  const sources = new Set<string>()
  for (const bySession of acc.deferred.values()) {
    for (const owner of bySession.values()) {
      if (isCovered(owner.lane, owner.sessionId, coverage)) continue
      estimatedCostUsd += owner.costUsd
      estimatedEvents += owner.count
      for (const source of owner.sources) sources.add(source)
    }
  }
  estimatedCostUsd += acc.estimatedCostUsdFromEvents
  const estimatedCostEventCount = estimatedEvents + acc.estimatedCostEventsFromEvents
  const costEventCount = estimatedEvents + acc.costEventsFromEvents
  return {
    tokens: { ...acc.tokens, total: totalTokens(acc.tokens) },
    costUsd: acc.authoritativeCostUsd + estimatedCostUsd,
    authoritativeCostUsd: acc.authoritativeCostUsd,
    estimatedCostUsd,
    // No cost events at all is "unknown", not "authoritatively free".
    costIsAuthoritative: costEventCount === 0 ? null : estimatedCostEventCount === 0,
    requestCount: acc.requestCount,
    costEventCount,
    estimatedCostEventCount,
    estimateSources: [...sources].sort(compareStrings),
    toolCallCount: acc.toolCallCount,
    models: [...acc.models].sort(compareStrings),
    roles: AGENT_ROLES.filter((role) => acc.roles.has(role)),
    origins: [...acc.origins].sort(compareStrings),
    firstTs: acc.firstTs,
    lastTs: acc.lastTs,
  }
}

/**
 * The zeroed totals — what a group nothing landed in reports, and what a
 * grouping with no group at all (an empty cursor, a role nobody ever wore)
 * reports in its place. `costIsAuthoritative: null` is the point: no cost
 * events at all is "we do not know", never "it was free".
 */
export function emptySpendTotals(): SpendTotals {
  return finalise(createAcc(), { lanes: new Set(), sessions: new Set() })
}

/** Declared thread order, with the unknown bucket last. */
function threadOrder(thread: AgentThread | null): number {
  return thread === null ? AGENT_THREADS.length : AGENT_THREADS.indexOf(thread)
}

function threadRows(
  byThread: Map<AgentThread | null, Acc> | null,
  coverage: Coverage,
): ThreadSpend[] {
  if (byThread === null || byThread.size === 0) return []
  if (![...byThread.keys()].some((thread) => thread !== null)) return []
  return [...byThread.entries()]
    .map(([thread, acc]) => ({ ...finalise(acc, coverage), thread }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        b.tokens.output - a.tokens.output ||
        threadOrder(a.thread) - threadOrder(b.thread),
    )
}

function finaliseGroups(accumulation: SpendAccumulation): SpendGroupResult[] {
  const results: SpendGroupResult[] = []
  for (const [key, group] of accumulation.groups) {
    results.push({
      key,
      totals: finalise(group.acc, accumulation.coverage),
      lanes: group.lanes === null ? [] : [...group.lanes].sort(compareStrings),
      toolCounts: group.toolCounts === null ? {} : Object.fromEntries(group.toolCounts),
      threads: threadRows(group.threads, accumulation.coverage),
    })
  }
  return results
}

// --- the pass ---------------------------------------------------------------

/** How many records of each slice a cursor has consumed, in append order. */
export interface SpendPosition {
  usage: number
  costs: number
  tools: number
}

const ORIGIN: SpendPosition = { usage: 0, costs: 0, tools: 0 }

function positionOf(state: SessionState): SpendPosition {
  return {
    usage: state.telemetry.usage.length,
    costs: state.telemetry.costs.length,
    tools: state.telemetry.tools.length,
  }
}

function atOrBefore(position: SpendPosition, target: SpendPosition): boolean {
  return (
    position.usage <= target.usage &&
    position.costs <= target.costs &&
    position.tools <= target.tools
  )
}

function totalRecords(position: SpendPosition): number {
  return position.usage + position.costs + position.tools
}

function samePosition(a: SpendPosition, b: SpendPosition): boolean {
  return a.usage === b.usage && a.costs === b.costs && a.tools === b.tools
}

/**
 * The groups the state itself insists on, records or no records — known lanes,
 * known branches, all four roles. Re-applied on **every** read rather than once
 * at the start: a branch can appear from a git event that adds no telemetry
 * record at all, and a cursor asked about that state must still grow the row.
 * `O(seeds)`, and idempotent.
 */
function applySeeds(target: SpendAccumulation, state: SessionState, grouping: SpendGrouping): void {
  for (const key of grouping.seed?.(state) ?? []) groupFor(target, key, grouping)
}

/**
 * The next position to stop at when catching up a long way: **exactly**
 * `interval` records further on, spread across the three slices in proportion to
 * what each still owes, so the stop is a position a later backward scrub can
 * actually start from (all three slices moved). `target` itself once the rest
 * fits in one chunk.
 *
 * The allocation is floors plus a largest-remainder pass rather than three
 * independent `Math.ceil`s. Three ceilings each round up by almost a whole
 * record, so the naive spelling could step 502 records at a time and quietly
 * falsify the "at most `interval`" bound this file documents. This lands on
 * `interval` on the nose, which is what makes that bound a fact rather than an
 * approximation — `spend-cursor.test.ts` asserts the stride.
 */
function chunkEnd(from: SpendPosition, target: SpendPosition, interval: number): SpendPosition {
  const owed = [target.usage - from.usage, target.costs - from.costs, target.tools - from.tools]
  const remaining = owed[0]! + owed[1]! + owed[2]!
  if (remaining <= interval) return target

  const take = owed.map((slice) => Math.floor((slice * interval) / remaining))
  let allocated = take[0]! + take[1]! + take[2]!
  // Hand the rounding remainder out a record at a time, to whichever slice is
  // furthest behind its share. Always terminates having allocated exactly
  // `interval`, since `remaining > interval` means some slice still owes one.
  while (allocated < interval) {
    let best = 0
    let bestShortfall = -1
    for (let slice = 0; slice < 3; slice += 1) {
      const shortfall = owed[slice]! - take[slice]!
      if (shortfall > bestShortfall) {
        bestShortfall = shortfall
        best = slice
      }
    }
    take[best] = take[best]! + 1
    allocated += 1
  }

  return {
    usage: from.usage + take[0]!,
    costs: from.costs + take[1]!,
    tools: from.tools + take[2]!,
  }
}

/**
 * Walks every record between `from` and `to`, into `target`. Mutates `target`;
 * returns how many records it actually visited — **the instrumented seam the
 * complexity law counts.** That number is incremented once per record examined,
 * in the loops below, so it is the real iteration count rather than arithmetic
 * on the positions.
 *
 * **Costs before usage, deliberately.** Coverage (which lanes/sessions have
 * real dollars) comes only from cost records, and a usage record that is
 * already covered skips pricing entirely — the expensive part. Walking the new
 * cost records first therefore leaves this pass costing exactly what the
 * two-pass rescan cost, instead of pricing records it is about to retract.
 * Correctness does not depend on the order: {@link OwnerEstimate} makes a late
 * cost event retract earlier estimates whenever it lands.
 */
function advanceInto(
  target: SpendAccumulation,
  state: SessionState,
  filter: SpendFilter,
  grouping: SpendGrouping,
  from: SpendPosition,
  to: SpendPosition,
): number {
  let visited = 0

  const costs = state.telemetry.costs
  for (let i = from.costs; i < to.costs; i += 1) {
    const record = costs[i] as CostRecord
    visited += 1
    const presence = grouping.presence?.cost?.(record)
    if (presence !== undefined && presence !== null) groupFor(target, presence, grouping)
    if (!inWindow(record.ts, filter) || !fromOrigin(record.origin, filter)) continue
    // Coverage is never narrowed by `filter.costs`: that option asks which
    // dollars to render, not whether the other kind stopped existing, so an
    // `{ costs: 'estimated' }` read must not treat an authoritative-only lane
    // as uncovered and pile a second estimate on top of it.
    target.coverage.lanes.add(record.lane)
    if (record.sessionId !== null) target.coverage.sessions.add(record.sessionId)
    if (!countsUnderAuthority(record, filter)) continue
    const key = grouping.keys.cost?.(record)
    if (key === undefined || key === null) continue
    const group = groupFor(target, key, grouping)
    addCost(group.acc, record)
    if (group.lanes !== null) group.lanes.add(record.lane)
    const thread = threadAccFor(group, record.thread)
    if (thread !== null) addCost(thread, record)
  }

  const usage = state.telemetry.usage
  for (let i = from.usage; i < to.usage; i += 1) {
    const record = usage[i] as UsageRecord
    visited += 1
    const presence = grouping.presence?.usage?.(record)
    if (presence !== undefined && presence !== null) groupFor(target, presence, grouping)
    if (!inWindow(record.ts, filter) || !fromOrigin(record.origin, filter)) continue
    const key = grouping.keys.usage?.(record)
    if (key === undefined || key === null) continue
    const estimate = priceOnRead(record, target.coverage)
    const group = groupFor(target, key, grouping)
    addUsage(group.acc, record, estimate)
    if (group.lanes !== null) group.lanes.add(record.lane)
    const thread = threadAccFor(group, record.thread)
    if (thread !== null) addUsage(thread, record, estimate)
  }

  const tools = state.telemetry.tools
  for (let i = from.tools; i < to.tools; i += 1) {
    const record = tools[i] as ToolActivityRecord
    visited += 1
    const presence = grouping.presence?.tool?.(record)
    if (presence !== undefined && presence !== null) groupFor(target, presence, grouping)
    if (!inWindow(record.ts, filter) || !fromOrigin(record.origin, filter)) continue
    const key = grouping.keys.tool?.(record)
    if (key === undefined || key === null) continue
    const group = groupFor(target, key, grouping)
    addTool(group.acc, record)
    if (group.lanes !== null) group.lanes.add(record.lane)
    if (group.toolCounts !== null) {
      group.toolCounts.set(record.tool, (group.toolCounts.get(record.tool) ?? 0) + 1)
    }
    const thread = threadAccFor(group, record.thread)
    if (thread !== null) addTool(thread, record)
  }

  return visited
}

/**
 * One rollup of a whole state — the shape every selector in `spend.ts` is now
 * a thin wrapper over. Cost is linear in the telemetry history, which is what
 * a public selector's unchanged signature promises and no more: the cheap
 * repeat is {@link spendFrom}'s job, and a caller opts into it.
 */
export function groupSpendBy(
  state: SessionState,
  filter: SpendFilter,
  keyOf: SpendGrouping,
): SpendGroupResult[] {
  const accumulation = emptyAccumulation()
  applySeeds(accumulation, state, keyOf)
  advanceInto(accumulation, state, filter, keyOf, ORIGIN, positionOf(state))
  return finaliseGroups(accumulation)
}

// --- the cursor -------------------------------------------------------------

/**
 * What a position is checked against before it is continued from: the identity
 * of the last record consumed from each slice (`eventId`), a fingerprint of the
 * session place table, and which recording the whole thing is a position into.
 *
 * The marks are what makes a position safe to trust across the fresh state
 * objects a seek folds: the cursor does not assume the state it is handed
 * continues the one it last read, it *checks* it. A mismatch (a shorter prefix
 * from a backward scrub, a rewritten record, another recording entirely) falls
 * back to a keyframe or to zero rather than reporting a total built from records
 * that are no longer there.
 *
 * **`places` exists because the fold does not only append.** When a session
 * finally learns where it was running, `reduce.ts`'s `placeCosts` (`:957`) goes
 * back and rewrites the `worktreePath`/`branch` of *already appended* cost
 * records for that session — the documented OTel path, since an OTel
 * `llm.cost` carries no cwd. Those are records a cursor may already have
 * counted under a different branch, and neither the array length nor the
 * `eventId` at the position changes when it happens. So the marks carry the
 * place table's own content, and any change to it sends the cursor back. It is
 * `sessionId -> (worktreePath, branch)` and nothing else:
 * `SessionPlace.lastSeenAt` moves on every telemetry event and would make this
 * fingerprint change constantly, while the place itself only ever fills in
 * nulls (`placeMoved`, `reduce.ts:909`) — a handful of times per session.
 *
 * **`recording` exists because record ids are not globally unique.**
 * `createIdFactory` (`events/index.ts:373`) documents its own guarantee: ids are
 * "unique within a session, which is all the log needs". Two recordings of the
 * same repo therefore both carry `evt-000001` at position 0, with the same
 * lanes, request ids, places and timestamps if they were produced the same way —
 * and replay's session picker exists to switch between exactly those. Without
 * this field a cursor handed the second recording finds every other mark intact,
 * continues, and reports the *first* recording's dollars.
 */
export interface SpendMarks {
  usage: string | null
  costs: string | null
  tools: string | null
  /** `sessionId|worktreePath|branch` per session, sorted. See above. */
  places: string
  /** The recording's own identity — `session.started`'s facts. See above. */
  recording: string
}

function markOf(records: readonly { eventId: string }[], position: number): string | null {
  return position === 0 ? null : (records[position - 1]?.eventId ?? null)
}

/**
 * The place table's content, order-independent so that a state folded from
 * scratch fingerprints the same as one folded incrementally. `O(sessions)`, a
 * dimension that stays flat while telemetry records grow.
 */
function placesOf(state: SessionState): string {
  const parts: string[] = []
  for (const place of Object.values(state.telemetry.sessions)) {
    parts.push(`${place.sessionId}|${place.worktreePath ?? ''}|${place.branch ?? ''}`)
  }
  return parts.sort(compareStrings).join('\n')
}

/**
 * Which recording this state is a fold of — `session.started`'s own facts, which
 * is the only recording-scoped identity the state carries. `O(1)`.
 *
 * A log with no `session.started` line has no identity to read, and two such
 * logs are genuinely indistinguishable here; `firstEventTs` rides along so that
 * two of them still differ whenever their first event does. That is a real
 * residual, and it is the same one the record format has: nothing in a
 * `session.started`-less log says which recording it is.
 */
function recordingOf(state: SessionState): string {
  const session = state.session
  if (session === null) return `-|${state.firstEventTs ?? ''}`
  return `${session.sessionId}|${session.repoPath}|${session.startedAt}|${state.firstEventTs ?? ''}`
}

/**
 * The two whole-state fingerprints, read once per advance rather than once per
 * keyframe. Both are `O(1)` or `O(sessions)`; neither grows with the telemetry
 * history, and neither reads a telemetry record.
 */
interface StateIdentity {
  places: string
  recording: string
}

function identityOf(state: SessionState): StateIdentity {
  return { places: placesOf(state), recording: recordingOf(state) }
}

function marksOf(state: SessionState, position: SpendPosition, identity: StateIdentity): SpendMarks {
  return {
    usage: markOf(state.telemetry.usage, position.usage),
    costs: markOf(state.telemetry.costs, position.costs),
    tools: markOf(state.telemetry.tools, position.tools),
    places: identity.places,
    recording: identity.recording,
  }
}

/**
 * Whether `position` is still a position into `state`. Takes the state's
 * identity already computed, so a caller checking several candidates pays for
 * the fingerprints once: this is three record reads and four string compares,
 * `O(1)`, whatever the history's length.
 */
function marksMatch(
  state: SessionState,
  position: SpendPosition,
  marks: SpendMarks,
  identity: StateIdentity,
): boolean {
  // Nothing consumed is nothing to invalidate: a cursor at the origin continues
  // into any state at all, and its empty marks are not a claim about that state.
  if (totalRecords(position) === 0) return true
  if (identity.recording !== marks.recording || identity.places !== marks.places) return false
  const { usage, costs, tools } = state.telemetry
  if (position.usage > usage.length || position.costs > costs.length || position.tools > tools.length)
    return false
  return (
    markOf(usage, position.usage) === marks.usage &&
    markOf(costs, position.costs) === marks.costs &&
    markOf(tools, position.tools) === marks.tools
  )
}

interface SpendKeyframe {
  position: SpendPosition
  marks: SpendMarks
  accumulation: SpendAccumulation
  visitedTotal: number
}

/**
 * 500 records, the spacing `DEFAULT_KEYFRAME_INTERVAL` picked for the fold
 * (`replayFold.ts`) for the same reason: a backward scrub re-accumulates at
 * most this many records, and a long session holds a snapshot per 500 records
 * whose cost is `O(groups)` each — flat in the dimension that actually grows.
 */
export const DEFAULT_SPEND_KEYFRAME_INTERVAL = 500

/** What a cursor needs to answer its one question, fixed for its lifetime. */
export interface SpendCursorSpec<T> {
  grouping: SpendGrouping
  /** The window/origin/authority filter. A cursor answers one filter only. */
  filter: SpendFilter
  /** Turns finalised groups into the selector's own row shape. */
  present: (state: SessionState, groups: readonly SpendGroupResult[]) => T
  /**
   * Records between keyframes; {@link DEFAULT_SPEND_KEYFRAME_INTERVAL} when
   * absent. Keyframes only ever pay for themselves on a *backward* move, so a
   * consumer that never makes one — the live path, where the log only grows —
   * can pass `Number.POSITIVE_INFINITY` and keep none: the catch-up stops
   * chunking and no snapshot is retained. A long-lived cursor otherwise holds
   * one `O(groups)` snapshot per interval, which is a few hundred small maps
   * across a 100,000-record session.
   */
  keyframeInterval?: number
}

/**
 * A spend rollup pinned to a position in the telemetry slices' own append
 * order — the same shape `FoldCursor` has one layer down, for the same reason:
 * an immutable value a consumer can keep in a ref, hand to the next seek, and
 * still hold afterwards.
 */
export interface SpendCursor<T> {
  /** Records consumed, per slice. */
  readonly position: SpendPosition
  /** The answer at {@link position} — `selectX`'s own return shape. */
  readonly value: T
  /**
   * Telemetry records this advance accumulated. **The complexity law's oracle:**
   * advancing to a longer prefix reads this many records, and a rescan would
   * read {@link SpendPosition}'s whole total instead. Counted inside the pass,
   * once per record examined, never derived from the positions.
   *
   * **What it does not count, stated exactly.** An advance also does a fixed
   * amount of work that is not a record walk, and none of it grows with the
   * history: one place-table fingerprint (`O(sessions)`, and the session count
   * stays flat while records grow — prd21's own amplification held it constant
   * from 466 events to 25,000), one recording fingerprint (`O(1)`), one binary
   * search over the retained keyframes (`O(log k)`), at most two mark checks of
   * three record reads each (`O(1)`), one `O(groups)` copy of the accumulator
   * and one `O(groups)` finalise. So an advance is `O(records appended) +
   * O(groups) + O(sessions) + O(log k)`, and this field is the first term — the
   * only one that would otherwise grow with the session.
   */
  readonly visited: number
  /**
   * Every record this cursor's lineage has accumulated, rewinds included — a
   * running total that only ever goes up, so re-reading records after a backward
   * scrub is counted rather than forgiven.
   */
  readonly visitedTotal: number
  /** True when this advance could not continue and re-accumulated from a keyframe or from zero. */
  readonly rewound: boolean
  readonly spec: SpendCursorSpec<T>
  readonly marks: SpendMarks
  readonly accumulation: SpendAccumulation
  readonly keyframes: readonly SpendKeyframe[]
}

/** A cursor before any record — `selectX` of an empty session. */
export function spendCursor<T>(spec: SpendCursorSpec<T>): SpendCursor<T> {
  assertKeyframeInterval(spec.keyframeInterval)
  return {
    position: ORIGIN,
    value: spec.present(initialSessionState(), []),
    visited: 0,
    visitedTotal: 0,
    rewound: false,
    spec,
    marks: { usage: null, costs: null, tools: null, places: '', recording: '' },
    accumulation: emptyAccumulation(),
    keyframes: [],
  }
}

/**
 * Refused at construction rather than discovered at the first advance. An
 * interval below one allocates a zero-record chunk, so the catch-up loop can
 * never reach its target and hangs; `NaN` poisons the position arithmetic into
 * never matching. Both are caller mistakes with no sensible reading, and a
 * cursor is cheap to build and long-lived, so this is the honest place to say so.
 * `Infinity` is deliberately legal — it means "never keyframe", which is what the
 * live path wants.
 */
function assertKeyframeInterval(interval: number | undefined): void {
  if (interval === undefined) return
  if (interval === Number.POSITIVE_INFINITY) return
  if (!Number.isInteger(interval) || interval < 1) {
    throw new RangeError(
      `spendCursor: keyframeInterval must be a positive integer or Infinity, got ${interval}`,
    )
  }
}

/**
 * The cursor's answer for `state`, continuing from `cursor` when `state` is a
 * longer prefix of the same log — the case a forward seek, a playback tick and
 * a live event all produce, and the one this whole file exists for.
 *
 * Otherwise it restarts from the newest keyframe that `state` still agrees
 * with, or from zero when none does. Either way the answer is the answer:
 * accumulating a prefix and then continuing over the next chunk visits the
 * same records, in the same append order, as one pass over the whole prefix,
 * and every coverage-dependent decision is re-taken at finalise
 * ({@link OwnerEstimate}) rather than baked in when a record was crossed.
 */
export function spendFrom<T>(cursor: SpendCursor<T>, state: SessionState): SpendCursor<T> {
  const target = positionOf(state)
  const identity = identityOf(state)
  const interval = cursor.spec.keyframeInterval ?? DEFAULT_SPEND_KEYFRAME_INTERVAL

  // The two whole-state fingerprints are read once, here, and every candidate
  // below is then an O(1) check. Both of them are properties of the state rather
  // than of a position, so when either has changed the whole retained lineage is
  // stale together — a rewritten cost record or a different recording invalidates
  // every keyframe at once, and there is nothing to search.
  const lineage =
    identity.recording === cursor.marks.recording && identity.places === cursor.marks.places
      ? cursor.keyframes
      : []

  const continuable = atOrBefore(cursor.position, target) && marksMatch(state, cursor.position, cursor.marks, identity)
  // `lineage` is sorted ascending by position (see how `kept` is assembled
  // below), so the newest keyframe at or before the target is a binary search
  // rather than a scan of every snapshot the cursor has ever taken.
  const candidate = continuable ? null : newestAtOrBefore(lineage, target)
  const start: SpendKeyframe | null = continuable
    ? {
        position: cursor.position,
        marks: cursor.marks,
        accumulation: cursor.accumulation,
        visitedTotal: cursor.visitedTotal,
      }
    : candidate !== null && marksMatch(state, candidate.position, candidate.marks, identity)
      ? candidate
      : null

  const from = start ?? {
    position: ORIGIN,
    marks: { usage: null, costs: null, tools: null, places: '', recording: '' },
    accumulation: emptyAccumulation(),
    visitedTotal: cursor.visitedTotal,
  }

  // Keyframes are kept in position order: everything at or before where we start
  // (the search above guarantees nothing in the lineage sits between `from` and
  // `target`), then the boundaries this catch-up lays down, then anything the
  // lineage held beyond the target — still valid for a later forward jump.
  const behind: SpendKeyframe[] = []
  const ahead: SpendKeyframe[] = []
  for (const frame of lineage) {
    if (totalRecords(frame.position) <= totalRecords(from.position)) behind.push(frame)
    else if (!atOrBefore(frame.position, target)) ahead.push(frame)
  }
  const laid: SpendKeyframe[] = []

  // Catch up in `interval`-sized chunks, leaving a keyframe at each boundary —
  // the same thing `buildSessionIndex` does while folding a session for the
  // first time (#160 layer 3). Without it, one bulk advance (a fresh load, or
  // a drag straight to the end) would leave nothing behind for the backward
  // scrub that usually follows it.
  let accumulation = copyGroups(from.accumulation)
  applySeeds(accumulation, state, cursor.spec.grouping)
  let position = from.position
  let visited = 0
  while (!samePosition(position, target)) {
    const next = chunkEnd(position, target, interval)
    visited += advanceInto(accumulation, state, cursor.spec.filter, cursor.spec.grouping, position, next)
    position = next
    if (samePosition(position, target)) break
    // The keyframe keeps this accumulation; the walk continues on a copy.
    laid.push({
      position,
      marks: marksOf(state, position, identity),
      accumulation,
      visitedTotal: cursor.visitedTotal + visited,
    })
    accumulation = copyGroups(accumulation)
  }

  const marks = marksOf(state, target, identity)
  const newest = Math.max(
    ...[0, ...behind.map((frame) => totalRecords(frame.position)), ...laid.map((frame) => totalRecords(frame.position))],
  )
  if (totalRecords(target) - newest >= interval) {
    laid.push({ position: target, marks, accumulation, visitedTotal: cursor.visitedTotal + visited })
  }

  return {
    position: target,
    value: cursor.spec.present(state, finaliseGroups(accumulation)),
    visited,
    // The lineage's own running total, which is what its doc promises: a rewind
    // adds the records it re-read rather than resuming the keyframe's history.
    visitedTotal: cursor.visitedTotal + visited,
    rewound: !continuable,
    spec: cursor.spec,
    marks,
    accumulation,
    keyframes: [...behind, ...laid, ...ahead],
  }
}

/**
 * The newest keyframe whose position is at or before `target`, or null — binary
 * search over a position-ordered list, `O(log k)`. The same shape
 * `replayFold.ts`'s `nearestKeyframeAtOrBefore` has, on a triple rather than a
 * single index: the ordering is by total records consumed, and `atOrBefore`
 * still has to hold on all three slices for the frame to be usable.
 */
function newestAtOrBefore(
  keyframes: readonly SpendKeyframe[],
  target: SpendPosition,
): SpendKeyframe | null {
  let low = 0
  let high = keyframes.length - 1
  let best: SpendKeyframe | null = null
  const ceiling = totalRecords(target)
  while (low <= high) {
    const mid = (low + high) >>> 1
    const frame = keyframes[mid] as SpendKeyframe
    if (totalRecords(frame.position) <= ceiling) {
      if (atOrBefore(frame.position, target)) best = frame
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}
