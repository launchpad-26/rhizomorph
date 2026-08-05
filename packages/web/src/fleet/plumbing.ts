import {
  compareStrings,
  selectWaitingOnHuman,
  type AgentRole,
  type AgentStatus,
  type AgentThread,
  type LaneSpend,
  type LaneSubagentActivity,
  type SessionState,
  type SpanDecision,
  type TelemetryOrigin,
  type TokenTotals,
  type WaitingOnHumanSummary,
} from '@rhizomorph/core'
import { IDLE_AFTER_MS } from './constants.js'
import type { LaneManifest } from './fences.js'
import { rankIndex } from './pathology.js'
import type { Filament, Lane, LaneActivity, LaneWaitedOnHuman } from './types.js'

// ── plumbing ────────────────────────────────────────────────────────────────

export interface Draft {
  id: string
  label: string
  handles: Set<string>
  branch: string | null
  worktreePath: string | null
  role: AgentRole
  telemetryOnly: boolean
  present: boolean
  agentStatus: AgentStatus | null
  /** When workmux last declared this lane's status — how long a hand has been up. */
  agentStatusTs: number | null
  paneActivityTs: number | null
  aheadOfMain: number
  commitCount: number
  dirtyCount: number
  filesTouched: number
  lastWorkTs: number | null
  firstSeenAt: number
}

export function emptyDraft(id: string, seedTs: number): Draft {
  return {
    id,
    label: id,
    handles: new Set(),
    branch: null,
    worktreePath: null,
    role: 'unattributed',
    telemetryOnly: true,
    present: true,
    agentStatus: null,
    agentStatusTs: null,
    paneActivityTs: null,
    aheadOfMain: 0,
    commitCount: 0,
    dirtyCount: 0,
    filesTouched: 0,
    lastWorkTs: null,
    firstSeenAt: seedTs,
  }
}

/**
 * Which lane a telemetry row belongs to. Branch first (the durable identity —
 * prd1's ruling that spend is keyed by branch so it survives the worktree), then
 * the worktree path, then the handle itself for a lane git never saw.
 */
export function resolveLaneId(spend: LaneSpend, drafts: ReadonlyMap<string, Draft>): string {
  if (spend.branch !== null && drafts.has(spend.branch)) return spend.branch
  if (spend.worktreePath !== null) {
    for (const draft of drafts.values()) {
      if (draft.worktreePath === spend.worktreePath) return draft.id
    }
  }
  if (drafts.has(spend.lane)) return spend.lane
  return spend.branch ?? spend.lane
}

/** The manifest key this lane is dispatched under, or null when it has none. */
export function fenceHandleFor(manifest: LaneManifest, lane: Lane): string | null {
  for (const handle of lane.handles) if (manifest[handle] !== undefined) return handle
  if (manifest[lane.id] !== undefined) return lane.id
  if (lane.branch !== null && manifest[lane.branch] !== undefined) return lane.branch
  return null
}

export function fenceFor(manifest: LaneManifest, draft: Draft, handles: readonly string[]) {
  for (const handle of handles) {
    const fence = manifest[handle]
    if (fence !== undefined) return fence
  }
  return manifest[draft.id] ?? (draft.branch === null ? undefined : manifest[draft.branch])
}

/**
 * Sums a lane's active seconds across every handle that resolves to it — the
 * same "two collector names, one lane" merge `mergeSpend` does for tokens.
 * Null when NO handle has ever reported a reading (law 12): a lane git can
 * see but OTel never reached must read as a gap, not a summed zero.
 */
export function sumActiveSeconds(
  handles: readonly string[],
  activeSecondsByLane: Readonly<Record<string, number>>,
): number | null {
  return handles.reduce<number | null>((acc, handle) => {
    const seconds = activeSecondsByLane[handle]
    if (seconds === undefined) return acc
    return (acc ?? 0) + seconds
  }, null)
}

/**
 * A lane's whole waited-on-human picture (#143), merged across every key it
 * could be filed under — `selectWaitingOnHuman` filters by one exact `lane`
 * string, and a lane in this file can resolve two collector handles into one
 * row, so each candidate key is queried and the summaries added together, the
 * same fallback order `spanTsByHandle` reads (id, branch, every handle). A
 * key with no `tool_blocked` spans at all just contributes the selector's own
 * zeroed summary, which is harmless to add.
 */
export function waitedOnHumanFor(
  state: SessionState,
  laneId: string,
  branch: string | null,
  handles: readonly string[],
  spanDecisionByKey: ReadonlyMap<string, SpanDecision | null>,
): LaneWaitedOnHuman {
  const keys = new Set<string>([laneId, ...handles])
  if (branch !== null) keys.add(branch)

  const summary = mergeWaitingOnHuman(
    [...keys].map((lane) => selectWaitingOnHuman(state, { lane })),
  )
  const longestWaitDecision =
    summary.longestWait === null
      ? null
      : (spanDecisionByKey.get(spanKey(summary.longestWait.traceId, summary.longestWait.spanId)) ?? null)

  return { ...summary, longestWaitDecision }
}

