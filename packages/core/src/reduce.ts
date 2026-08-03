import type {
  EventOf,
  RhizomorphEvent,
} from './events/index.js'
import { totalTokens } from './events/index.js'
import type {
  AgentState,
  BranchState,
  CollectorState,
  CommitRecord,
  CostPlaceSource,
  CostRecord,
  ErrorRecord,
  LaneAttribution,
  PaneState,
  SessionPlace,
  SessionState,
  SpanRecord,
  TelemetryState,
  ToolActivityRecord,
  UsageRecord,
  WorktreeState,
} from './state.js'
import { MAX_ERRORS, basename, initialSessionState } from './state.js'

/**
 * `reduce(state, event) → state`, pure and immutable.
 *
 * The same function folds the live SSE stream and a replayed history slice —
 * that identity is the whole reason replay is free.
 */
export function reduce(state: SessionState, event: RhizomorphEvent): SessionState {
  return applyEvent(withEnvelope(state, event), event)
}

/** Fold a whole log. Handy for replay slices and for tests. */
export function reduceAll(
  events: readonly RhizomorphEvent[],
  state: SessionState = initialSessionState(),
): SessionState {
  return events.reduce(reduce, state)
}

function withEnvelope(state: SessionState, event: RhizomorphEvent): SessionState {
  return {
    ...state,
    eventCount: state.eventCount + 1,
    firstEventTs: state.firstEventTs ?? event.ts,
    lastEventTs: state.lastEventTs === null ? event.ts : Math.max(state.lastEventTs, event.ts),
  }
}

function applyEvent(state: SessionState, event: RhizomorphEvent): SessionState {
  switch (event.type) {
    case 'session.started':
      return sessionStarted(state, event)
    case 'collector.error':
      return collectorError(state, event)
    case 'collector.disabled':
      return collectorDisabled(state, event)
    case 'collector.degraded':
      return collectorDegraded(state, event)
    case 'collector.recovered':
      return collectorRecovered(state, event)
    case 'worktree.discovered':
      return worktreeDiscovered(state, event)
    case 'worktree.removed':
      return worktreeRemoved(state, event)
    case 'worktree.dirty':
      return worktreeDirty(state, event)
    case 'branch.updated':
      return branchUpdated(state, event)
    case 'commit.landed':
      return commitLanded(state, event)
    case 'pane.discovered':
      return paneDiscovered(state, event)
    case 'pane.closed':
      return paneClosed(state, event)
    case 'pane.activity':
      return paneActivity(state, event)
    case 'agent.status':
      return agentStatus(state, event)
    case 'llm.usage':
      return llmUsage(state, event)
    case 'llm.cost':
      return llmCost(state, event)
    case 'tool.activity':
      return toolActivity(state, event)
    case 'telemetry.refused':
      // A refusal is a setup gap, not spend: it stays in the log (and on the
      // stream) for the UI to surface, and contributes nothing to any total.
      // #62 gives it a home in state.
      return state
    case 'trace.span':
      return traceSpan(state, event)
    default: {
      // Exhaustive today; an unknown future type must never break a replay.
      const _never: never = event
      void _never
      return state
    }
  }
}

// --- system -----------------------------------------------------------------

function sessionStarted(state: SessionState, event: EventOf<'session.started'>): SessionState {
  const { sessionId, repoPath, repoName, mainBranch } = event.payload
  return {
    ...state,
    session: { sessionId, repoPath, repoName, startedAt: event.ts },
    mainBranch: mainBranch ?? state.mainBranch,
  }
}

function collectorError(state: SessionState, event: EventOf<'collector.error'>): SessionState {
  const { collector, message, detail } = event.payload
  const prev = state.collectors[collector]
  const record: CollectorState = {
    name: collector,
    // A disabled collector that then errors stays disabled: it is the stronger fact.
    status: prev?.status === 'disabled' ? 'disabled' : 'error',
    errorCount: (prev?.errorCount ?? 0) + 1,
    lastErrorTs: event.ts,
    lastErrorMessage: message,
    consecutiveFailures: prev?.consecutiveFailures ?? 0,
    disabledReason: prev?.disabledReason ?? null,
    disabledAt: prev?.disabledAt ?? null,
  }
  const error: ErrorRecord = {
    eventId: event.id,
    ts: event.ts,
    collector,
    message,
    detail: detail ?? null,
  }
  return {
    ...state,
    collectors: { ...state.collectors, [collector]: record },
    errors: [...state.errors, error].slice(-MAX_ERRORS),
  }
}

