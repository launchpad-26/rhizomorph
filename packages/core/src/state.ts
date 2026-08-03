import type {
  AgentRole,
  AgentStatus,
  AgentThread,
  Author,
  DirtyFile,
  FileChange,
  SpanDecision,
  SpanKind,
  SpanStatus,
  TelemetryOrigin,
  TokenUsagePayload,
} from './events/index.js'

/**
 * The fold of an event log. Everything here is *recorded fact*, arranged for
 * lookup; anything derived (flatline, collisions, ahead-of-main) lives in
 * selectors so live view and replay compute it identically.
 */

export interface SessionInfo {
  sessionId: string
  repoPath: string
  repoName: string
  startedAt: number
}

export interface WorktreeState {
  /** Absolute path — the identity of a worktree. */
  path: string
  /** Basename, for display. */
  name: string
  branch: string | null
  head: string | null
  isMain: boolean
  detached: boolean
  /** False once `worktree.removed` has been seen; the record is kept for replay. */
  present: boolean
  discoveredAt: number
  removedAt: number | null
  /** Full current uncommitted set, replaced wholesale by each `worktree.dirty`. */
  dirtyFiles: DirtyFile[]
  dirtyUpdatedAt: number | null
}

export interface BranchState {
  name: string
  head: string | null
  previousHead: string | null
  worktreePath: string | null
  /** As reported by the git collector's merge-base maths, when available. */
  aheadOfMain: number | null
  behindMain: number | null
  /** Shas observed on this branch, in the order they were observed. */
  commits: string[]
  firstSeenAt: number
  updatedAt: number
}

export interface CommitRecord {
  sha: string
  /** A sha can land on several branches — e.g. when a branch merges to main. */
  branches: string[]
  message: string
  author: Author
  /** Author date when git reported it, else the time we saw it land. */
  authoredAt: number
  /** Envelope ts of the first sighting — the ticker's ordering key. */
  landedAt: number
  parents: string[]
  files: FileChange[]
  insertions: number | null
  deletions: number | null
  worktreePath: string | null
}

export interface PaneState {
  paneId: string
  sessionName: string | null
  windowName: string
  windowIndex: number | null
  currentPath: string | null
  currentCommand: string | null
  worktreePath: string | null
  present: boolean
  discoveredAt: number
  closedAt: number | null
  /**
   * Last sign of life: discovery, or any content-hash delta since. Liveness
   * measures against this, so a pane found seconds ago is not born flatlined.
   */
  lastActivityTs: number
  /** Last *content* change specifically — null for a pane that never moved. */
  lastContentChangeTs: number | null
  contentHash: string | null
  activityCount: number
  preview: string | null
}

export interface AgentState {
  handle: string
  status: AgentStatus
  previousStatus: AgentStatus | null
  worktreePath: string | null
  branch: string | null
  elapsedSeconds: number | null
  detail: string | null
  firstSeenAt: number
  updatedAt: number
}

export interface CollectorState {
  name: string
  /**
   * `degraded-retrying` and `healthy` are the resilience policy's honest
   * middle and recovered states (see `withResilience` in the server
   * package) — additive alongside the older `error`/`disabled`, which a
   * collector can still report directly for a one-off gripe unrelated to
   * its overall health.
   */
  status: 'error' | 'degraded-retrying' | 'disabled' | 'healthy'
  errorCount: number
  lastErrorTs: number | null
  lastErrorMessage: string | null
  /** Consecutive failures in the current retry/disable cycle; 0 once healthy. */
  consecutiveFailures: number
  disabledReason: string | null
  disabledAt: number | null
}

export interface ErrorRecord {
  eventId: string
  ts: number
  collector: string
  message: string
  detail: string | null
}

/**
 * One recorded model request. Kept whole, in observation order: rates over a
 * rolling window and a lane's replayable spend timeline both need the
 * individual facts, and every total in `selectors/spend.ts` is folded from
 * these rather than accumulated here — same rule as commits and collisions.
 */