function mergeWaitingOnHuman(
  summaries: readonly WaitingOnHumanSummary[],
): WaitingOnHumanSummary {
  return summaries.reduce<WaitingOnHumanSummary>(
    (acc, summary) => ({
      totalWaitMs: acc.totalWaitMs + summary.totalWaitMs,
      waitCount: acc.waitCount + summary.waitCount,
      decisions: {
        accept: acc.decisions.accept + summary.decisions.accept,
        reject: acc.decisions.reject + summary.decisions.reject,
        unknown: acc.decisions.unknown + summary.decisions.unknown,
      },
      longestWait:
        summary.longestWait === null
          ? acc.longestWait
          : acc.longestWait === null || summary.longestWait.waitMs > acc.longestWait.waitMs
            ? summary.longestWait
            : acc.longestWait,
    }),
    {
      totalWaitMs: 0,
      waitCount: 0,
      decisions: { accept: 0, reject: 0, unknown: 0 },
      longestWait: null,
    },
  )
}

export function spanKey(traceId: string, spanId: string): string {
  return `${traceId}::${spanId}`
}

/** Every span's own `decision`, keyed by `(traceId, spanId)` — the fact `LongestWait` itself does not carry. */
export function spanDecisionsByKey(state: SessionState): Map<string, SpanDecision | null> {
  const index = new Map<string, SpanDecision | null>()
  for (const span of state.traces.spans) index.set(spanKey(span.traceId, span.spanId), span.decision)
  return index
}

/**
 * The freshest subagent-activity row across every key a lane — or the
 * root-mass, #154 — could be filed under. Same fallback order
 * {@link waitedOnHumanFor} reads: id, branch, every handle. Null when none of
 * them has one (law 12's gap-honesty, not a zeroed bud).
 */
export function subagentActivityFor(
  byLane: Readonly<Record<string, LaneSubagentActivity>>,
  keys: readonly string[],
): LaneSubagentActivity | null {
  let best: LaneSubagentActivity | null = null
  for (const key of keys) {
    const entry = byLane[key]
    if (entry === undefined) continue
    if (best === null || entry.lastActivityTs > best.lastActivityTs) best = entry
  }
  return best
}

export function indexByLane(rows: readonly LaneSpend[]): Record<string, LaneSpend> {
  const index: Record<string, LaneSpend> = {}
  for (const row of rows) index[row.lane] = row
  return index
}

/**
 * Sums the rows for every handle that resolves to one lane. Undefined when no
 * handle had one — which is not the same as a lane that spent zero.
 */
export function mergeSpend(rows: readonly (LaneSpend | undefined)[]): LaneSpend | undefined {
  const present = rows.filter((row): row is LaneSpend => row !== undefined)
  const first = present[0]
  if (first === undefined) return undefined
  if (present.length === 1) return first

  return present.slice(1).reduce<LaneSpend>(
    (acc, row) => ({
      ...acc,
      tokens: {
        input: acc.tokens.input + row.tokens.input,
        output: acc.tokens.output + row.tokens.output,
        cacheRead: acc.tokens.cacheRead + row.tokens.cacheRead,
        cacheCreation: acc.tokens.cacheCreation + row.tokens.cacheCreation,
        total: acc.tokens.total + row.tokens.total,
      },
      costUsd: acc.costUsd + row.costUsd,
      authoritativeCostUsd: acc.authoritativeCostUsd + row.authoritativeCostUsd,
      estimatedCostUsd: acc.estimatedCostUsd + row.estimatedCostUsd,
      requestCount: acc.requestCount + row.requestCount,
      costEventCount: acc.costEventCount + row.costEventCount,
      estimatedCostEventCount: acc.estimatedCostEventCount + row.estimatedCostEventCount,
      toolCallCount: acc.toolCallCount + row.toolCallCount,
      costIsAuthoritative:
        acc.costEventCount + row.costEventCount === 0
          ? null
          : acc.estimatedCostEventCount + row.estimatedCostEventCount === 0,
      threads: [...acc.threads, ...row.threads],
      firstTs: minTs(acc.firstTs, row.firstTs),
      lastTs: maxTs(acc.lastTs, row.lastTs),
    }),
    first,
  )
}

export function filamentsOf(spend: LaneSpend | undefined): Filament[] {
  if (spend === undefined) return []
  const byThread = new Map<AgentThread | null, Filament>()
  for (const thread of spend.threads) {
    const existing = byThread.get(thread.thread)
    if (existing === undefined) {
      byThread.set(thread.thread, {
        thread: thread.thread,
        outputTokens: thread.tokens.output,
        requestCount: thread.requestCount,
      })
    } else {
      existing.outputTokens += thread.tokens.output
      existing.requestCount += thread.requestCount
    }
  }
  return [...byThread.values()].sort((a, b) => b.outputTokens - a.outputTokens)
}