function collectorDisabled(state: SessionState, event: EventOf<'collector.disabled'>): SessionState {
  const { collector, reason, consecutiveFailures } = event.payload
  const prev = state.collectors[collector]
  const record: CollectorState = {
    name: collector,
    status: 'disabled',
    errorCount: prev?.errorCount ?? 0,
    lastErrorTs: prev?.lastErrorTs ?? null,
    lastErrorMessage: prev?.lastErrorMessage ?? null,
    consecutiveFailures: consecutiveFailures ?? prev?.consecutiveFailures ?? 0,
    disabledReason: reason,
    disabledAt: event.ts,
  }
  return { ...state, collectors: { ...state.collectors, [collector]: record } }
}

/** A poll failed but hasn't yet crossed the disable threshold — still trying. */
function collectorDegraded(state: SessionState, event: EventOf<'collector.degraded'>): SessionState {
  const { collector, reason, consecutiveFailures } = event.payload
  const prev = state.collectors[collector]
  const record: CollectorState = {
    name: collector,
    // Same ratchet as `collector.error`: a disabled collector's own retry
    // attempt failing again must not read as merely "degraded".
    status: prev?.status === 'disabled' ? 'disabled' : 'degraded-retrying',
    errorCount: (prev?.errorCount ?? 0) + 1,
    lastErrorTs: event.ts,
    lastErrorMessage: reason,
    consecutiveFailures,
    disabledReason: prev?.disabledReason ?? null,
    disabledAt: prev?.disabledAt ?? null,
  }
  return { ...state, collectors: { ...state.collectors, [collector]: record } }
}

/**
 * The self-heal fact: a degraded or disabled collector polled successfully
 * again. Clears the retry count and the disabled reason/timestamp so the
 * provenance bar and the gap registry — both keyed off `status` — read this
 * collector as healthy without needing a restart to notice.
 */
function collectorRecovered(state: SessionState, event: EventOf<'collector.recovered'>): SessionState {
  const { collector } = event.payload
  const prev = state.collectors[collector]
  const record: CollectorState = {
    name: collector,
    status: 'healthy',
    errorCount: prev?.errorCount ?? 0,
    lastErrorTs: prev?.lastErrorTs ?? null,
    lastErrorMessage: prev?.lastErrorMessage ?? null,
    consecutiveFailures: 0,
    disabledReason: null,
    disabledAt: null,
  }
  return { ...state, collectors: { ...state.collectors, [collector]: record } }
}

// --- git --------------------------------------------------------------------

function worktreeDiscovered(
  state: SessionState,
  event: EventOf<'worktree.discovered'>,
): SessionState {
  const p = event.payload
  const prev = state.worktrees[p.path]
  const worktree: WorktreeState = {
    path: p.path,
    name: basename(p.path),
    branch: p.branch,
    head: p.head,
    isMain: p.isMain,
    detached: p.detached ?? p.branch === null,
    present: true,
    discoveredAt: prev?.discoveredAt ?? event.ts,
    removedAt: null,
    // Re-discovery must not forget what we knew was dirty.
    dirtyFiles: prev?.dirtyFiles ?? [],
    dirtyUpdatedAt: prev?.dirtyUpdatedAt ?? null,
  }

  let next: SessionState = { ...state, worktrees: { ...state.worktrees, [p.path]: worktree } }

  if (p.branch !== null) {
    next = upsertBranch(next, p.branch, event.ts, (branch) => ({
      ...branch,
      head: p.head ?? branch.head,
      worktreePath: p.path,
    }))
    // The main worktree's branch is the authority on what "main" means here.
    if (p.isMain) next = { ...next, mainBranch: p.branch }
  }

  return next
}

