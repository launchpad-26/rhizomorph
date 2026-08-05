import type {
  AgentRole,
  AgentStatus,
  AgentThread,
  CollisionEntry,
  LaneSubagentActivity,
  SpanDecision,
  TokenTotals,
  WaitingOnHumanSummary,
} from '@rhizomorph/core'
import type { LaneManifest, Trespass } from './fences.js'
import type { LadderRank, Pathology, PathologyKind } from './pathology.js'

// ── lanes ───────────────────────────────────────────────────────────────────

/**
 * How a lane is getting on when nothing is *wrong* with it.
 *
 * `done` is first-class and non-pathological: a fleet that has finished its
 * work is seventeen silent lanes, and reporting that as seventeen flatlines is
 * the single loudest way this instrument could cry wolf.
 */
export type LaneActivity = 'working' | 'waiting' | 'done' | 'idle' | 'unknown'

/** A subagent (or auxiliary) thread — the scene's second-growth filaments. */
export interface Filament {
  thread: AgentThread | null
  outputTokens: number
  requestCount: number
}

/**
 * #143 — {@link WaitingOnHumanSummary} (`selectWaitingOnHuman`, #125), merged
 * across every handle this lane resolves to, plus one derived fact the raw
 * selector cannot carry: which decision belongs to `longestWait` itself. The
 * selector's own `decisions` field is a lane-wide census (how many of each),
 * not a property of any one wait, so the retrospective chip's decision glyph
 * is resolved here, from the exact span `longestWait.spanId` names, the one
 * place in this file that already reads `state.traces.spans` directly (prd9
 * ruling 4 keeps spans out of every selector spend reads, so nothing upstream
 * could have carried this fact for us).
 *
 * Always present, never null: a lane that has never sat blocked on a human
 * gets the selector's own honest zeroed shape (`waitCount: 0`,
 * `longestWait: null`), which is a real computed fact ("checked, found
 * nothing"), not a gap — the detection-honesty convention this field follows
 * is {@link WaitingOnHumanSummary}'s own, unchanged.
 */
export interface LaneWaitedOnHuman extends WaitingOnHumanSummary {
  /** Null whenever `longestWait` is null, or — honest gap — the span it names somehow is not in the log. */
  longestWaitDecision: SpanDecision | null
}

export interface Lane {
  /** Stable key: the branch when known, else the worktree path, else the handle. */
  id: string
  label: string
  /** Telemetry handles that resolve to this lane — usually one, two when the
   * two collectors named the same work differently. */
  handles: string[]
  branch: string | null
  worktreePath: string | null
  issue: string | null
  role: AgentRole
  /** True when only telemetry knows this lane — git never saw a worktree. */
  telemetryOnly: boolean
  /** False once its worktree has been removed: the lane landed and folded. */
  present: boolean

  /**
   * Session-stable ordering slot, assigned by first sighting and never
   * reshuffled by rank (graft g7). The scene pins a lane's angle to this, so
   * "72 lives at four o'clock" stays true for the whole session even as the
   * attention ordering churns above it.
   */
  slot: number

  agentStatus: AgentStatus | null
  activity: LaneActivity

  // work
  tokens: TokenTotals
  outputTokens: number
  costUsd: number
  costIsAuthoritative: boolean | null
  costEventCount: number
  requestCount: number
  toolCallCount: number
  /** Output tokens per minute over the trailing window — the outlier test's unit. */
  outputPerMin: number
  /**
   * #159 — output tokens over the trailing {@link SPARK_WINDOW_MS}, bucketed
   * for the fleet table's own sparkline cell. Oldest first, trimmed to the
   * lane's own lifetime (`bucketizeSeries`' honesty gate): a lane younger than
   * the window has a shorter array, never a longer one padded with invented
   * silence. `Sparkline` itself declines to draw fewer than three points, so
   * this can be arbitrarily short — that gate lives there, not here.
   */
  recentOutputTokens: readonly number[]
  filaments: Filament[]
  model: string | null

  // place
  aheadOfMain: number
  commitCount: number
  dirtyCount: number
  filesTouched: number

