import {
  DEFAULT_SPEND_WINDOW_MS,
  compareStrings,
  selectActiveSecondsByLaneIndex,
  selectCollisions,
  selectLaneSpend,
  selectRoleSpend,
  selectSessionSpend,
  selectSpendRateByLane,
  selectSubagentActivityIndex,
  selectTouchesByBranch,
  selectWaitingOnHuman,
  selectWorktreeViews,
  type AgentRole,
  type AgentStatus,
  type AgentThread,
  type CollisionEntry,
  type LaneSpend,
  type LaneSubagentActivity,
  type SessionState,
  type SpanDecision,
  type TokenTotals,
  type WaitingOnHumanSummary,
} from '@rhizomorph/core'
import { findTrespasses, type LaneManifest, type Trespass } from './fences.js'

/**
 * THE ONE DERIVED FLEET OBJECT.
 *
 * The attention strip, the fleet table, the burn strip and the scene are four
 * views of *this*, and of nothing else. That is the whole point: four surfaces
 * that each re-derive "how many lanes are working" will eventually disagree by
 * one, in public, on the one screen whose job is to be trusted at a glance.
 *
 * Everything below is derived by `@rhizomorph/core`'s selectors over the same
 * `SessionState` every other consumer folds. Nothing is summed locally that a
 * selector already sums, no new event type is invented, and nothing the log did
 * not say is guessed:
 *
 * - every pathology names the recorded facts it read, in an **evidence string**
 *   (`Read→Edit→Bash ×6, no commit`) rather than a bare label (graft g4);
 * - a detector that had to lean on a weaker signal marks itself `inferred`
 *   (ruling 18's detection-honesty clause);
 * - OFF-FENCE only ever comes from a real lane manifest (ruling 19). A missing
 *   manifest is a named gap in {@link Fleet.gaps}, never an inference from lane
 *   names;
 * - `done` is a first-class, non-pathological state, so a finished fleet reads
 *   as seventeen finished lanes and not as seventeen flatlines.
 */

// ── tuned constants ─────────────────────────────────────────────────────────
// Every threshold in the instrument lives here, named, with the reason it has
// the value it has. A number tuned inside a detector is a number nobody can
// find later.

/**
 * Tokens come from the collector with cache-tier detail, dollars from the one
 * with authority (architecture.md, prd1). Counting both collectors' token
 * reports would double-count every request they both saw.
 */
const TOKEN_ORIGINS = ['sessionlog'] as const

/** How far back LOOPING looks for a repeating tool cycle. */
export const LOOP_WINDOW_MS = 4 * 60_000
/** A one-tool "cycle" is not a cycle; six is longer than any real stuck loop. */
export const LOOP_MIN_PERIOD = 2
export const LOOP_MAX_PERIOD = 6
/** Twice could be a coincidence. Three times is a wheel. */
export const LOOP_MIN_REPEATS = 3

/**
 * FROZEN — minutes of *total* silence. Well past core's `DEFAULT_FLATLINE_MS`
 * (5m) on purpose: this one escalates to BROKEN and flips the tab title, so it
 * has to outlast a long compile, a big test run and a slow model response.
 */
export const FROZEN_AFTER_MS = 8 * 60_000

/**
 * The second witness (dogfooding-born, #133): a pane's own repaint is one sign
 * of life, but a delegating lane looks visually still — no content-hash change
 * — for exactly as long as its subagent is busiest, which is precisely when a
 * pane-only reading is most wrong. `llm.usage`/`tool.activity` already reach
 * `lastWorkTs` through `LaneSpend.lastTs`; `trace.span` does not — `spend.ts`
 * keeps spans out of the money layer by design (prd9 ruling 4) — so this file
 * reads `state.traces.spans` directly and folds a lane's latest span into the
 * same `lastWorkTs` FROZEN and WAITING already read. A lane is only silent on
 * the work witness when NEITHER a usage/tool event NOR a span has landed
 * recently; a still pane with a live trace reads `working`, not a summons.
 *
 * Windowed to `FROZEN_AFTER_MS` — the widest silence any detector in this file
 * cares about — because a span older than that could not rescue a lane from
 * FROZEN either way, and scanning further back would just be paying to learn
 * a number nothing downstream will use.
 */
export const SPAN_WITNESS_WINDOW_MS = FROZEN_AFTER_MS

/** Silence this long, with the pane still moving, smells like a raised hand. */
export const WAITING_QUIET_MS = 75_000
/** …and the pane must have moved this recently for that inference to hold. */
export const WAITING_PANE_FRESH_MS = 45_000

/** EXPENSIVE — this many times the fleet's median output rate… */
export const EXPENSIVE_MULTIPLE = 3
/** …and never below this floor, so a fleet of near-zeros has no "outlier". */
export const EXPENSIVE_FLOOR_PER_MIN = 300

/** Past this a calm lane has simply gone quiet: not broken, just cold. */
export const IDLE_AFTER_MS = 90_000