function worktreeRemoved(state: SessionState, event: EventOf<'worktree.removed'>): SessionState {
  const prev = state.worktrees[event.payload.path]
  if (prev === undefined) return state
  const worktree: WorktreeState = {
    ...prev,
    present: false,
    removedAt: event.ts,
    // A worktree that is gone cannot be colliding with anyone.
    dirtyFiles: [],
    dirtyUpdatedAt: event.ts,
  }
  return { ...state, worktrees: { ...state.worktrees, [prev.path]: worktree } }
}

function worktreeDirty(state: SessionState, event: EventOf<'worktree.dirty'>): SessionState {
  const p = event.payload
  const prev = state.worktrees[p.path]
  const worktree: WorktreeState = {
    ...(prev ?? stubWorktree(p.path, event.ts)),
    branch: p.branch ?? prev?.branch ?? null,
    dirtyFiles: p.files,
    dirtyUpdatedAt: event.ts,
  }
  return { ...state, worktrees: { ...state.worktrees, [p.path]: worktree } }
}

function branchUpdated(state: SessionState, event: EventOf<'branch.updated'>): SessionState {
  const p = event.payload
  let next = upsertBranch(state, p.branch, event.ts, (branch) => ({
    ...branch,
    head: p.head,
    previousHead: p.previousHead ?? branch.head,
    worktreePath: p.worktreePath ?? branch.worktreePath,
    aheadOfMain: p.aheadOfMain === undefined ? branch.aheadOfMain : p.aheadOfMain,
    behindMain: p.behindMain === undefined ? branch.behindMain : p.behindMain,
  }))

  // Keep the worktree's head in step, so the table never shows a stale sha.
  for (const worktree of Object.values(next.worktrees)) {
    if (worktree.branch === p.branch && worktree.head !== p.head) {
      next = {
        ...next,
        worktrees: { ...next.worktrees, [worktree.path]: { ...worktree, head: p.head } },
      }
    }
  }

  return next
}

function commitLanded(state: SessionState, event: EventOf<'commit.landed'>): SessionState {
  const p = event.payload
  const prev = state.commits[p.sha]
  const commit: CommitRecord = {
    sha: p.sha,
    branches: prev === undefined
      ? [p.branch]
      : prev.branches.includes(p.branch)
        ? prev.branches
        : [...prev.branches, p.branch],
    message: p.message,
    author: p.author,
    authoredAt: p.authoredAt ?? prev?.authoredAt ?? event.ts,
    landedAt: prev?.landedAt ?? event.ts,
    parents: p.parents ?? prev?.parents ?? [],
    files: p.files.length > 0 ? p.files : (prev?.files ?? []),
    insertions: p.insertions ?? prev?.insertions ?? null,
    deletions: p.deletions ?? prev?.deletions ?? null,
    worktreePath: p.worktreePath ?? prev?.worktreePath ?? null,
  }

  const next: SessionState = {
    ...state,
    commits: { ...state.commits, [p.sha]: commit },
    commitOrder: prev === undefined ? [...state.commitOrder, p.sha] : state.commitOrder,
  }

  return upsertBranch(next, p.branch, event.ts, (branch) => ({
    ...branch,
    commits: branch.commits.includes(p.sha) ? branch.commits : [...branch.commits, p.sha],
  }))
}

// --- tmux -------------------------------------------------------------------

function paneDiscovered(state: SessionState, event: EventOf<'pane.discovered'>): SessionState {
  const p = event.payload
  const prev = state.panes[p.paneId]
  const pane: PaneState = {
    paneId: p.paneId,
    sessionName: p.sessionName ?? prev?.sessionName ?? null,
    windowName: p.windowName,
    windowIndex: p.windowIndex ?? prev?.windowIndex ?? null,
    currentPath: p.currentPath,
    currentCommand: p.currentCommand ?? prev?.currentCommand ?? null,
    worktreePath: p.worktreePath ?? prev?.worktreePath ?? null,
    present: true,
    discoveredAt: prev?.discoveredAt ?? event.ts,
    closedAt: null,
    lastActivityTs: prev?.lastActivityTs ?? event.ts,
    lastContentChangeTs: prev?.lastContentChangeTs ?? null,
    contentHash: prev?.contentHash ?? null,
    activityCount: prev?.activityCount ?? 0,
    preview: prev?.preview ?? null,
  }
  return { ...state, panes: { ...state.panes, [p.paneId]: pane } }
}

