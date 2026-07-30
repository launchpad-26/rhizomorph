import type {
  AgentRole,
  AgentStatus,
  Author,
  DirtyFile,
  FileChange,
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
  status: 'error' | 'disabled'
  errorCount: number
  lastErrorTs: number | null
  lastErrorMessage: string | null
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
}

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

export interface TelemetryState {
  usage: UsageRecord[]
  costs: CostRecord[]
  tools: ToolActivityRecord[]
  lanes: Record<string, LaneAttribution>
}

export function initialTelemetryState(): TelemetryState {
  return { usage: [], costs: [], tools: [], lanes: {} }
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