// ── the alarm ladder (ruling 8) ─────────────────────────────────────────────

export type LadderRank = 'calm' | 'notice' | 'needs-you' | 'broken'

export const LADDER_ORDER = ['calm', 'notice', 'needs-you', 'broken'] as const

export const LADDER_WORD: Record<LadderRank, string> = {
  calm: 'ALL CLEAR',
  notice: 'NOTICE',
  'needs-you': 'NEEDS YOU',
  broken: 'BROKEN',
}

export function rankIndex(rank: LadderRank): number {
  return LADDER_ORDER.indexOf(rank)
}

export function worseRank(a: LadderRank, b: LadderRank): LadderRank {
  return rankIndex(a) >= rankIndex(b) ? a : b
}

// ── pathologies (ruling 18) ─────────────────────────────────────────────────

export type PathologyKind = 'looping' | 'frozen' | 'waiting' | 'expensive' | 'off-fence'

export const PATHOLOGY_KINDS = [
  'looping',
  'frozen',
  'waiting',
  'expensive',
  'off-fence',
] as const satisfies readonly PathologyKind[]

/** Which rung each pathology climbs to. A lane takes the worst it carries. */
export const PATHOLOGY_RANK: Record<PathologyKind, LadderRank> = {
  // Dead air is the only lane state that is unambiguously broken.
  frozen: 'broken',
  // These three all want a human; hue says that, form says which (graft g4).
  looping: 'needs-you',
  waiting: 'needs-you',
  'off-fence': 'needs-you',
  // A burn outlier is worth knowing, not worth interrupting for.
  expensive: 'notice',
}

export const PATHOLOGY_WORD: Record<PathologyKind, string> = {
  looping: 'LOOPING',
  frozen: 'FROZEN',
  waiting: 'WAITING',
  expensive: 'EXPENSIVE',
  'off-fence': 'OFF-FENCE',
}

/** Prefixes any evidence a weaker signal produced. See {@link Pathology.inferred}. */
export const INFERRED_MARK = '~'

export interface Pathology {
  kind: PathologyKind
  rank: LadderRank
  /** When the condition started, as well as the log can say. Null when it can't. */
  since: number | null
  /**
   * One terse clause naming the recorded facts behind the call — never a bare
   * label (graft g4). This is what the attention chip renders.
   */
  evidence: string
  /**
   * True when a weaker signal was needed to reach this call: WAITING is
   * *certain* when workmux declared it and *inferred* when it was read off a
   * quiet lane with a live pane. Inferred evidence renders with
   * {@link INFERRED_MARK} so a reader can tell a fact from a deduction.
   */
  inferred: boolean
}

/** The evidence as it should be shown: inferences wear their mark. */
export function evidenceLine(pathology: Pathology): string {
  return pathology.inferred ? `${INFERRED_MARK} ${pathology.evidence}` : pathology.evidence
}

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

