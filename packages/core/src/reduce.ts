import type {
  EventOf,
  ObservatoryEvent,
} from './events/index.js'
import { totalTokens } from './events/index.js'
import type {
  AgentState,
  BranchState,
  CollectorState,
  CommitRecord,
  CostRecord,
  ErrorRecord,
  LaneAttribution,
  PaneState,
  SessionState,
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
export function reduce(state: SessionState, event: ObservatoryEvent): SessionState {
  return applyEvent(withEnvelope(state, event), event)
}

/** Fold a whole log. Handy for replay slices and for tests. */
export function reduceAll(
  events: readonly ObservatoryEvent[],
  state: SessionState = initialSessionState(),
): SessionState {
  return events.reduce(reduce, state)
}

function withEnvelope(state: SessionState, event: ObservatoryEvent): SessionState {
  return {
    ...state,
    eventCount: state.eventCount + 1,
    firstEventTs: state.firstEventTs ?? event.ts,
    lastEventTs: state.lastEventTs === null ? event.ts : Math.max(state.lastEventTs, event.ts),
  }
}

function applyEvent(state: SessionState, event: ObservatoryEvent): SessionState {
  switch (event.type) {
    case 'session.started':
      return sessionStarted(state, event)
    case 'collector.error':
      return collectorError(state, event)
    case 'collector.disabled':
      return collectorDisabled(state, event)
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
  const { collector, reason } = event.payload
  const prev = state.collectors[collector]
  const record: CollectorState = {
    name: collector,
    status: 'disabled',
    errorCount: prev?.errorCount ?? 0,
    lastErrorTs: prev?.lastErrorTs ?? null,
    lastErrorMessage: prev?.lastErrorMessage ?? null,
    disabledReason: reason,
    disabledAt: event.ts,
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
 * Events with no `requestId` (every OTel usage event today — see the comment
 * on `parse-metrics.ts`'s `buildUsageEvent`) always append; they have no
 * identity to dedup against, including each other.
 *
 * The match requires a *different* origin on purpose — this issue is
 * cross-collector dedup, not a general one-request-per-id constraint. A
 * collector re-emitting its own id (e.g. an overlapping resume window) is a
 * separate collector-level concern; folding same-origin records here would
 * risk hiding that bug instead of surfacing it.
 */
function dedupedUsage(usage: readonly UsageRecord[], incoming: UsageRecord): UsageRecord[] {
  if (incoming.requestId === null) return [...usage, incoming]
  const index = usage.findIndex(
    (existing) => existing.requestId === incoming.requestId && existing.origin !== incoming.origin,
  )
  if (index === -1) return [...usage, incoming]
  const next = usage.slice()
  next[index] = foldUsage(usage[index]!, incoming)
  return next
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
  }
}

function llmCost(state: SessionState, event: EventOf<'llm.cost'>): SessionState {
  const p = event.payload
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
    worktreePath: p.worktreePath ?? null,
    branch: p.branch ?? null,
  }
  return withTelemetry(state, event, p, (telemetry) => ({
    ...telemetry,
    costs: [...telemetry.costs, record],
  }))
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
 * Appends a telemetry record and keeps the lane index in step. Attribution is
 * last-non-null-wins: OTel datapoints carry no cwd, so a lane's worktree may
 * only ever be learned from the sessionlog side and must not be unlearned.
 */
function withTelemetry(
  state: SessionState,
  event: ObservatoryEvent,
  attribution: TelemetryAttribution,
  append: (telemetry: TelemetryState) => TelemetryState,
): SessionState {
  const appended = append(state.telemetry)
  return {
    ...state,
    telemetry: {
      ...appended,
      lanes: {
        ...appended.lanes,
        [attribution.lane]: upsertLane(
          appended.lanes[attribution.lane],
          attribution,
          event.ts,
        ),
      },
    },
  }
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