  // liveness
  /**
   * Newest fact of ANY kind about this lane, pane repaints included — the
   * liveness signal FROZEN reads, because a pane that is still redrawing is,
   * whatever else is true, not dead air.
   */
  lastEventTs: number | null
  ageMs: number | null
  /**
   * Newest sign of the agent actually *working*: a model request, a tool call,
   * a trace span, a commit, a dirty-set change, a declared status. Pane
   * activity is deliberately excluded — a terminal repainting a prompt is a
   * sign of life, not a sign of progress, and conflating the two is precisely
   * what would hide a lane sitting on a confirmation dialog.
   */
  lastWorkTs: number | null
  workAgeMs: number | null
  firstSeenAt: number
  /**
   * #141 — OTel's ignored `claude_code.active_time.total` counter, finally
   * read: how much of this lane's age was the agent actually active, summed
   * across whatever sessions it has run (`selectActiveSecondsByLaneIndex`
   * already resolves a counter reset per session). Null when no OTel reading
   * has ever reached this lane — the fleet table's gap-honesty rule (law 12):
   * a lane with no feed shows AGE alone, never an invented zero ACTIVE.
   */
  activeSeconds: number | null
  /** #143 — how long this lane has SAT waiting on a human, retrospectively. See {@link LaneWaitedOnHuman}. */
  waitedOnHuman: LaneWaitedOnHuman
  /**
   * #143 — this lane's live subagent bud, from thread-marked telemetry
   * recency (`selectSubagentActivity`, prd10 ruling 9's data layer),
   * trace-enriched where the lane is instrumented. Null when no
   * `thread: 'subagent'` reading has reached this lane inside the window —
   * never a zeroed bud: the scene reads null as "no bud to draw", exactly
   * `activeSeconds`' own gap-honesty rule.
   */
  subagents: LaneSubagentActivity | null

  // diagnosis
  /** Tool names inside the loop window, oldest first — the loop evidence. */
  recentTools: string[]
  pathologies: Pathology[]
  trespasses: Trespass[]
  /** True when this lane has a declared fence to be judged against at all. */
  fenced: boolean
  rank: LadderRank

  /**
   * Parked is a state, not a mute (prd4 ruling 5): `true` only when the
   * manifest's own fence entry declared it. Never inferred and never set by
   * this read-only instrument — an operator's call, carried, not guessed.
   * Suppresses the FROZEN and inferred-WAITING alarms (`detectFrozen`,
   * `detectWaiting`) and keeps the lane off the ladder (`buildLadder`), but
   * leaves every other fact about it — its output, its age, its fence
   * compliance — exactly as true as it would be unparked. The fleet table is
   * this field's only consumer today; the scene still reads `activity`,
   * which has no member for "parked" (adding one would require an exhaustive
   * key on `sigils.tsx`'s and `scene/palette.ts`'s `Record<LaneActivity, …>`
   * maps, both outside this change's fence) — see issue #96 for that follow-up.
   */
  parked: boolean
}

/** Main — the root-mass everything grows out of, and lands back into. */
export interface RootMass {
  repoName: string | null
  mainBranch: string | null
  worktreePath: string | null
  /** Commits observed landing on main — the surges home. */
  commitsHome: number
  /** Worktrees that have gone away: lanes that landed and folded. */
  landings: number
  conductorOutputTokens: number
  overheadRatio: number | null
  lastCommitTs: number | null
  /**
   * #154 — MAIN's own live subagent bud (prd10 ruling 9's conductor half),
   * mirroring {@link Lane.subagents} exactly: same shape, same
   * detection-honesty markers, the same {@link selectSubagentActivity} vital
   * — one object, four surfaces, read here for the fifth. Resolved off every
   * handle this file already treats as the conductor's own ({@link isRootSpend}),
   * plus `mainBranch` itself, the same fallback order {@link subagentActivityFor}
   * uses for a lane. Null whenever no `thread: 'subagent'` reading has reached
   * the conductor's telemetry inside the window — never a zeroed bud, exactly
   * `Lane.subagents`' own gap-honesty rule.
   */
  subagents: LaneSubagentActivity | null
}

// ── the ladder, made structurally honest (graft g5) ──────────────────────────

export type AttentionKind = PathologyKind | 'collision' | 'collector'

export interface AttentionItem {
  /** Unique per item: two faults can share a lane, so a lane id is not enough. */
  id: string
  /** The lane to jump to, or null when the item has no single lane to blame. */
  laneId: string | null
  label: string
  kind: AttentionKind
  rank: Exclude<LadderRank, 'calm'>
  /** How long it has been true, in ms. Null when the log cannot say. */
  forMs: number | null
  evidence: string
  inferred: boolean
}