export function buildFleet(state: SessionState, options: BuildFleetOptions): Fleet {
  const { now } = options
  const windowMs = options.windowMs ?? DEFAULT_SPEND_WINDOW_MS
  const manifest = options.manifest ?? null

  // Two passes over spend on purpose: tokens from the collector with cache-tier
  // detail, dollars from the one with authority. One mixed pass double-counts
  // every request both collectors saw.
  const tokenTotals = selectSessionSpend(state, { origins: TOKEN_ORIGINS })
  const costTotals = selectSessionSpend(state)
  const tokenSpend = indexByLane(selectLaneSpend(state, { origins: TOKEN_ORIGINS }))
  const costSpend = indexByLane(selectLaneSpend(state))
  const tokenRates = selectSpendRateByLane(state, { now, windowMs, origins: TOKEN_ORIGINS })
  const costRates = selectSpendRateByLane(state, { now, windowMs })
  // Token-filtered for the overhead ratio's own tokens (dedup'd across
  // collectors); cost events are never double-reported, so the conductor's
  // "is it instrumented at all" check reads every origin, otel included —
  // the one collector that ever emits `llm.cost`.
  const roleSplit = selectRoleSpend(state, { origins: TOKEN_ORIGINS })
  const costRoleSplit = selectRoleSpend(state)
  const activeSecondsByLane = selectActiveSecondsByLaneIndex(state)
  const subagentActivityByLane = selectSubagentActivityIndex(state, { now })

  const worktrees = selectWorktreeViews(state, { includeRemoved: true })
  const touches = selectTouchesByBranch(state)
  const collisions = selectCollisions(state)
  const toolsByHandle = recentToolsByHandle(state, now - LOOP_WINDOW_MS)
  const spanTsByHandle = latestSpanTsByLane(state, now - SPAN_WITNESS_WINDOW_MS)
  const commitTsByBranch = latestCommitTsByBranch(state)
  const spanDecisionByKey = spanDecisionsByKey(state)

  const main = worktrees.find((view) => view.isMain) ?? null
  const mainBranch = state.mainBranch ?? main?.branch ?? null

  const drafts = new Map<string, Draft>()
  const draftFor = (id: string, seedTs: number): Draft => {
    const existing = drafts.get(id)
    if (existing !== undefined) return existing
    const created = emptyDraft(id, seedTs)
    drafts.set(id, created)
    return created
  }

  // --- git geography first: a lane the collectors can see has a place --------
  for (const view of worktrees) {
    if (view.isMain) continue
    const id = view.branch ?? view.path
    const draft = draftFor(id, view.discoveredAt)
    draft.label = view.branch ?? view.name
    draft.branch = view.branch
    draft.worktreePath = view.path
    draft.present = view.present
    draft.telemetryOnly = false
    draft.agentStatus = view.agent?.status ?? null
    draft.agentStatusTs = view.agent?.updatedAt ?? null
    draft.aheadOfMain = view.aheadOfMain
    draft.dirtyCount = view.dirtyCount
    draft.filesTouched = view.filesTouched.length
    draft.commitCount =
      view.branch === null ? 0 : (state.branches[view.branch]?.commits.length ?? 0)
    draft.paneActivityTs = view.lastActivityTs
    draft.firstSeenAt = Math.min(draft.firstSeenAt, view.discoveredAt)
    draft.lastWorkTs = maxTs(
      draft.lastWorkTs,
      view.agent?.updatedAt ?? null,
      state.worktrees[view.path]?.dirtyUpdatedAt ?? null,
      view.branch === null ? null : (commitTsByBranch.get(view.branch) ?? null),
    )
  }

  // --- then telemetry identity: spend the git collector never saw a home for
  // still gets a lane. Orphan and unattributed burn must stay visible.
  //
  // Belongs to the root-mass rather than to a worker lane: the conductor's own
  // burn, and anything booked against main itself.
  const isRootSpend = (spend: LaneSpend): boolean =>
    dominantRole(spend.roles) === 'conductor' ||
    (mainBranch !== null && spend.branch === mainBranch)

  const claim = (spend: LaneSpend): void => {
    const id = resolveLaneId(spend, drafts)
    const seedTs = state.telemetry.lanes[spend.lane]?.firstSeenAt ?? spend.firstTs ?? now
    const draft = draftFor(id, seedTs)
    draft.handles.add(spend.lane)
    draft.firstSeenAt = Math.min(draft.firstSeenAt, seedTs)
    if (draft.role === 'unattributed') draft.role = dominantRole(spend.roles)
    if (draft.branch === null) draft.branch = spend.branch
    if (draft.worktreePath === null) draft.worktreePath = spend.worktreePath
    if (draft.label === draft.id) draft.label = spend.branch ?? spend.lane
  }

  let conductorOutputTokens = 0
  for (const spend of Object.values(tokenSpend)) {
    if (isRootSpend(spend)) {
      conductorOutputTokens += spend.tokens.output
      continue
    }
    claim(spend)
  }

  // Cost rows are walked separately, and never for their tokens: the unfiltered
  // rows sum BOTH collectors' usage, so counting them here would double every
  // request the two of them both saw. What they can still contribute is a lane
  // — dollars that arrived under a handle no token row mentioned (an OTel-only
  // setup) must get a row of their own rather than being visible only in the
  // session total.
  for (const spend of Object.values(costSpend)) {
    if (isRootSpend(spend)) continue
    claim(spend)
  }

  // --- fill the numbers -----------------------------------------------------
  const lanes: Lane[] = []
  for (const draft of drafts.values()) {
    const handles = [...draft.handles].sort(compareStrings)
    const tokens = mergeSpend(handles.map((handle) => tokenSpend[handle]))
    const costs = mergeSpend(handles.map((handle) => costSpend[handle]))
    const outputPerMin = handles.reduce(
      (sum, handle) => sum + perMinute(tokenRates[handle]?.totals.tokens.output ?? 0, windowMs),
      0,
    )
    // A lane whose only telemetry is spans (no usage/cost/tool event ever
    // claimed a handle for it) has nothing in `handles` to look span recency
    // up by, so the lookup also tries the lane's own id and branch — the same
    // fallback order `fenceHandleFor` uses to resolve a lane to a handle.
    const lastWorkTs = maxTs(
      draft.lastWorkTs,
      tokens?.lastTs ?? null,
      costs?.lastTs ?? null,
      spanTsByHandle.get(draft.id) ?? null,
      draft.branch === null ? null : (spanTsByHandle.get(draft.branch) ?? null),
      ...handles.map((handle) => spanTsByHandle.get(handle) ?? null),
    )
    const lastEventTs = maxTs(lastWorkTs, draft.paneActivityTs)
    const fence = manifest === null ? undefined : fenceFor(manifest, draft, handles)
    const activeSeconds = sumActiveSeconds(handles, activeSecondsByLane)
    const waitedOnHuman = waitedOnHumanFor(state, draft.id, draft.branch, handles, spanDecisionByKey)
    const subagents = subagentActivityFor(subagentActivityByLane, draft.id, draft.branch, handles)

    lanes.push({
      id: draft.id,
      label: draft.label,
      handles,
      branch: draft.branch,
      worktreePath: draft.worktreePath,
      issue: fence?.issue ?? issueOf(draft.label),
      role: draft.role,
      telemetryOnly: draft.telemetryOnly,
      present: draft.present,
      slot: 0, // assigned below, once every lane is known
      agentStatus: draft.agentStatus,
      activity: 'unknown',

      tokens: tokens?.tokens ?? ZERO_TOKEN_TOTALS,
      outputTokens: tokens?.tokens.output ?? 0,
      costUsd: costs?.costUsd ?? 0,
      costIsAuthoritative: costs?.costIsAuthoritative ?? null,
      costEventCount: costs?.costEventCount ?? 0,
      requestCount: tokens?.requestCount ?? 0,
      toolCallCount: tokens?.toolCallCount ?? 0,
      outputPerMin,
      filaments: filamentsOf(tokens),
      model: fence?.model ?? null,

      aheadOfMain: draft.aheadOfMain,
      commitCount: draft.commitCount,
      dirtyCount: draft.dirtyCount,
      filesTouched: draft.filesTouched,

      lastEventTs,
      ageMs: lastEventTs === null ? null : Math.max(0, now - lastEventTs),
      lastWorkTs,
      workAgeMs: lastWorkTs === null ? null : Math.max(0, now - lastWorkTs),
      firstSeenAt: draft.firstSeenAt,
      activeSeconds,
      waitedOnHuman,
      subagents,

      recentTools: handles.flatMap((handle) => toolsByHandle.get(handle) ?? []),
      pathologies: [],
      trespasses: [],
      fenced: fence !== undefined,
      rank: 'calm',
      parked: fence?.parked === true,
    })
  }

  // Slots are assigned by first sighting, before any rank-based reordering, so
  // a lane's angle in the scene is stable for the session (graft g7).
  const bySighting = [...lanes].sort(
    (a, b) => a.firstSeenAt - b.firstSeenAt || compareStrings(a.id, b.id),
  )
  bySighting.forEach((lane, index) => {
    lane.slot = index
  })

  // --- diagnose (EXPENSIVE is relative, so the fleet has to exist first) -----
  const medianOutputPerMin = median(lanes.map((lane) => lane.outputPerMin).filter((v) => v > 0))
  const expensiveThreshold = Math.max(
    EXPENSIVE_FLOOR_PER_MIN,
    medianOutputPerMin * EXPENSIVE_MULTIPLE,
  )

  for (const lane of lanes) {
    const draft = drafts.get(lane.id) as Draft
    const touched = lane.branch === null ? [] : (touches[lane.branch] ?? []).map((t) => t.path)
    const fenceHandle = manifest === null ? null : fenceHandleFor(manifest, lane)

    lane.trespasses =
      manifest === null || fenceHandle === null
        ? []
        : findTrespasses(manifest, fenceHandle, touched)

    lane.pathologies = diagnose(lane, {
      now,
      medianOutputPerMin,
      expensiveThreshold,
      paneActivityTs: draft.paneActivityTs,
      agentStatusTs: draft.agentStatusTs,
      commitTs: lane.branch === null ? null : (commitTsByBranch.get(lane.branch) ?? null),
    })
    lane.rank = lane.pathologies.reduce<LadderRank>((worst, p) => worseRank(worst, p.rank), 'calm')
    lane.activity = activityOf(lane)
  }

  lanes.sort(byAttentionThenSize)

  const evidence = calmEvidenceOf(lanes, touches, collisions)
  const ladder = buildLadder(lanes, collisions, state, now, evidence)

  const commitsHome = mainBranch === null ? 0 : (state.branches[mainBranch]?.commits.length ?? 0)

  return {
    now,
    root: {
      repoName: state.session?.repoName ?? null,
      mainBranch,
      worktreePath: main?.path ?? null,
      commitsHome,
      landings: worktrees.filter((view) => !view.isMain && !view.present).length,
      conductorOutputTokens,
      overheadRatio: roleSplit.overheadRatio,
      lastCommitTs: mainBranch === null ? null : (commitTsByBranch.get(mainBranch) ?? null),
    },
    lanes,
    ladder,
    rank: ladder.rank,
    burn: {
      outputTokens: tokenTotals.tokens.output,
      tokens: tokenTotals.tokens,
      costUsd: costTotals.costUsd,
      costIsAuthoritative: costTotals.costIsAuthoritative,
      costEventCount: costTotals.costEventCount,
      outputPerMin: Object.values(tokenRates).reduce(
        (sum, rate) => sum + perMinute(rate.totals.tokens.output, windowMs),
        0,
      ),
      costUsdPerHour: Object.values(costRates).reduce((sum, rate) => sum + rate.costUsdPerHour, 0),
      overheadRatio: roleSplit.overheadRatio,
      conductorInstrumented: costRoleSplit.conductor.costEventCount > 0,
      windowMs,
    },
    collisions,
    gaps: buildGaps(state, costTotals, lanes, manifest),
    hasLaneManifest: manifest !== null,
    eventCount: state.eventCount,
  }
}