function paneClosed(state: SessionState, event: EventOf<'pane.closed'>): SessionState {
  const prev = state.panes[event.payload.paneId]
  if (prev === undefined) return state
  return {
    ...state,
    panes: {
      ...state.panes,
      [prev.paneId]: { ...prev, present: false, closedAt: event.ts },
    },
  }
}

function paneActivity(state: SessionState, event: EventOf<'pane.activity'>): SessionState {
  const p = event.payload
  const prev = state.panes[p.paneId] ?? stubPane(p.paneId, event.ts)
  const pane: PaneState = {
    ...prev,
    contentHash: p.contentHash,
    lastActivityTs: event.ts,
    lastContentChangeTs: event.ts,
    activityCount: prev.activityCount + 1,
    preview: p.preview ?? prev.preview,
  }
  return { ...state, panes: { ...state.panes, [p.paneId]: pane } }
}

// --- workmux ----------------------------------------------------------------

function agentStatus(state: SessionState, event: EventOf<'agent.status'>): SessionState {
  const p = event.payload
  const prev = state.agents[p.handle]
  const agent: AgentState = {
    handle: p.handle,
    status: p.status,
    previousStatus: prev?.status ?? null,
    worktreePath: p.worktreePath ?? prev?.worktreePath ?? null,
    branch: p.branch ?? prev?.branch ?? null,
    elapsedSeconds: p.elapsedSeconds ?? null,
    detail: p.detail ?? null,
    firstSeenAt: prev?.firstSeenAt ?? event.ts,
    updatedAt: event.ts,
  }
  return { ...state, agents: { ...state.agents, [p.handle]: agent } }
}

// --- telemetry (prd1) -------------------------------------------------------

function llmUsage(state: SessionState, event: EventOf<'llm.usage'>): SessionState {
  const p = event.payload
  const record: UsageRecord = {
    eventId: event.id,
    ts: event.ts,
    origin: event.source,
    lane: p.lane,
    role: p.role,
    model: p.model,
    tokens: p.tokens,
    totalTokens: totalTokens(p.tokens),
    requestId: p.requestId ?? null,
    durationMs: p.durationMs ?? null,
    sessionId: p.sessionId ?? null,
    worktreePath: p.worktreePath ?? null,
    branch: p.branch ?? null,
    thread: p.thread ?? null,
  }
  return withTelemetry(state, event, p, (telemetry) => ({
    ...telemetry,
    usage: dedupedUsage(telemetry.usage, record),
  }))
}

/**
 * Cross-collector dedup by `requestId`: sessionlog and OTel can both emit
 * `llm.usage` for the same physical model request, and appending both would
 * double the ledger's totals. A `requestId` is the only safe join key — a
 * fuzzy join (sessionId+model+token-equality) would risk folding two distinct
 * requests together and silently deleting real spend, so it is never
 * attempted here.
 *
 * The match requires a *different* origin on purpose — this issue is
 * cross-collector dedup, not a general one-request-per-id constraint. A
 * collector re-emitting its own id (e.g. an overlapping resume window) is a
 * separate collector-level concern; folding same-origin records here would
 * risk hiding that bug instead of surfacing it.
 *
 * Every OTel usage event today carries no `requestId` at all (see the comment
 * on `parse-metrics.ts`'s `buildUsageEvent`), so it never matches here and
 * falls through to {@link foldSessionCoverage} — the residual gap #59 left
 * open, closed below.
 */