/**
 * #159 — each origin-filtered `llm.usage` record inside the spark window, as
 * a bare `{ts, value}` per telemetry handle, oldest first. Raw events rather
 * than pre-bucketed sums: a lane can resolve two handles, and only after
 * they're merged (by the caller, per lane) does "which bucket" become a
 * meaningful question — the same two-step `recentToolsByHandle` and
 * `latestSpanTsByLane` already take.
 */
export function outputTokenEventsByHandle(
  state: SessionState,
  since: number,
  origins: readonly TelemetryOrigin[],
): Map<string, { ts: number; value: number }[]> {
  const byHandle = new Map<string, { ts: number; value: number }[]>()
  for (const record of state.telemetry.usage) {
    if (record.ts < since || !origins.includes(record.origin)) continue
    const list = byHandle.get(record.lane) ?? []
    list.push({ ts: record.ts, value: record.tokens.output })
    byHandle.set(record.lane, list)
  }
  return byHandle
}

/** Tool names per telemetry handle inside the loop window, oldest first. */
export function recentToolsByHandle(state: SessionState, since: number): Map<string, string[]> {
  const byHandle = new Map<string, string[]>()
  for (const record of state.telemetry.tools) {
    if (record.ts < since) continue
    const list = byHandle.get(record.lane) ?? []
    list.push(record.tool)
    // A cycle is found in the tail; an unbounded tail costs memory for nothing.
    if (list.length > 64) list.shift()
    byHandle.set(record.lane, list)
  }
  return byHandle
}

/**
 * Each lane's newest span receipt within the witness window — the second
 * witness `lastWorkTs` folds in alongside usage/tool recency (#133). Spans
 * live in `state.traces`, never `state.telemetry` (prd9 ruling 4), so this
 * reads that slice directly rather than through `LaneSpend`.
 */
export function latestSpanTsByLane(state: SessionState, since: number): Map<string, number> {
  const latest = new Map<string, number>()
  for (const span of state.traces.spans) {
    if (span.ts < since) continue
    const current = latest.get(span.lane)
    if (current === undefined || span.ts > current) latest.set(span.lane, span.ts)
  }
  return latest
}

export function latestCommitTsByBranch(state: SessionState): Map<string, number> {
  const latest = new Map<string, number>()
  for (const sha of state.commitOrder) {
    const commit = state.commits[sha]
    if (commit === undefined) continue
    for (const branch of commit.branches) {
      const current = latest.get(branch)
      if (current === undefined || commit.landedAt > current) latest.set(branch, commit.landedAt)
    }
  }
  return latest
}

/** A lane that ever spoke as a worker is a worker; the rest is a fallback. */
export function dominantRole(roles: readonly AgentRole[]): AgentRole {
  if (roles.includes('worker')) return 'worker'
  if (roles.includes('conductor')) return 'conductor'
  return roles[0] ?? 'unattributed'
}

/**
 * The non-pathological reading of a lane. Order matters: a declared stop beats
 * a clock, and `done` beats silence — that is what stops a finished fleet from
 * reading as a wall of flatlines.
 */
export function activityOf(lane: Lane): LaneActivity {
  if (lane.agentStatus === 'done' || !lane.present) return 'done'
  if (lane.agentStatus === 'waiting' || lane.pathologies.some((p) => p.kind === 'waiting')) {
    return 'waiting'
  }
  // Working means *doing something*, so this reads work-age too: a lane whose
  // pane is repainting a prompt it never answers is idle, not busy.
  if (lane.workAgeMs === null) return 'unknown'
  return lane.workAgeMs <= IDLE_AFTER_MS ? 'working' : 'idle'
}

/** Worst rung first, then biggest, then alphabetical — a deterministic order. */
export function byAttentionThenSize(a: Lane, b: Lane): number {
  return (
    rankIndex(b.rank) - rankIndex(a.rank) ||
    b.outputTokens - a.outputTokens ||
    compareStrings(a.label, b.label)
  )
}

export function perMinute(value: number, windowMs: number): number {
  const minutes = windowMs / 60_000
  return minutes === 0 ? 0 : value / minutes
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** The fenced-issue convention's number, e.g. `'75'` for `75-instrument-keystone`. */
export function issueOf(label: string): string | null {
  return /^\d+/.exec(label)?.[0] ?? null
}

export function isString(value: string | null): value is string {
  return value !== null
}

export function maxTs(...values: readonly (number | null)[]): number | null {
  let best: number | null = null
  for (const value of values) {
    if (value === null) continue
    if (best === null || value > best) best = value
  }
  return best
}

export function minTs(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

export const ZERO_TOKEN_TOTALS: TokenTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
}

/**
 * Durations, in the compact form every evidence string uses. Kept here rather
 * than in `lib/format.ts` because it is part of the model's own voice: the
 * evidence a detector emits must read identically wherever it is shown.
 */
export function formatSpan(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}