// ── the five detectors ──────────────────────────────────────────────────────

interface DiagnoseContext {
  now: number
  medianOutputPerMin: number
  expensiveThreshold: number
  paneActivityTs: number | null
  agentStatusTs: number | null
  commitTs: number | null
}

function diagnose(lane: Lane, ctx: DiagnoseContext): Pathology[] {
  const found: Pathology[] = []

  const frozen = detectFrozen(lane)
  if (frozen !== null) found.push(frozen)

  const looping = detectLooping(lane, ctx)
  if (looping !== null) found.push(looping)

  // Silence means exactly one thing: a frozen lane is not also a raised hand.
  const waiting = frozen === null ? detectWaiting(lane, ctx) : null
  if (waiting !== null) found.push(waiting)

  const expensive = detectExpensive(lane, ctx)
  if (expensive !== null) found.push(expensive)

  const offFence = detectOffFence(lane)
  if (offFence !== null) found.push(offFence)

  return found
}

/**
 * LOOPING — a repeating tool-call cycle with nothing landing behind it. Derived
 * from `tool.activity` (the cycle) and `commit.landed` (the progress): a lane
 * running `Read→Edit→Bash` six times over and committing nothing is stuck,
 * while the same cycle punctuated by a commit is just work.
 */
function detectLooping(lane: Lane, ctx: DiagnoseContext): Pathology | null {
  if (ctx.commitTs !== null && ctx.commitTs >= ctx.now - LOOP_WINDOW_MS) return null

  const cycle = findCycle(lane.recentTools)
  if (cycle === null) return null

  return {
    kind: 'looping',
    rank: PATHOLOGY_RANK.looping,
    since: ctx.now - LOOP_WINDOW_MS,
    evidence: `${cycle.pattern.join('→')} ×${cycle.repeats}, no commit`,
    inferred: false,
  }
}