function dedupedUsage(usage: readonly UsageRecord[], incoming: UsageRecord): UsageRecord[] {
  if (incoming.requestId !== null) {
    const index = usage.findIndex(
      (existing) => existing.requestId === incoming.requestId && existing.origin !== incoming.origin,
    )
    if (index !== -1) {
      const next = usage.slice()
      next[index] = foldUsage(usage[index]!, incoming)
      return next
    }
  }
  return foldSessionCoverage(usage, incoming)
}

/**
 * The residual cross-collector double-count `requestId` dedup cannot reach:
 * OTel's `llm.usage` carries no `requestId`, so when sessionlog is *also*
 * reporting a session, the OTel side has no id to fold against and simply
 * appends, doubling that session's tokens.
 *
 * Origin precedence closes the gap with the honest rule the data supports:
 * sessionlog is the depth collector (it is what supplies the per-message
 * cache-tier detail everything else here reads), so once a session has *any*
 * sessionlog usage record, a request-less OTel usage record for that same
 * session is redundant with it and folds away instead of appending — the
 * only defensible "fold" for a record with no counterpart to merge into. This
 * has to be order-independent: a sessionlog record can arrive after OTel has
 * already appended for the same session, so its arrival also retroactively
 * drops whatever request-less OTel usage that session already accumulated.
 *
 * A session OTel alone ever reports (no sessionlog counterpart, ever) is
 * never touched by either branch below and keeps counting in full — this
 * rule only ever removes a record once the same session's tokens are also
 * available from sessionlog, never the only telemetry a session has.
 */
function foldSessionCoverage(usage: readonly UsageRecord[], incoming: UsageRecord): UsageRecord[] {
  if (incoming.sessionId === null) return [...usage, incoming]

  if (incoming.requestId === null && incoming.origin === 'otel') {
    const coveredBySessionlog = usage.some(
      (existing) => existing.sessionId === incoming.sessionId && existing.origin === 'sessionlog',
    )
    if (coveredBySessionlog) return usage as UsageRecord[]
  }

  if (incoming.origin === 'sessionlog') {
    const withoutStaleOtel = usage.filter(
      (existing) =>
        !(
          existing.origin === 'otel' &&
          existing.requestId === null &&
          existing.sessionId === incoming.sessionId
        ),
    )
    if (withoutStaleOtel.length !== usage.length) return [...withoutStaleOtel, incoming]
  }

  return [...usage, incoming]
}

/**
 * Folds a duplicate request into one record — never sums the two sides'
 * tokens, since they describe the same request. Sessionlog wins for token
 * detail (all four cache tiers) over OTel (input/output only), whichever of
 * the pair arrived first; the loser's attribution fills in only where the
 * winner is missing it (OTel carries no worktree/branch).
 */
function foldUsage(existing: UsageRecord, incoming: UsageRecord): UsageRecord {
  const winner = existing.origin === 'sessionlog' ? existing : incoming
  const loser = winner === existing ? incoming : existing
  return {
    ...loser,
    ...winner,
    worktreePath: winner.worktreePath ?? loser.worktreePath,
    branch: winner.branch ?? loser.branch,
    sessionId: winner.sessionId ?? loser.sessionId,
    durationMs: winner.durationMs ?? loser.durationMs,
    // Whichever side named the thread wins over the side that stayed silent:
    // the two collectors read it from different markers (`query_source` vs
    // `isSidechain`) and only one of them may have been parsed for this
    // request.
    thread: winner.thread ?? loser.thread,
  }
}

/**
 * Dollars, placed. An OTel `llm.cost` knows the session and the money and
 * nothing about where the agent was working (audit §C), so the branch/worktree
 * comes from the session index if anything there knows it yet — see
 * {@link resolvePlace}. If nothing does, the record is stored unplaced and
 * {@link placeCosts} comes back for it when the usage side finally says where
 * that session lives. Either arrival order lands the same dollars on the same
 * branch; neither drops them.
 */