export interface UsageRecord {
  eventId: string
  ts: number
  /** Which collector saw it — `sessionlog` (depth) or `otel` (authority). */
  origin: TelemetryOrigin
  lane: string
  role: AgentRole
  model: string
  tokens: TokenUsagePayload
  /** Sum of the four tiers, precomputed because everything sorts by it. */
  totalTokens: number
  requestId: string | null
  durationMs: number | null
  sessionId: string | null
  worktreePath: string | null
  branch: string | null
  /** Which thread of the session spent it; null when the source didn't say. */
  thread: AgentThread | null
}

/**
 * How a {@link CostRecord} learned the place (worktree/branch) it is booked
 * against.
 *
 * - `source` — the `llm.cost` event carried it. Sessionlog attribution is
 *   structural, so anything it emits lands here.
 * - `session-join` — the collector didn't know (every OTel cost event: audit
 *   §C, `parse-metrics.ts:145-146`) and the reducer filled it from another
 *   event sharing its `sessionId`, the documented join key.
 * - `null` — nothing to join against yet. The dollars stay visible under their
 *   lane with no branch; they are never guessed and never dropped.
 */
export type CostPlaceSource = 'source' | 'session-join'

export interface CostRecord {
  eventId: string
  ts: number
  origin: TelemetryOrigin
  lane: string
  role: AgentRole
  model: string
  costUsd: number
  /** True when the agent CLI computed the dollars, not us. */
  authoritative: boolean
  estimateSource: string | null
  requestId: string | null
  sessionId: string | null
  worktreePath: string | null
  branch: string | null
  /** Null while the dollars have no resolvable place. See {@link CostPlaceSource}. */
  placeSource: CostPlaceSource | null
  /** Which thread of the session spent it; null when the source didn't say. */
  thread: AgentThread | null
}

export interface ToolActivityRecord {
  eventId: string
  ts: number
  origin: TelemetryOrigin
  lane: string
  tool: string
  /** Null when the collector did not know the lane's role. */
  role: AgentRole | null
  durationMs: number | null
  sessionId: string | null
  worktreePath: string | null
  branch: string | null
  /** Which thread of the session ran it; null when the source didn't say. */
  thread: AgentThread | null
}

/**
 * What we have learned about a lane's identity, as opposed to its arithmetic.
 * Telemetry arrives with attribution on some events and not others (OTel has no
 * cwd), so the last non-null wins — the same shape as `agents`. Every number a
 * panel shows is derived by a selector; nothing is summed in here.
 */
export interface LaneAttribution {
  lane: string
  worktreePath: string | null
  branch: string | null
  /** Agent CLI session ids seen for this lane, in first-sighting order. */
  sessionIds: string[]
  firstSeenAt: number
  lastSeenAt: number
}

/**
 * Where an agent CLI session was running, learned from whichever telemetry
 * event happened to know. This is the index that makes dollars reach a branch:
 * OTel cost events carry a `sessionId` and no place, sessionlog usage carries
 * both, and `sessionId` is the documented join key between the two collectors
 * (`events/telemetry.ts`). Keyed by session id, not by lane — the same session
 * can be reported under two different lane handles by the two collectors,
 * which is exactly the case a lane-keyed index cannot join.
 *
 * Last non-null wins, same rule as {@link LaneAttribution}: a place is learned
 * once and never unlearned by a later event that simply didn't know it.
 */
export interface SessionPlace {
  sessionId: string
  worktreePath: string | null
  branch: string | null
  firstSeenAt: number
  lastSeenAt: number
}

export interface TelemetryState {
  usage: UsageRecord[]
  costs: CostRecord[]
  tools: ToolActivityRecord[]
  lanes: Record<string, LaneAttribution>
  /** Session id → where it ran. See {@link SessionPlace}. */
  sessions: Record<string, SessionPlace>
}