/** The smallest tool cycle the tail of the sequence repeats, if any. */
export function findCycle(
  seq: readonly string[],
): { pattern: string[]; repeats: number } | null {
  for (let period = LOOP_MIN_PERIOD; period <= LOOP_MAX_PERIOD; period += 1) {
    if (seq.length < period * LOOP_MIN_REPEATS) break
    const pattern = seq.slice(seq.length - period)
    // One tool repeated is not a cycle — exploring reads the same file twice.
    if (new Set(pattern).size < 2) continue

    let repeats = 1
    for (let start = seq.length - period * 2; start >= 0; start -= period) {
      const window = seq.slice(start, start + period)
      if (!window.every((tool, i) => tool === pattern[i])) break
      repeats += 1
    }
    if (repeats >= LOOP_MIN_REPEATS) return { pattern, repeats }
  }
  return null
}

/**
 * FROZEN — minutes of total silence. Four cases are exempt by construction,
 * and each exemption is the difference between an instrument and an alarm that
 * gets muted:
 *
 * - a lane whose agent said `done` has *finished*;
 * - a lane whose worktree was removed has landed;
 * - a telemetry-only lane has no git geography to say which of those it is, so
 *   we decline to guess rather than accuse it of dying;
 * - a lane the operator declared `parked` in the manifest (prd4 ruling 5) is
 *   silent on purpose. This is not the UI muting an alarm on its own say-so —
 *   the honesty guard above still holds for everything this detector reads
 *   off the log — it is the one exemption that comes from a fact *outside*
 *   the log: a declaration the operator made in `.swarm/lanes.json`, as real
 *   as `done` or a removed worktree, just written by a different hand.
 */
function detectFrozen(lane: Lane): Pathology | null {
  if (lane.agentStatus === 'done' || !lane.present || lane.telemetryOnly || lane.parked) return null
  if (lane.ageMs === null || lane.ageMs < FROZEN_AFTER_MS) return null
  return {
    kind: 'frozen',
    rank: PATHOLOGY_RANK.frozen,
    since: lane.lastEventTs,
    evidence: `no events for ${formatSpan(lane.ageMs)}`,
    inferred: false,
  }
}

/**
 * WAITING — stopped with its hand up. **Certain** when workmux declared it;
 * otherwise inferred from a quiet lane whose pane is still moving, and marked
 * as inferred, because a pane heartbeat is a weaker signal than a declaration
 * (ruling 18's detection-honesty clause).
 */