/**
 * What ALL CLEAR is allowed to say — ruling 14: never bare reassurance.
 *
 * `collisions` is typed as the literal `0`. That is not decoration: it makes
 * "ALL CLEAR beside a non-zero collision count" unrepresentable rather than
 * merely discouraged, so no view can ever reintroduce the contradiction by
 * forgetting a check.
 */
export interface CalmEvidence {
  lanes: number
  working: number
  branchesChecked: number
  filesChecked: number
  collisions: 0
  /** The rendered line, e.g. `collisions: 0 — checked 7 branches / 41 files`. */
  line: string
}

/**
 * THE LADDER FLOOR (graft g5), enforced in the model and never remembered by a
 * view.
 *
 * A calm ladder has *no* items and *carries* its evidence; any other rung has
 * at least one item and no evidence line to render. A caller therefore cannot
 * print ALL CLEAR without having narrowed to the calm case, and cannot reach
 * the calm case while anything — including a single contended file — is in the
 * list. The collision count raises the rung here, in the model; the view just
 * renders what it is handed.
 */
export type Ladder =
  | { rank: 'calm'; items: readonly []; evidence: CalmEvidence }
  | { rank: Exclude<LadderRank, 'calm'>; items: readonly [AttentionItem, ...AttentionItem[]] }

// ── gaps (law 12) ───────────────────────────────────────────────────────────

/** WHAT is missing → WHY it matters → THE command that fixes it. */
export interface Gap {
  id: string
  what: string
  why: string
  command: string
  /** The one terse line, assembled once so every surface says it identically. */
  line: string
}

// ── burn (ruling 13) ────────────────────────────────────────────────────────

export interface Burn {
  outputTokens: number
  tokens: TokenTotals
  costUsd: number
  /** Null when no cost event was counted at all: "unknown", never "free". */
  costIsAuthoritative: boolean | null
  costEventCount: number
  outputPerMin: number
  costUsdPerHour: number
  /** Conductor ÷ worker output tokens. Null unless both sides reported. */
  overheadRatio: number | null
  conductorInstrumented: boolean
  windowMs: number
  /**
   * #159 — the dashboard-IA spike's golden-signal gap, closed: the burn strip's
   * one error figure. `errorBlockedCount + errorParkedCount + errorOffFenceCount`
   * — a lane can count toward more than one bucket (a parked lane workmux still
   * declares WAITING is both blocked and parked), so the sum can exceed the
   * fleet's own lane count; that is the honest arithmetic of "how many distinct
   * problems", not "how many lanes have one". Zero is a real, calm zero — never
   * omitted and never dressed up as reassurance (ruling 14's law, restated for
   * a number instead of a word).
   *
   * Optional, not because `buildFleet` ever omits it — every `Burn` it returns
   * carries all four fields — but because `Burn` fixtures hand-built outside
   * this change's fence (`panels/attention/`) predate this field and cannot be
   * updated here; `BurnStrip` below reads each with a `?? 0` fallback so an
   * older fixture renders a calm zero rather than `undefined`.
   */
  errorCount?: number
  /** Lanes with a live WAITING pathology (blocked on a human), parked lanes excluded — their alarm is already muted by the operator's own declaration. */
  errorBlockedCount?: number
  /** Lanes the operator declared parked (`.swarm/lanes.json`) — a deliberate stand-down, still worth a count. */
  errorParkedCount?: number
  /** Lanes currently touching files outside their declared fence — a gate failure, in `buildLadder`'s own `off-fence` terms. */
  errorOffFenceCount?: number
}

// ── the fleet ───────────────────────────────────────────────────────────────

export interface Fleet {
  /** The instant everything here was measured against. Injected, never read. */
  now: number
  root: RootMass
  lanes: Lane[]
  /** Display order: worst rung first, then biggest, then alphabetical. */
  ladder: Ladder
  /** Convenience mirror of `ladder.rank` for the tab signal and the favicon. */
  rank: LadderRank
  burn: Burn
  collisions: CollisionEntry[]
  gaps: Gap[]
  /** False when `/api/lanes` gave us nothing — off-fence is then unavailable. */
  hasLaneManifest: boolean
  eventCount: number
}

export interface BuildFleetOptions {
  /** Epoch millis to measure against — injected so replay and tests are exact. */
  now: number
  /** The lane manifest from `/api/lanes`, or null when there isn't one. */
  manifest?: LaneManifest | null
  /** Trailing window for every rate. Defaults to core's five minutes. */
  windowMs?: number
}