function llmCost(state: SessionState, event: EventOf<'llm.cost'>): SessionState {
  const p = event.payload
  const place = resolvePlace(state.telemetry.sessions, p)
  const record: CostRecord = {
    eventId: event.id,
    ts: event.ts,
    origin: event.source,
    lane: p.lane,
    role: p.role,
    model: p.model,
    costUsd: p.costUsd,
    authoritative: p.authoritative,
    estimateSource: p.estimateSource ?? null,
    requestId: p.requestId ?? null,
    sessionId: p.sessionId ?? null,
    worktreePath: place.worktreePath,
    branch: place.branch,
    placeSource: place.placeSource,
    thread: p.thread ?? null,
  }
  return withTelemetry(state, event, p, (telemetry) => ({
    ...telemetry,
    costs: [...telemetry.costs, record],
  }))
}

/**
 * The cost side of the session join, at arrival time: what the event itself
 * said, else what the session index already knows, else nothing.
 *
 * An event that named any part of its own place is `'source'` and is left
 * alone by later reconciliation — the collector that was actually there
 * outranks an inference, even ours.
 */
function resolvePlace(
  sessions: Readonly<Record<string, SessionPlace>>,
  p: TelemetryAttribution,
): { worktreePath: string | null; branch: string | null; placeSource: CostPlaceSource | null } {
  const reportedWorktree = p.worktreePath ?? null
  const reportedBranch = p.branch ?? null
  if (reportedWorktree !== null || reportedBranch !== null) {
    return { worktreePath: reportedWorktree, branch: reportedBranch, placeSource: 'source' }
  }
  const known = p.sessionId === null || p.sessionId === undefined ? undefined : sessions[p.sessionId]
  const worktreePath = known?.worktreePath ?? null
  const branch = known?.branch ?? null
  return {
    worktreePath,
    branch,
    placeSource: worktreePath === null && branch === null ? null : 'session-join',
  }
}

function toolActivity(state: SessionState, event: EventOf<'tool.activity'>): SessionState {
  const p = event.payload
  const record: ToolActivityRecord = {
    eventId: event.id,
    ts: event.ts,
    origin: event.source,
    lane: p.lane,
    tool: p.tool,
    role: p.role ?? null,
    durationMs: p.durationMs ?? null,
    sessionId: p.sessionId ?? null,
    worktreePath: p.worktreePath ?? null,
    branch: p.branch ?? null,
    thread: p.thread ?? null,
  }
  return withTelemetry(state, event, p, (telemetry) => ({
    ...telemetry,
    tools: [...telemetry.tools, record],
  }))
}

/** Attribution fields shared by every telemetry payload. */
interface TelemetryAttribution {
  lane: string
  sessionId?: string | null | undefined
  worktreePath?: string | null | undefined
  branch?: string | null | undefined
}

/**
 * Appends a telemetry record and keeps the lane and session indexes in step.
 * Attribution is last-non-null-wins: OTel datapoints carry no cwd, so a lane's
 * worktree may only ever be learned from the sessionlog side and must not be
 * unlearned.
 *
 * This is also where the join catches up. Every event that names a place for a
 * session teaches {@link SessionPlace}, and anything already stored unplaced
 * for that session — costs, and the lanes those costs were booked under — is
 * reconciled against what we now know. That is what makes the join
 * order-independent: the dollars land on the same branch whether the cost
 * arrived before or after the usage that placed its session.
 */
function withTelemetry(
  state: SessionState,
  event: RhizomorphEvent,
  attribution: TelemetryAttribution,
  append: (telemetry: TelemetryState) => TelemetryState,
): SessionState {
  const appended = append(state.telemetry)
  const sessions = upsertSessionPlace(appended.sessions, attribution, event.ts)
  const place = attribution.sessionId == null ? undefined : sessions[attribution.sessionId]
  const lanes = {
    ...appended.lanes,
    [attribution.lane]: upsertLane(appended.lanes[attribution.lane], attribution, event.ts),
  }
  return {
    ...state,
    telemetry: {
      ...appended,
      costs: placeCosts(appended.costs, place),
      lanes: placeLanes(lanes, place),
      sessions,
    },
  }
}