function detectWaiting(lane: Lane, ctx: DiagnoseContext): Pathology | null {
  // A declared WAITING outlives the agent record that made it: workmux's last
  // report stands forever once the handle goes quiet, but a worktree that has
  // been removed has landed — same honesty exemption FROZEN applies, so a
  // stale "waiting" does not stand in for a live raised hand.
  if (lane.agentStatus === 'waiting' && lane.present) {
    const since = ctx.agentStatusTs ?? lane.lastEventTs
    const forMs = since === null ? null : Math.max(0, ctx.now - since)
    return {
      kind: 'waiting',
      rank: PATHOLOGY_RANK.waiting,
      // How long the hand has been up is when workmux said so — not the lane's
      // last event, which a pane heartbeat keeps refreshing while it waits.
      since,
      evidence: forMs === null ? 'workmux reports waiting' : `workmux reports waiting ${formatSpan(forMs)}`,
      inferred: false,
    }
  }

  // Same four exemptions as FROZEN (parked included, prd4 ruling 5): this
  // branch is the *inference*, read off a quiet lane with a live pane, and a
  // parked lane going quiet is exactly what the operator declared, not a
  // raised hand to deduce. A workmux-declared WAITING above this is left
  // alone — that is workmux's own fact, not this detector's guess.
  if (lane.agentStatus === 'done' || !lane.present || lane.telemetryOnly || lane.parked) return null
  // Work-age, not liveness-age: the whole shape of this inference is "the agent
  // stopped working while its terminal kept moving", so a pane repaint must not
  // be allowed to refresh the very silence being measured.
  if (lane.workAgeMs === null || lane.workAgeMs < WAITING_QUIET_MS) return null
  if (ctx.paneActivityTs === null) return null
  if (ctx.now - ctx.paneActivityTs > WAITING_PANE_FRESH_MS) return null

  return {
    kind: 'waiting',
    rank: PATHOLOGY_RANK.waiting,
    since: lane.lastWorkTs,
    evidence: `quiet ${formatSpan(lane.workAgeMs)}, pane still alive`,
    inferred: true,
  }
}

/**
 * EXPENSIVE — a burn outlier against the fleet's own median, never against a
 * budget: the question an operator actually has is "is one of these unlike the
 * others", and a fixed dollar threshold answers a different one.
 */
function detectExpensive(lane: Lane, ctx: DiagnoseContext): Pathology | null {
  if (lane.outputPerMin < ctx.expensiveThreshold) return null
  const multiple = ctx.medianOutputPerMin > 0 ? lane.outputPerMin / ctx.medianOutputPerMin : null
  return {
    kind: 'expensive',
    rank: PATHOLOGY_RANK.expensive,
    since: null,
    evidence: `${Math.round(lane.outputPerMin)} out-tok/min, ${
      multiple === null ? 'no fleet median' : `${multiple.toFixed(1)}× fleet median`
    }`,
    inferred: false,
  }
}

/**
 * OFF-FENCE — touching files outside the fence this lane was dispatched with.
 * Only ever from a real manifest: `lane.trespasses` is empty whenever there was
 * no fence to cross, so this detector cannot fire on an inference.
 */
function detectOffFence(lane: Lane): Pathology | null {
  if (!lane.fenced || lane.trespasses.length === 0) return null

  const count = lane.trespasses.length
  const files = `${count} file${count === 1 ? '' : 's'}`
  const victims = [...new Set(lane.trespasses.map((t) => t.victim).filter(isString))]
  const first = lane.trespasses[0] as Trespass

  return {
    kind: 'off-fence',
    rank: PATHOLOGY_RANK['off-fence'],
    since: null,
    evidence:
      victims.length === 1
        ? `touching ${victims[0]} — ${files}`
        : victims.length > 1
          ? `touching ${victims.length} other fences — ${files}`
          : `outside fence — ${files}: ${first.path}`,
    inferred: false,
  }
}

// ── the ladder ──────────────────────────────────────────────────────────────

/**
 * Assembles the ladder such that CALM is only reachable when the item list is
 * genuinely empty — collisions and broken collectors become items *here*, so
 * there is no later step at which a view could forget them (graft g5).
 */