export function initialTelemetryState(): TelemetryState {
  return { usage: [], costs: [], tools: [], lanes: {}, sessions: {} }
}

/**
 * One span of an agent CLI's trace export, kept whole and in observation order —
 * the same rule the telemetry records follow. Nothing is accumulated: a trace's
 * duration, its token sum, how long a lane sat blocked, are all subtraction a
 * selector does, so live and replay cannot disagree about them.
 *
 * Fields mirror `trace.span`'s payload one for one (`events/trace.ts`), with
 * the optionals normalised to `null`. The allowlist is the payload's, and this
 * record adds nothing to it: no attributes map reaches state because none
 * reaches the event.
 */
export interface SpanRecord {
  eventId: string
  /** Envelope ts — when we RECEIVED the span, which is after `endTs`. */
  ts: number
  lane: string
  role: AgentRole
  thread: AgentThread | null
  sessionId: string | null
  worktreePath: string | null
  branch: string | null
  traceId: string
  spanId: string
  parentSpanId: string | null
  /** Raw, as the CLI emitted it. {@link kind} is what surfaces should read. */
  name: string
  kind: SpanKind
  startTs: number
  endTs: number
  status: SpanStatus
  model: string | null
  /**
   * Annotation only. prd9 ruling 4: these duplicate what the money layer
   * already counts, so no spend selector reads this slice.
   */
  tokens: TokenUsagePayload | null
  ttftMs: number | null
  /** May JOIN a spend record for enrichment; may never create one. */
  requestId: string | null
  agentId: string | null
  parentAgentId: string | null
  toolName: string | null
  toolUseId: string | null
  subagentType: string | null
  decision: SpanDecision | null
}

/**
 * prd9's trace slice. Spans in the order they arrived, plus the two lookups
 * every future selector starts from — a trace's own spans (the waterfall) and a
 * session's spans across however many traces it produced (the capture showed
 * background requests landing in traces of their own).
 *
 * The indexes hold POSITIONS in {@link spans}, not copies: spans are only ever
 * appended, so a position is stable for the life of the fold, and there is
 * exactly one copy of each record to reason about.
 */
export interface TraceState {
  spans: SpanRecord[]
  /** traceId → positions in `spans`, in observation order. */
  byTrace: Record<string, number[]>
  /** sessionId → positions in `spans`. Spans with no session id are not indexed here. */
  bySession: Record<string, number[]>
}

export function initialTraceState(): TraceState {
  return { spans: [], byTrace: {}, bySession: {} }
}

export interface SessionState {
  session: SessionInfo | null
  /** Branch everything is measured against; null until we learn it. */
  mainBranch: string | null
  worktrees: Record<string, WorktreeState>
  branches: Record<string, BranchState>
  commits: Record<string, CommitRecord>
  /** Shas in first-sighting order — the commit ticker reads this. */
  commitOrder: string[]
  panes: Record<string, PaneState>
  agents: Record<string, AgentState>
  collectors: Record<string, CollectorState>
  /** Most recent last, capped — a long session must not grow unbounded. */
  errors: ErrorRecord[]
  /** prd1: tokens, dollars and tool calls. Additive — nothing above changed. */
  telemetry: TelemetryState
  /** prd9: the span tree. Additive again, and read by no spend selector. */
  traces: TraceState
  eventCount: number
  firstEventTs: number | null
  lastEventTs: number | null
}

/** How many collector errors to keep. Older ones fall off the back. */
export const MAX_ERRORS = 200

export function initialSessionState(): SessionState {
  return {
    session: null,
    mainBranch: null,
    worktrees: {},
    branches: {},
    commits: {},
    commitOrder: [],
    panes: {},
    agents: {},
    collectors: {},
    errors: [],
    telemetry: initialTelemetryState(),
    traces: initialTraceState(),
    eventCount: 0,
    firstEventTs: null,
    lastEventTs: null,
  }
}

/** Basename without pulling in node:path — this module runs in the browser too. */
export function basename(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? path
}
