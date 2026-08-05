import type {
  EventOf,
  RhizomorphEvent,
} from './events/index.js'
import { totalTokens } from './events/index.js'
import type {
  ActiveTimeRecord,
  AgentState,
  BranchState,
  CheckpointRecord,
  CollectorState,
  CommitRecord,
  CostPlaceSource,
  CostRecord,
  ErrorRecord,
  ForkDispatchRecord,
  JudgeFindingRecord,
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
import { MAX_ERRORS, basename, initialSessionState, traceStateOf } from './state.js'

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
    case 'branch.removed':
      return branchRemoved(state, event)
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
    case 'agent.activeTime':
      return agentActiveTime(state, event)
    case 'telemetry.refused':
      // A refusal is a setup gap, not spend: it stays in the log (and on the
      // stream) for the UI to surface, and contributes nothing to any total.
      // #62 gives it a home in state.
      return state
    case 'trace.span':
      return traceSpan(state, event)
    case 'fork.checkpoint':
      return forkCheckpoint(state, event)
    case 'fork.dispatched':
      return forkDispatched(state, event)
    case 'judge.finding':
      return judgeFinding(state, event)
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

/**
 * The ghost fix: a branch gone from `for-each-ref` is dropped from
 * `state.branches` outright, not just flagged absent. Unlike worktrees and
 * panes, nothing downstream filters on a branch's presence — the collision
 * matrix's committed-touch pass walks every entry in this map — so a record
 * kept around with a `present: false` flag would keep comparing a ghost
 * against live branches forever. `state.commits` is untouched: the work that
 * landed is still history, only the live branch pointing at it is gone.
 */
function branchRemoved(state: SessionState, event: EventOf<'branch.removed'>): SessionState {
  const { branch } = event.payload
  if (state.branches[branch] === undefined) return state
  const branches = { ...state.branches }
  delete branches[branch]
  return { ...state, branches }
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
    // Present only when true, and once present never removed: a status poll
    // cannot un-fork a lane, and an ordinary lane's record is untouched.
    ...(prev?.synthetic === true || isSyntheticLane(state, p.handle) ? { synthetic: true as const } : {}),
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

// --- the usage index (#179) -------------------------------------------------

/**
 * The fold's lookup tables over `telemetry.usage`.
 *
 * #174's bench confirmed the audit's P2 finding by measurement: the three
 * questions the usage fold asks were each answered by re-scanning the whole
 * usage array, once per `llm.usage` event (~10.4k/day), so a 55k-event boot
 * recovery cost eleven seconds and the cost per event grew with the session
 * instead of staying flat. The questions are:
 *
 * - {@link dedupedUsage}: is there a record with this `requestId` from the
 *   *other* collector? (`findIndex` over everything)
 * - {@link foldSessionCoverage}: has this session any `sessionlog` usage at
 *   all? (`some` over everything)
 * - {@link foldSessionCoverage}: has this session any request-less OTel usage
 *   to retire? (`filter` over everything, on every sessionlog record)
 *
 * All three are O(1) here, and the answers are identical to the scans' —
 * `byRequest` holds positions in ascending order, so the first cross-origin
 * hit in it is the same record `findIndex` returned.
 *
 * **Why this is derived rather than a field on `TelemetryState`.** Three
 * reasons, in the order they bind:
 *
 * 1. *The identity law.* A state's index must be exactly the index of that
 *    state's own records — live and replay fold through this function, so any
 *    divergence is a wrong ledger. Carried as a field, the table would have to
 *    be updated immutably, and an immutable update of a `requestId`-keyed map
 *    copies every key on every event: the same quadratic in a different
 *    costume. Mutating a field in place instead would make `reduce` impure and
 *    break the "the input state is untouched" law directly.
 * 2. *`TelemetryState`'s shape is itself a law.* Its additivity oracle
 *    (`reduce.telemetry.test.ts`) asserts the slice equals exactly its six
 *    recorded-fact keys, and `state.ts`'s own header says everything there is
 *    recorded fact. A lookup table recomputable from `usage` is not a fact the
 *    log recorded; it is an accelerator, and it says so by living here.
 * 3. *Derivation is checkable.* {@link buildUsageIndex} is a pure function of
 *    the array, and the fold's output is byte-identical whether a table is
 *    inherited or rebuilt from scratch — the law `reduce.test.ts` pins under
 *    "the index is an accelerator, never an input".
 *
 * **Ownership.** Keyed by the usage array's own identity, so a table can never
 * be read against an array it does not describe. {@link takeUsageIndex}
 * *detaches* the table before the fold mutates it into the successor array's
 * table: a second fold branching off the same state finds nothing attached and
 * rebuilds its own, rather than reading one that has moved on. That is what
 * makes this safe under the branching folds replay does — and the WeakMap
 * keying means a table dies with the array it indexes.
 */
interface UsageIndex {
  /** `requestId` → positions in `usage` holding it, in ascending order. */
  byRequest: Map<string, number[]>
  /** Session ids with at least one `sessionlog` usage record. */
  sessionlogSessions: Set<string>
  /** Session id → how many request-less OTel records it currently holds. */
  requestlessOtelBySession: Map<string, number>
}

const usageIndexes = new WeakMap<readonly UsageRecord[], UsageIndex>()

/** The table `usage` would have if nothing had ever been carried forward. */
function buildUsageIndex(usage: readonly UsageRecord[]): UsageIndex {
  const index: UsageIndex = {
    byRequest: new Map(),
    sessionlogSessions: new Set(),
    requestlessOtelBySession: new Map(),
  }
  for (let at = 0; at < usage.length; at += 1) indexUsageRecord(index, usage[at]!, at)
  return index
}

/** Folds one record's positions into `index`. The only writer of new entries. */
function indexUsageRecord(index: UsageIndex, record: UsageRecord, at: number): void {
  if (record.requestId !== null) {
    const positions = index.byRequest.get(record.requestId)
    if (positions === undefined) index.byRequest.set(record.requestId, [at])
    else positions.push(at)
  }
  if (record.sessionId === null) return
  if (record.origin === 'sessionlog') {
    index.sessionlogSessions.add(record.sessionId)
  } else if (record.origin === 'otel' && record.requestId === null) {
    const held = index.requestlessOtelBySession.get(record.sessionId) ?? 0
    index.requestlessOtelBySession.set(record.sessionId, held + 1)
  }
}

/** Detaches `usage`'s table for the caller to carry forward, or builds one. */
function takeUsageIndex(usage: readonly UsageRecord[]): UsageIndex {
  const held = usageIndexes.get(usage)
  if (held === undefined) return buildUsageIndex(usage)
  usageIndexes.delete(usage)
  return held
}

/** Attaches `index` to the array it now describes, and returns that array. */
function indexed(usage: readonly UsageRecord[], index: UsageIndex): UsageRecord[] {
  usageIndexes.set(usage, index)
  return usage as UsageRecord[]
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
 *
 * The scan this used to be is now a lookup in {@link UsageIndex}; the rule it
 * implements is unchanged, down to which of several same-id records wins.
 */
function dedupedUsage(usage: readonly UsageRecord[], incoming: UsageRecord): UsageRecord[] {
  const index = takeUsageIndex(usage)
  const at = incoming.requestId === null ? -1 : crossOriginMatch(usage, index, incoming.requestId, incoming.origin)
  if (at !== -1) {
    const next = usage.slice()
    const folded = foldUsage(usage[at]!, incoming)
    next[at] = folded
    // A fold keeps the record's position and its `requestId` (both sides
    // matched on it), so `byRequest` still holds. What it can change is which
    // collector the record now counts as: sessionlog wins, so a session can
    // gain sessionlog coverage here but never lose it — and neither side of a
    // `requestId` match was ever request-less, so the OTel tally is untouched.
    if (folded.origin === 'sessionlog' && folded.sessionId !== null) {
      index.sessionlogSessions.add(folded.sessionId)
    }
    return indexed(next, index)
  }
  return foldSessionCoverage(usage, incoming, index)
}

/**
 * The position of the first record carrying `requestId` from a *different*
 * collector than `origin`, or -1 — exactly what the `findIndex` this replaced
 * returned, because positions are recorded in the order they were appended.
 */
function crossOriginMatch(
  usage: readonly UsageRecord[],
  index: UsageIndex,
  requestId: string,
  origin: UsageRecord['origin'],
): number {
  const positions = index.byRequest.get(requestId)
  if (positions === undefined) return -1
  for (const at of positions) {
    if (usage[at]!.origin !== origin) return at
  }
  return -1
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
function foldSessionCoverage(
  usage: readonly UsageRecord[],
  incoming: UsageRecord,
  index: UsageIndex,
): UsageRecord[] {
  if (incoming.sessionId === null) return appendUsage(usage, incoming, index)

  if (incoming.requestId === null && incoming.origin === 'otel') {
    // Was `usage.some(...)`; the set holds exactly the sessions that `some`
    // would have found a sessionlog record for.
    if (index.sessionlogSessions.has(incoming.sessionId)) return indexed(usage, index)
  }

  if (incoming.origin === 'sessionlog') {
    // Was an unconditional `usage.filter(...)` whose result was thrown away
    // whenever it removed nothing — which is every event but the first one
    // per session. The tally says whether there is anything to remove before
    // a single record is touched.
    if ((index.requestlessOtelBySession.get(incoming.sessionId) ?? 0) > 0) {
      const withoutStaleOtel = usage.filter(
        (existing) =>
          !(
            existing.origin === 'otel' &&
            existing.requestId === null &&
            existing.sessionId === incoming.sessionId
          ),
      )
      const next = [...withoutStaleOtel, incoming]
      // Removal is the one move that shifts positions, so the successor gets a
      // table built from itself rather than a patched one. It happens at most
      // once per session — the retirement that made it necessary is also what
      // makes the session covered from here on.
      return indexed(next, buildUsageIndex(next))
    }
  }

  return appendUsage(usage, incoming, index)
}

/** Appends one record and carries `index` forward to the new array. */
function appendUsage(
  usage: readonly UsageRecord[],
  incoming: UsageRecord,
  index: UsageIndex,
): UsageRecord[] {
  indexUsageRecord(index, incoming, usage.length)
  return indexed([...usage, incoming], index)
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
    filePath: p.filePath ?? null,
    toolUseId: p.toolUseId ?? null,
  }
  return withTelemetry(state, event, p, (telemetry) => ({
    ...telemetry,
    tools: [...telemetry.tools, record],
  }))
}

/**
 * The active-time counter, kept whole (#141). No accumulation happens here —
 * a reading can be lower than the last one the same session sent (a restart
 * reset the counter to zero), so summing at fold time would silently corrupt
 * the record. `selectors/activity.ts` is where the honest fold — max reading
 * per session, then summed per lane — happens, on read.
 */
function agentActiveTime(state: SessionState, event: EventOf<'agent.activeTime'>): SessionState {
  const p = event.payload
  const record: ActiveTimeRecord = {
    eventId: event.id,
    ts: event.ts,
    origin: event.source,
    lane: p.lane,
    role: p.role,
    activeSeconds: p.activeSeconds,
    sessionId: p.sessionId ?? null,
    worktreePath: p.worktreePath ?? null,
    branch: p.branch ?? null,
    thread: p.thread ?? null,
  }
  return withTelemetry(state, event, p, (telemetry) => ({
    ...telemetry,
    activeTime: [...telemetry.activeTime, record],
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
 *
 * **The catch-up runs only when there is something to catch up with (#179).**
 * It used to re-map every cost and walk every lane on *every* telemetry event
 * — 55k times over a day's session, to fill in nothing. Reconciliation is a
 * fixpoint: once it has run for a session's place, running it again with the
 * same place cannot move a record, because the only two things that could have
 * changed since are (a) a new cost for that session, which
 * {@link resolvePlace} already placed from the same session index at arrival,
 * and (b) the lane this event just touched. So the full sweep is gated on the
 * place actually moving, and the quiet case reconsiders that one lane and
 * nothing else. Same result, no scan.
 */
function withTelemetry(
  state: SessionState,
  event: RhizomorphEvent,
  attribution: TelemetryAttribution,
  append: (telemetry: TelemetryState) => TelemetryState,
): SessionState {
  const appended = append(state.telemetry)
  const sessionId = attribution.sessionId ?? null
  const before = sessionId === null ? undefined : appended.sessions[sessionId]
  const sessions = upsertSessionPlace(appended.sessions, attribution, event.ts)
  const place = sessionId === null ? undefined : sessions[sessionId]
  const lanes = {
    ...appended.lanes,
    [attribution.lane]: upsertLane(
      appended.lanes[attribution.lane],
      attribution,
      event.ts,
      isSyntheticLane(state, attribution.lane),
    ),
  }
  const moved = placeMoved(before, place)
  return {
    ...state,
    telemetry: {
      ...appended,
      costs: moved ? placeCosts(appended.costs, place) : appended.costs,
      lanes: placeLanes(lanes, place, moved ? null : attribution.lane),
      sessions,
    },
  }
}

/**
 * Whether this event taught the session a place it did not already have.
 * First sighting counts as a move; a place that repeats what we knew does not,
 * and the timestamps a repeat does update place nothing.
 *
 * The first-sighting branch is deliberately belt-and-braces: at a session's
 * first sighting there is nothing recorded under it yet, so the sweep it lets
 * through is empty and no test can tell it from `false`. It stays because this
 * predicate should say what "moved" means, not what happens to be reachable
 * today — the day something can be booked against a session before its first
 * telemetry event, this is already right.
 */
function placeMoved(before: SessionPlace | undefined, place: SessionPlace | undefined): boolean {
  if (place === undefined) return false
  if (before === undefined) return true
  return before.worktreePath !== place.worktreePath || before.branch !== place.branch
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
 *
 * `only` narrows the sweep to a single handle: when the session's place did not
 * move, that lane is the only one whose own record changed this event, so it is
 * the only one that can have a null this place would fill (#179). Passing
 * `null` sweeps every lane, which is what a place that just moved requires.
 * Allocates a copy only if something actually moves.
 */
function placeLanes(
  lanes: Readonly<Record<string, LaneAttribution>>,
  place: SessionPlace | undefined,
  only: string | null,
): Record<string, LaneAttribution> {
  if (place === undefined) return lanes
  if (place.worktreePath === null && place.branch === null) return lanes
  let next: Record<string, LaneAttribution> | null = null
  for (const name of only === null ? Object.keys(lanes) : [only]) {
    const lane = lanes[name]
    if (lane === undefined) continue
    if (lane.worktreePath !== null && lane.branch !== null) continue
    if (!lane.sessionIds.includes(place.sessionId)) continue
    const worktreePath = lane.worktreePath ?? place.worktreePath
    const branch = lane.branch ?? place.branch
    if (worktreePath === lane.worktreePath && branch === lane.branch) continue
    next ??= { ...lanes }
    next[name] = { ...lane, worktreePath, branch }
  }
  return next ?? lanes
}

function upsertLane(
  prev: LaneAttribution | undefined,
  p: TelemetryAttribution,
  ts: number,
  synthetic: boolean,
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
    // Present only when true, never removed — see AgentState.synthetic.
    ...(prev?.synthetic === true || synthetic ? { synthetic: true as const } : {}),
  }
}

// --- traces (prd9) ----------------------------------------------------------

/**
 * The fold's lookup table over `traces.spans` (#184), and the sequel to
 * {@link UsageIndex} across prd9's slice.
 *
 * #179's re-measurement found that after its own fix landed, ~90% of what was
 * left of the full-mix fold was one line of {@link traceSpan}:
 * `{ ...traces.byTrace, [traceId]: [...] }` — an immutable insert into a
 * Record that gains a key per trace, so every span event copied every key the
 * session had accumulated. Standalone that line cost 50 / 518 / 2,367 / 8,866
 * ms at N = 5k / 15k / 30k / 55k: eleven seconds of a day-long session's boot
 * recovery, and the dominant term in the replay index build.
 *
 * The fix is the same shape as #179's, in two halves:
 *
 * 1. `byTrace`/`bySession` stopped being *accumulated* and became what they
 *    always were mathematically — a projection of `spans`, materialised on
 *    demand by {@link traceStateOf}. `TraceState` keeps all three keys, the
 *    same values and the same bytes; nothing was moved out of recorded state,
 *    so prd9's contract, its additivity oracle and every trace selector stand
 *    untouched. That is deliberate: the key set is pinned by an oracle this
 *    lane may only strengthen, and it turned out not to need loosening.
 * 2. What the fold *asks* per event — "has this trace already delivered this
 *    span id?" — is answered here instead, in O(1), by a table that is carried
 *    forward rather than copied.
 *
 * **Ownership**, exactly as {@link UsageIndex} states it: keyed by the
 * identity of the spans array it describes, so it can never be read against
 * an array it does not match; and {@link takeTraceIndex} *detaches* it, so a
 * second fold branching off the same state finds nothing attached and rebuilds
 * its own rather than reading one that has moved on. An index attached to an
 * array always describes exactly that array — that invariant is the whole
 * safety argument, and `reduce.test.ts` holds the fold to it by folding one
 * log both ways and demanding the same bytes.
 *
 * **Why a `Set` per trace rather than one set of joined keys.** A `traceId`
 * and a `spanId` are opaque strings from another process's exporter; joining
 * them with a separator invents a collision that the pair itself does not
 * have. The nesting is the same identity {@link traceSpan} has always keyed
 * on, spelled without a separator to get wrong.
 */
type TraceIndex = Map<string, Set<string>>

const traceIndexes = new WeakMap<readonly SpanRecord[], TraceIndex>()

/** The table `spans` would have if nothing had ever been carried forward. */
function buildTraceIndex(spans: readonly SpanRecord[]): TraceIndex {
  const index: TraceIndex = new Map()
  for (const span of spans) indexSpanRecord(index, span)
  return index
}

/** Folds one span's identity into `index`. The only writer of new entries. */
function indexSpanRecord(index: TraceIndex, span: SpanRecord): void {
  const held = index.get(span.traceId)
  if (held === undefined) index.set(span.traceId, new Set([span.spanId]))
  else held.add(span.spanId)
}

/** Detaches `spans`' table for the caller to carry forward, or builds one. */
function takeTraceIndex(spans: readonly SpanRecord[]): TraceIndex {
  const held = traceIndexes.get(spans)
  if (held === undefined) return buildTraceIndex(spans)
  traceIndexes.delete(spans)
  return held
}

/** Attaches `index` to the array it now describes, and returns that array. */
function indexedSpans(spans: SpanRecord[], index: TraceIndex): SpanRecord[] {
  traceIndexes.set(spans, index)
  return spans
}

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
 *
 * The idempotence check reads {@link TraceIndex} rather than `byTrace`, and
 * that is not an optimisation detail: reading `byTrace` here would materialise
 * the whole projection once per event, which is the copy-per-event this issue
 * removed, wearing a different hat. The fold writes the spans array; the
 * projection is for whoever reads the slice.
 */
function traceSpan(state: SessionState, event: EventOf<'trace.span'>): SessionState {
  const p = event.payload
  const traces = state.traces
  const index = takeTraceIndex(traces.spans)
  if (index.get(p.traceId)?.has(p.spanId) === true) {
    // Nothing to fold, but the table was taken — give it back to the array it
    // still describes, so the next span does not pay to rebuild it.
    indexedSpans(traces.spans, index)
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

  indexSpanRecord(index, record)
  return {
    ...state,
    traces: traceStateOf(indexedSpans([...traces.spans, record], index)),
  }
}

// --- lab (prd12) --------------------------------------------------------------

function forkCheckpoint(state: SessionState, event: EventOf<'fork.checkpoint'>): SessionState {
  const p = event.payload
  const record: CheckpointRecord = {
    eventId: event.id,
    ts: event.ts,
    lane: p.lane,
    checkpointId: p.checkpointId,
    eventIndex: p.eventIndex,
    sessionFile: p.sessionFile,
    sessionCutByte: p.sessionCutByte,
    sessionDigest: p.sessionDigest,
    snapshotRef: p.snapshotRef,
    snapshotSha: p.snapshotSha,
    headSha: p.headSha,
    capturedBy: p.capturedBy,
  }

  const checkpoints = state.checkpoints
  const at = checkpoints.records.length
  return {
    ...state,
    checkpoints: {
      records: [...checkpoints.records, record],
      byLane: { ...checkpoints.byLane, [p.lane]: [...(checkpoints.byLane[p.lane] ?? []), at] },
    },
  }
}

/**
 * prd12 ruling 3: an arm's dispatch, kept whole — and the ONLY thing that
 * marks a lane synthetic. There is no separate flag an emitter could forget:
 * a lane is a fork exactly when the log says an arm was dispatched under its
 * handle.
 *
 * The mark is applied in both directions so the fold is order-independent.
 * Forward: an `agent.status` or a telemetry event arriving after this one
 * reads `forks.byLane` and is born synthetic ({@link isSyntheticLane}).
 * Backward: a record already folded under this handle — a replay whose
 * collector saw the pane before the operator's dispatch line was recorded —
 * is marked here. Neither direction ever unsets the flag.
 */
function forkDispatched(state: SessionState, event: EventOf<'fork.dispatched'>): SessionState {
  const p = event.payload
  const record: ForkDispatchRecord = {
    eventId: event.id,
    ts: event.ts,
    forkId: p.forkId,
    parentLane: p.parentLane,
    checkpointId: p.checkpointId,
    arm: p.arm,
    model: p.treatment.model,
    promptDigest: p.treatment.promptDigest,
    laneHandle: p.laneHandle,
    worktreePath: p.worktreePath,
  }

  const forks = state.forks
  const at = forks.dispatches.length
  const withDispatch: SessionState = {
    ...state,
    forks: {
      dispatches: [...forks.dispatches, record],
      byFork: { ...forks.byFork, [p.forkId]: [...(forks.byFork[p.forkId] ?? []), at] },
      byLane: { ...forks.byLane, [p.laneHandle]: [...(forks.byLane[p.laneHandle] ?? []), at] },
    },
  }

  return markLaneSynthetic(withDispatch, p.laneHandle)
}

/** Retro-marks whatever this handle has already folded to. Absent records need nothing: they are born marked. */
function markLaneSynthetic(state: SessionState, laneHandle: string): SessionState {
  const agent = state.agents[laneHandle]
  const lane = state.telemetry.lanes[laneHandle]
  if (agent === undefined && lane === undefined) return state

  return {
    ...state,
    agents: agent === undefined ? state.agents : { ...state.agents, [laneHandle]: { ...agent, synthetic: true } },
    telemetry:
      lane === undefined
        ? state.telemetry
        : { ...state.telemetry, lanes: { ...state.telemetry.lanes, [laneHandle]: { ...lane, synthetic: true } } },
  }
}

/** True once a `fork.dispatched` has named this handle. The forward half of {@link markLaneSynthetic}. */
function isSyntheticLane(state: SessionState, laneHandle: string): boolean {
  return state.forks.byLane[laneHandle] !== undefined
}

// --- judge (prd11 ruling 6b) --------------------------------------------------

/**
 * Appends a finding whole and indexes it under BOTH of its lanes — unlike
 * every other per-lane record here, a finding is inherently about a pair, so
 * either lane's page/drawer should be able to find it in its own history.
 */
function judgeFinding(state: SessionState, event: EventOf<'judge.finding'>): SessionState {
  const p = event.payload
  const record: JudgeFindingRecord = {
    eventId: event.id,
    ts: event.ts,
    kind: p.kind,
    lanes: p.lanes,
    evidence: p.evidence,
    severity: p.severity,
    detectedAt: p.detectedAt,
  }

  const judge = state.judge
  const at = judge.findings.length
  let byLane = judge.byLane
  for (const lane of p.lanes) {
    byLane = { ...byLane, [lane]: [...(byLane[lane] ?? []), at] }
  }

  return { ...state, judge: { findings: [...judge.findings, record], byLane } }
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