function buildLadder(
  lanes: readonly Lane[],
  collisions: readonly CollisionEntry[],
  state: SessionState,
  now: number,
  evidence: CalmEvidence,
): Ladder {
  const items: AttentionItem[] = []

  for (const lane of lanes) {
    // A parked lane never reaches the ladder (prd4 ruling 5) — the operator's
    // declaration is the acknowledgement, so nothing of this lane's escalates
    // to the attention strip or the tab title, however many pathologies it
    // still carries. It is still visible everywhere else: the fleet table's
    // own STATE cell, fence column and output/age cells read the lane
    // directly and are untouched by this skip.
    if (lane.parked) continue
    for (const pathology of lane.pathologies) {
      items.push({
        id: `${pathology.kind}:${lane.id}`,
        laneId: lane.id,
        label: lane.label,
        kind: pathology.kind,
        rank: pathology.rank as Exclude<LadderRank, 'calm'>,
        forMs: pathology.since === null ? null : Math.max(0, now - pathology.since),
        evidence: pathology.evidence,
        inferred: pathology.inferred,
      })
    }
  }

  // Ruling 14: a real collision is ONE ladder item that expands, not one per
  // contended file. Twenty-one contended files would otherwise report as
  // twenty-one things needing you — wrong arithmetic and wrong triage alike.
  const worst = collisions[0]
  if (worst !== undefined) {
    items.push({
      id: 'collision',
      // A collision belongs to a pair of branches, not to one lane, so it must
      // not be able to put the scene's spotlight on an arbitrary half of it.
      laneId: null,
      label:
        collisions.length === 1
          ? worst.branches.join(' ⇄ ')
          : `${collisions.length} files contended`,
      kind: 'collision',
      rank: 'needs-you',
      forMs: null,
      evidence: `worst: ${worst.path} — ${worst.branches.join(', ')}`,
      inferred: false,
    })
  }

  // Ruling 15: a broken collector escalates to the strip rather than sitting
  // quietly in the provenance bar where nobody is looking.
  for (const collector of Object.values(state.collectors)) {
    if (collector.status !== 'error') continue
    items.push({
      id: `collector:${collector.name}`,
      laneId: null,
      label: `${collector.name} collector`,
      kind: 'collector',
      rank: 'notice',
      forMs: collector.lastErrorTs === null ? null : Math.max(0, now - collector.lastErrorTs),
      evidence: collector.lastErrorMessage ?? `${collector.errorCount} errors`,
      inferred: false,
    })
  }

  if (items.length === 0) return { rank: 'calm', items: [], evidence }

  items.sort(
    (a, b) =>
      rankIndex(b.rank) - rankIndex(a.rank) ||
      (b.forMs ?? 0) - (a.forMs ?? 0) ||
      compareStrings(a.id, b.id),
  )

  const rank = items.reduce<Exclude<LadderRank, 'calm'>>(
    (worstSoFar, item) => (rankIndex(item.rank) > rankIndex(worstSoFar) ? item.rank : worstSoFar),
    'notice',
  )

  return { rank, items: items as [AttentionItem, ...AttentionItem[]] }
}

/** Ruling 14: ALL CLEAR has to say what was checked to have earned it. */
function calmEvidenceOf(
  lanes: readonly Lane[],
  touches: Record<string, { path: string }[]>,
  collisions: readonly CollisionEntry[],
): CalmEvidence {
  const files = new Set<string>()
  for (const list of Object.values(touches)) for (const touch of list) files.add(touch.path)

  const branchesChecked = Object.keys(touches).length
  const filesChecked = files.size

  return {
    lanes: lanes.length,
    working: lanes.filter((lane) => lane.activity === 'working').length,
    branchesChecked,
    filesChecked,
    // Pinned to the literal `0`, and unreachable while collisions exist:
    // `buildLadder` never returns the calm case once one is in the list.
    collisions: 0,
    line: `collisions: 0 — checked ${branchesChecked} branch${
      branchesChecked === 1 ? '' : 'es'
    } / ${filesChecked} file${filesChecked === 1 ? '' : 's'}`,
  }
}

// ── gap voice (law 12) ──────────────────────────────────────────────────────

function buildGaps(
  state: SessionState,
  costTotals: ReturnType<typeof selectSessionSpend>,
  lanes: readonly Lane[],
  manifest: LaneManifest | null,
): Gap[] {
  const gaps: Gap[] = []
  const add = (id: string, what: string, why: string, command: string): void => {
    gaps.push({ id, what, why, command, line: `${what} — ${why} — run: ${command}` })
  }

  if (costTotals.costEventCount === 0) {
    add(
      'no-cost-feed',
      'NO COST FEED (OTel)',
      'dollars unavailable',
      'eval "$(rhizomorph env <lane>)"',
    )
  }

  if (manifest === null) {
    add(
      'no-lane-manifest',
      'NO LANE MANIFEST (.swarm/lanes.json)',
      'off-fence detection unavailable',
      'dispatch.sh (writes the fence manifest)',
    )
  } else {
    const unfenced = lanes.filter((lane) => !lane.fenced && !lane.telemetryOnly)
    if (unfenced.length > 0) {
      add(
        'unfenced-lanes',
        `NO FENCE FOR ${unfenced.length}/${lanes.length} LANES`,
        'those lanes cannot be judged off-fence',
        'dispatch.sh (writes the fence manifest)',
      )
    }
  }

  const unattributed = lanes.filter((lane) => lane.role === 'unattributed' && lane.outputTokens > 0)
  if (unattributed.length > 0) {
    add(
      'unattributed-spend',
      `UNATTRIBUTED SPEND (${unattributed.length} lane${unattributed.length === 1 ? '' : 's'})`,
      'burn has no declared owner',
      'eval "$(rhizomorph env <lane> --role worker)"',
    )
  }

  if (!state.telemetry.costs.some((record) => record.role === 'conductor')) {
    add(
      'conductor-not-instrumented',
      'CONDUCTOR NOT INSTRUMENTED',
      'orchestration overhead unknowable',
      'rhizomorph --extra-sessions <dir>:conductor',
    )
  }

  for (const collector of Object.values(state.collectors)) {
    if (collector.status !== 'disabled') continue
    add(
      `collector-disabled:${collector.name}`,
      `${collector.name.toUpperCase()} COLLECTOR DISABLED`,
      collector.disabledReason ?? 'source unavailable',
      'rhizomorph doctor',
    )
  }

  return gaps
}

