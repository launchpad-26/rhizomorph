import type {
  AgentRole,
  AgentStatus,
  AgentThread,
  Author,
  DirtyFile,
  FileChange,
  ForkCheckpointCapturedBy,
  JudgeEvidence,
  JudgeFindingKind,
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
  /**
   * prd12 ruling 3: present and `true` exactly when this handle is a fork arm
   * — set by the existence of a `fork.dispatched` naming it, and never unset.
   *
   * Optional-and-only-ever-`true`, not `boolean`, because the ruling's
   * additivity is literal: a lane the observer discovered folds to the same
   * object it folded to before this field existed, key-for-key. A reader asks
   * `agent.synthetic === true`; nothing has to be backfilled, and no replay of
   * an older log changes shape. A fork's spend is real spend; this flag says
   * whose reality it was spent in, and nothing else.
   */
  synthetic?: true
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
  /** prd11 ruling 1/2: where the tool touched. Null for non-file tools (Bash) and pre-prd11 events. */
  filePath: string | null
  /** prd11 ruling 1/2: the join key to `trace.span.toolUseId`. Null when the source didn't carry one. */
  toolUseId: string | null
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
  /** prd12 ruling 3 — see {@link AgentState.synthetic}. Same flag, same absent-unless-true rule, the ledger's side of it. */
  synthetic?: true
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

/**
 * One reading of OTel's `claude_code.active_time.total` counter, kept whole —
 * same rule as {@link UsageRecord} and {@link CostRecord}. `activeSeconds` is
 * the raw cumulative value the export carried; nothing here sums readings
 * together, because the counter can reset mid-session and only a selector
 * that knows to watch for that (`selectors/activity.ts`) can fold it honestly.
 */
export interface ActiveTimeRecord {
  eventId: string
  ts: number
  /** Always `otel` today — no other collector produces this metric. */
  origin: TelemetryOrigin
  lane: string
  role: AgentRole
  activeSeconds: number
  sessionId: string | null
  worktreePath: string | null
  branch: string | null
  /** Which thread of the session this reading belongs to; null when the source didn't say. */
  thread: AgentThread | null
}

/**
 * The money layer's records and the two indexes the *fold* keeps in step —
 * `lanes` and `sessions` are recorded fact (who spent, and where they ran),
 * learned from events and readable by any surface.
 *
 * **These six keys are the whole slice, and that is a law** (#179). The fold's
 * own lookup tables — "which record holds this `requestId`", "has this session
 * any sessionlog usage" — are *not* here and must not move here. They are
 * derived: recomputable from `usage` alone, invisible to every selector, and
 * carried beside the reducer instead (`UsageIndex` in `reduce.ts`, where the
 * argument is written out in full). Two reasons in one sentence: an index
 * carried as immutable state costs a copy of every key on every event, which
 * is the quadratic #174 measured wearing a different hat; and a slice whose
 * header promises recorded fact should not start holding an accelerator that
 * no event ever recorded. `state.test.ts` pins the key set, `reduce.test.ts`
 * pins the property that makes the split safe — the fold's output cannot tell
 * whether a table was inherited or rebuilt from scratch.
 */
export interface TelemetryState {
  usage: UsageRecord[]
  costs: CostRecord[]
  tools: ToolActivityRecord[]
  /** #141: OTel's active-time counter, one entry per reading. */
  activeTime: ActiveTimeRecord[]
  lanes: Record<string, LaneAttribution>
  /** Session id → where it ran. See {@link SessionPlace}. */
  sessions: Record<string, SessionPlace>
}

/**
 * A fresh slice, with fresh containers, on every call — never a shared empty
 * singleton. Two folds started independently must not begin life holding the
 * same array: the fold's lookup tables are keyed by the identity of the array
 * they describe (#179), so a shared `[]` would hand one fold's table to
 * another. `state.test.ts` holds this to it.
 */
export function initialTelemetryState(): TelemetryState {
  return { usage: [], costs: [], tools: [], activeTime: [], lanes: {}, sessions: {} }
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
 *
 * **The three keys are the slice, and that is a law** — `state.test.ts` pins
 * the key set, `reduce.telemetry.test.ts`'s additivity oracle pins it again
 * from the far end, and #184 did not move it. What #184 changed is *when* the
 * two indexes are built. They are a **projection of `spans`** — one position
 * per span, in span order, computable from `spans` and nothing else — so the
 * fold no longer keeps them by copying a Record per event. It hands out the
 * spans array and lets {@link traceStateOf} materialise a projection the first
 * time somebody asks for one. Every reader sees the same keys, the same
 * values, the same `JSON.stringify` bytes; only the arithmetic moved.
 *
 * **Why that mattered enough to change.** `{ ...byTrace, [traceId]: [...] }`
 * copies every key of a Record that gains one per trace, on every span event.
 * At the audit's own session mix that one line stood at 50 / 518 / 2,367 /
 * 8,866 ms for a 5k / 15k / 30k / 55k-event fold (#179's bench, three passes
 * each) — ~90% of what was left of the fold after #179, and eleven seconds of
 * a day-long session's boot recovery. Rebuilding a projection costs one pass
 * over `spans` *when read*, which no live surface does per event, and the fold
 * itself never reads it: it carries the one lookup it actually needs (has this
 * trace already delivered this span id?) beside the reducer, keyed by the
 * identity of the array it describes — `TraceIndex` in `reduce.ts`, where the
 * argument is written out in full, and where every other derived table lives
 * by the same rule (#179's `UsageIndex`).
 *
 * **The trade, named.** A cost the fold used to pay per event now falls on the
 * first read per spans array: building the projection for a 7,260-span session
 * measures ~3.6 ms, against ~11 ms for `selectLaneInteractions` on the same
 * state, and every read after it is a memo hit. The one shape that would not
 * win is a surface reading `byTrace` after *every* span event — it would pay
 * per event again, ~1.5× what the accumulation cost. No surface does: the web
 * reads through `selectors/traces.ts` per render, and those selectors are
 * already a pass over the spans they summarise.
 */
export interface TraceState {
  spans: SpanRecord[]
  /**
   * traceId → positions in `spans`, in observation order. Materialised on
   * demand from `spans` (see above); `readonly` because it is derived — the
   * only way to change it is to fold another span.
   */
  readonly byTrace: Record<string, number[]>
  /**
   * sessionId → positions in `spans`. Spans with no session id are not indexed
   * here. Materialised on demand, same as {@link byTrace}.
   */
  readonly bySession: Record<string, number[]>
}

/**
 * The slice for a given spans array: the array itself, plus its two
 * projections, computed the first time each is read and then remembered
 * against the array they describe.
 *
 * The memo is keyed by the array's identity and lives in a `WeakMap`, so it
 * dies with the array and can never be read against a different one. Nothing
 * about it is observable: a projection is a pure function of `spans`, so a
 * remembered one and a freshly built one are the same value — which is what
 * lets the fold hand back a slice in constant time without any surface being
 * able to tell (`state.test.ts`, `reduce.test.ts`).
 */
export function traceStateOf(spans: SpanRecord[]): TraceState {
  return {
    spans,
    get byTrace() {
      return projection(byTraceProjections, spans, traceKeyOf)
    },
    get bySession() {
      return projection(bySessionProjections, spans, sessionKeyOf)
    },
  }
}

const byTraceProjections = new WeakMap<readonly SpanRecord[], Record<string, number[]>>()
const bySessionProjections = new WeakMap<readonly SpanRecord[], Record<string, number[]>>()

const traceKeyOf = (span: SpanRecord): string | null => span.traceId
const sessionKeyOf = (span: SpanRecord): string | null => span.sessionId

/**
 * One position per span, appended under its key in span order — exactly what
 * an append-per-event fold would have accumulated, including the order the
 * keys were first seen in, which is what makes the two spellings serialise to
 * the same bytes. A span whose key is `null` is not indexed at all.
 */
function projection(
  memo: WeakMap<readonly SpanRecord[], Record<string, number[]>>,
  spans: readonly SpanRecord[],
  keyOf: (span: SpanRecord) => string | null,
): Record<string, number[]> {
  const held = memo.get(spans)
  if (held !== undefined) return held
  const built: Record<string, number[]> = {}
  for (let at = 0; at < spans.length; at += 1) {
    const key = keyOf(spans[at] as SpanRecord)
    if (key === null) continue
    const positions = built[key]
    if (positions === undefined) built[key] = [at]
    else positions.push(at)
  }
  memo.set(spans, built)
  return built
}

/**
 * A fresh slice, with a fresh spans array, on every call — the same rule
 * {@link initialTelemetryState} follows and for the same reason: both the
 * fold's lookup table and the projection memo above are keyed by the identity
 * of the array they describe, so a shared `[]` would hand one fold's answers
 * to another. `state.test.ts` holds this to it.
 */
export function initialTraceState(): TraceState {
  return traceStateOf([])
}

/**
 * One `fork.checkpoint` capture, kept whole and in observation order — same
 * rule as every other record here. prd12 ruling 2: the laboratory's own
 * slice, additive alongside everything the observer folds.
 */
export interface CheckpointRecord {
  eventId: string
  ts: number
  lane: string
  checkpointId: string
  eventIndex: number
  sessionFile: string
  sessionCutByte: number
  sessionDigest: string
  snapshotRef: string
  snapshotSha: string
  headSha: string
  capturedBy: ForkCheckpointCapturedBy
}

/**
 * prd12's lab slice. Mirrors {@link TraceState}'s shape: records in arrival
 * order, plus a lane index holding positions into `records`, not copies.
 */
export interface CheckpointState {
  records: CheckpointRecord[]
  /** lane → positions in `records`, in observation order. */
  byLane: Record<string, number[]>
}

export function initialCheckpointState(): CheckpointState {
  return { records: [], byLane: {} }
}

/**
 * One `fork.dispatched` arm, kept whole and in observation order — same rule
 * as {@link CheckpointRecord}. prd12 ruling 3, phase 2: the launch half of
 * the laboratory's slice.
 */
export interface ForkDispatchRecord {
  eventId: string
  ts: number
  forkId: string
  parentLane: string
  checkpointId: string
  /** 1-based arm number within its fork. */
  arm: number
  /** Null when the arm inherits the fleet default model. */
  model: string | null
  /** sha256 of the arm's prompt file, or null when it was dispatched without one. */
  promptDigest: string | null
  laneHandle: string
  worktreePath: string
}

/**
 * prd12's dispatch slice. Same shape as {@link CheckpointState}, with two
 * indexes rather than one: a comparison surface asks "which arms belong to
 * this fork" and every lane-keyed surface asks "is this lane an arm, and of
 * what". Both hold positions into `dispatches`, never copies.
 */
export interface ForkState {
  dispatches: ForkDispatchRecord[]
  /** forkId → positions in `dispatches`, in observation order. */
  byFork: Record<string, number[]>
  /** Synthetic lane handle → positions in `dispatches`. One arm per handle in practice. */
  byLane: Record<string, number[]>
}

export function initialForkState(): ForkState {
  return { dispatches: [], byFork: {}, byLane: {} }
}

/**
 * One `judge.finding` capture, kept whole and in observation order — same
 * rule as {@link CheckpointRecord}. prd11 ruling 6b, phase 1: the structural
 * organ's own slice, additive alongside everything else the observer folds.
 * `severity` is always `'log'` today (the schema itself locks it); the field
 * is kept rather than assumed so a later phase's fold doesn't need a schema
 * migration to read it.
 */
export interface JudgeFindingRecord {
  eventId: string
  ts: number
  kind: JudgeFindingKind
  lanes: [string, string]
  evidence: JudgeEvidence
  severity: 'log'
  detectedAt: number
}

/**
 * prd11 ruling 6b's judge slice. Mirrors {@link CheckpointState}'s shape,
 * except a finding is ABOUT a pair, so `byLane` indexes a record under BOTH
 * of its lanes rather than one.
 */
export interface JudgeState {
  findings: JudgeFindingRecord[]
  /** lane → positions in `findings`, in observation order. A pair's finding appears under both its lanes. */
  byLane: Record<string, number[]>
}

export function initialJudgeState(): JudgeState {
  return { findings: [], byLane: {} }
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
  /** prd12 ruling 2: the laboratory's checkpoint captures. Additive again. */
  checkpoints: CheckpointState
  /** prd12 ruling 3: the laboratory's dispatched arms. Additive again. */
  forks: ForkState
  /** prd11 ruling 6b, phase 1: the judge's structural-organ findings. Additive again. */
  judge: JudgeState
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
    checkpoints: initialCheckpointState(),
    forks: initialForkState(),
    judge: initialJudgeState(),
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