/** Learns where a session runs, from whichever event happened to know. */
function upsertSessionPlace(
  sessions: Readonly<Record<string, SessionPlace>>,
  p: TelemetryAttribution,
  ts: number,
): Record<string, SessionPlace> {
  const sessionId = p.sessionId ?? null
  if (sessionId === null) return sessions
  const prev = sessions[sessionId]
  const next: SessionPlace = {
    sessionId,
    worktreePath: p.worktreePath ?? prev?.worktreePath ?? null,
    branch: p.branch ?? prev?.branch ?? null,
    firstSeenAt: prev === undefined ? ts : Math.min(prev.firstSeenAt, ts),
    lastSeenAt: prev === undefined ? ts : Math.max(prev.lastSeenAt, ts),
  }
  return { ...sessions, [sessionId]: next }
}

/**
 * Fills in the branch/worktree of every cost record that shares this session
 * and had none — the retroactive half of the join, for costs that arrived
 * before anything knew where their session was running.
 *
 * A record whose own event named a place (`placeSource: 'source'`) is never
 * touched: the collector that was there outranks the inference. Records
 * already placed by an earlier join are topped up field by field, so learning
 * the branch later than the worktree still completes them. Returns the array
 * unchanged when nothing moved, so the common case allocates nothing.
 */
function placeCosts(
  costs: readonly CostRecord[],
  place: SessionPlace | undefined,
): CostRecord[] {
  if (place === undefined) return costs as CostRecord[]
  if (place.worktreePath === null && place.branch === null) return costs as CostRecord[]
  let changed = false
  const next = costs.map((cost) => {
    if (cost.placeSource === 'source' || cost.sessionId !== place.sessionId) return cost
    const worktreePath = cost.worktreePath ?? place.worktreePath
    const branch = cost.branch ?? place.branch
    if (worktreePath === cost.worktreePath && branch === cost.branch) return cost
    changed = true
    return { ...cost, worktreePath, branch, placeSource: 'session-join' as const }
  })
  return changed ? next : (costs as CostRecord[])
}

/**
 * The same catch-up for lane identity. A lane whose events never carried a
 * place (the OTel side of a session) inherits the place of a session it has
 * been seen under — two lane handles sharing a `sessionId` are two collectors'
 * names for one agent session, so they ran in one worktree. Only nulls are
 * filled; nothing already known is overwritten.
 */
function placeLanes(
  lanes: Readonly<Record<string, LaneAttribution>>,
  place: SessionPlace | undefined,
): Record<string, LaneAttribution> {
  if (place === undefined) return lanes
  if (place.worktreePath === null && place.branch === null) return lanes
  let changed = false
  const next: Record<string, LaneAttribution> = { ...lanes }
  for (const [name, lane] of Object.entries(lanes)) {
    if (lane.worktreePath !== null && lane.branch !== null) continue
    if (!lane.sessionIds.includes(place.sessionId)) continue
    const worktreePath = lane.worktreePath ?? place.worktreePath
    const branch = lane.branch ?? place.branch
    if (worktreePath === lane.worktreePath && branch === lane.branch) continue
    next[name] = { ...lane, worktreePath, branch }
    changed = true
  }
  return changed ? next : lanes
}

function upsertLane(
  prev: LaneAttribution | undefined,
  p: TelemetryAttribution,
  ts: number,
): LaneAttribution {
  const sessionIds = prev?.sessionIds ?? []
  const sessionId = p.sessionId ?? null
  return {
    lane: p.lane,
    worktreePath: p.worktreePath ?? prev?.worktreePath ?? null,
    branch: p.branch ?? prev?.branch ?? null,
    sessionIds:
      sessionId === null || sessionIds.includes(sessionId)
        ? sessionIds
        : [...sessionIds, sessionId],
    firstSeenAt: prev === undefined ? ts : Math.min(prev.firstSeenAt, ts),
    lastSeenAt: prev === undefined ? ts : Math.max(prev.lastSeenAt, ts),
  }
}

// --- traces (prd9) ----------------------------------------------------------