// ── plumbing ────────────────────────────────────────────────────────────────

interface Draft {
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

function emptyDraft(id: string, seedTs: number): Draft {
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
function resolveLaneId(spend: LaneSpend, drafts: ReadonlyMap<string, Draft>): string {
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
function fenceHandleFor(manifest: LaneManifest, lane: Lane): string | null {
  for (const handle of lane.handles) if (manifest[handle] !== undefined) return handle
  if (manifest[lane.id] !== undefined) return lane.id
  if (lane.branch !== null && manifest[lane.branch] !== undefined) return lane.branch
  return null
}

function fenceFor(manifest: LaneManifest, draft: Draft, handles: readonly string[]) {
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
function sumActiveSeconds(
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
function waitedOnHumanFor(
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

function spanKey(traceId: string, spanId: string): string {
  return `${traceId}::${spanId}`
}

/** Every span's own `decision`, keyed by `(traceId, spanId)` — the fact `LongestWait` itself does not carry. */
function spanDecisionsByKey(state: SessionState): Map<string, SpanDecision | null> {
  const index = new Map<string, SpanDecision | null>()
  for (const span of state.traces.spans) index.set(spanKey(span.traceId, span.spanId), span.decision)
  return index
}

/**
 * The freshest subagent-activity row across every key a lane could be filed
 * under — same fallback order as {@link waitedOnHumanFor}. Null when none of
 * them has one (law 12's gap-honesty, not a zeroed bud).
 */
function subagentActivityFor(
  byLane: Readonly<Record<string, LaneSubagentActivity>>,
  laneId: string,
  branch: string | null,
  handles: readonly string[],
): LaneSubagentActivity | null {
  const keys = [laneId, ...(branch === null ? [] : [branch]), ...handles]
  let best: LaneSubagentActivity | null = null
  for (const key of keys) {
    const entry = byLane[key]
    if (entry === undefined) continue
    if (best === null || entry.lastActivityTs > best.lastActivityTs) best = entry
  }
  return best
}

function indexByLane(rows: readonly LaneSpend[]): Record<string, LaneSpend> {
  const index: Record<string, LaneSpend> = {}
  for (const row of rows) index[row.lane] = row
  return index
}

/**
 * Sums the rows for every handle that resolves to one lane. Undefined when no
 * handle had one — which is not the same as a lane that spent zero.
 */
function mergeSpend(rows: readonly (LaneSpend | undefined)[]): LaneSpend | undefined {
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

function filamentsOf(spend: LaneSpend | undefined): Filament[] {
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

/** Tool names per telemetry handle inside the loop window, oldest first. */
function recentToolsByHandle(state: SessionState, since: number): Map<string, string[]> {
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
function latestSpanTsByLane(state: SessionState, since: number): Map<string, number> {
  const latest = new Map<string, number>()
  for (const span of state.traces.spans) {
    if (span.ts < since) continue
    const current = latest.get(span.lane)
    if (current === undefined || span.ts > current) latest.set(span.lane, span.ts)
  }
  return latest
}

function latestCommitTsByBranch(state: SessionState): Map<string, number> {
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
function dominantRole(roles: readonly AgentRole[]): AgentRole {
  if (roles.includes('worker')) return 'worker'
  if (roles.includes('conductor')) return 'conductor'
  return roles[0] ?? 'unattributed'
}

/**
 * The non-pathological reading of a lane. Order matters: a declared stop beats
 * a clock, and `done` beats silence — that is what stops a finished fleet from
 * reading as a wall of flatlines.
 */
function activityOf(lane: Lane): LaneActivity {
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
function byAttentionThenSize(a: Lane, b: Lane): number {
  return (
    rankIndex(b.rank) - rankIndex(a.rank) ||
    b.outputTokens - a.outputTokens ||
    compareStrings(a.label, b.label)
  )
}

function perMinute(value: number, windowMs: number): number {
  const minutes = windowMs / 60_000
  return minutes === 0 ? 0 : value / minutes
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** The fenced-issue convention's number, e.g. `'75'` for `75-instrument-keystone`. */
function issueOf(label: string): string | null {
  return /^\d+/.exec(label)?.[0] ?? null
}

function isString(value: string | null): value is string {
  return value !== null
}

function maxTs(...values: readonly (number | null)[]): number | null {
  let best: number | null = null
  for (const value of values) {
    if (value === null) continue
    if (best === null || value > best) best = value
  }
  return best
}

function minTs(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

const ZERO_TOKEN_TOTALS: TokenTotals = {
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