/**
 * One span, appended whole, with the two lookups kept in step.
 *
 * **Idempotent on `(traceId, spanId)`.** Whether the CLI's exporter retries a
 * delivery was never established ([Ran] left it open, research §Open questions
 * 7), and a replayed log can hand us the same span twice regardless — so a span
 * we already hold is a no-op rather than a second bar in the waterfall. The
 * envelope bookkeeping above still counts the event, because the event really
 * did arrive; it is the *span* that is not duplicated.
 *
 * Deliberately does not touch `state.telemetry`. Spans carry tokens the money
 * layer already counts (prd9 ruling 4), so keeping them in their own slice is
 * what makes "a span-only state spends nothing" true by construction rather
 * than by every future selector remembering to exclude them. It also means the
 * lane and session indexes stay the money layer's own record of who was
 * spending, unpolluted by annotation.
 */
function traceSpan(state: SessionState, event: EventOf<'trace.span'>): SessionState {
  const p = event.payload
  const traces = state.traces
  const seen = traces.byTrace[p.traceId]
  if (seen !== undefined && seen.some((at) => traces.spans[at]?.spanId === p.spanId)) {
    return state
  }

  const record: SpanRecord = {
    eventId: event.id,
    ts: event.ts,
    lane: p.lane,
    role: p.role,
    thread: p.thread ?? null,
    sessionId: p.sessionId ?? null,
    worktreePath: p.worktreePath ?? null,
    branch: p.branch ?? null,
    traceId: p.traceId,
    spanId: p.spanId,
    parentSpanId: p.parentSpanId,
    name: p.name,
    kind: p.kind,
    startTs: p.startTs,
    endTs: p.endTs,
    status: p.status,
    model: p.model ?? null,
    tokens: p.tokens ?? null,
    ttftMs: p.ttftMs ?? null,
    requestId: p.requestId ?? null,
    agentId: p.agentId ?? null,
    parentAgentId: p.parentAgentId ?? null,
    toolName: p.toolName ?? null,
    toolUseId: p.toolUseId ?? null,
    subagentType: p.subagentType ?? null,
    decision: p.decision ?? null,
  }

  const at = traces.spans.length
  return {
    ...state,
    traces: {
      spans: [...traces.spans, record],
      byTrace: { ...traces.byTrace, [p.traceId]: [...(seen ?? []), at] },
      bySession:
        record.sessionId === null
          ? traces.bySession
          : {
              ...traces.bySession,
              [record.sessionId]: [...(traces.bySession[record.sessionId] ?? []), at],
            },
    },
  }
}

// --- helpers ----------------------------------------------------------------

function upsertBranch(
  state: SessionState,
  name: string,
  ts: number,
  update: (branch: BranchState) => BranchState,
): SessionState {
  const prev = state.branches[name] ?? stubBranch(name, ts)
  const branch = { ...update(prev), name, updatedAt: ts }
  return { ...state, branches: { ...state.branches, [name]: branch } }
}

function stubBranch(name: string, ts: number): BranchState {
  return {
    name,
    head: null,
    previousHead: null,
    worktreePath: null,
    aheadOfMain: null,
    behindMain: null,
    commits: [],
    firstSeenAt: ts,
    updatedAt: ts,
  }
}

/** A worktree we learned about sideways (dirty before discovery). */
function stubWorktree(path: string, ts: number): WorktreeState {
  return {
    path,
    name: basename(path),
    branch: null,
    head: null,
    isMain: false,
    detached: false,
    present: true,
    discoveredAt: ts,
    removedAt: null,
    dirtyFiles: [],
    dirtyUpdatedAt: null,
  }
}

/** A pane we learned about sideways (activity before discovery). */
function stubPane(paneId: string, ts: number): PaneState {
  return {
    paneId,
    sessionName: null,
    windowName: '',
    windowIndex: null,
    currentPath: null,
    currentCommand: null,
    worktreePath: null,
    present: true,
    discoveredAt: ts,
    closedAt: null,
    lastActivityTs: ts,
    lastContentChangeTs: null,
    contentHash: null,
    activityCount: 0,
    preview: null,
  }
}
