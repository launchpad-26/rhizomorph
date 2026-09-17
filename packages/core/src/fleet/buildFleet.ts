import {
  compareStrings,
  DEFAULT_SPEND_WINDOW_MS,
  type LaneSpend,
  selectActiveSecondsByLaneIndex,
  selectCollisions,
  selectLaneSpend,
  selectRoleSpend,
  selectSessionSpend,
  selectSpendRateByLane,
  selectSubagentActivityIndex,
  selectTouchesByBranch,
  selectWorktreeViews,
} from '../selectors/index.js'
import { bucketizeSeries } from '../spark/index.js'
import type { AgentProcess, SessionState } from '../state.js'
import {
  EXPENSIVE_FLOOR_PER_MIN,
  EXPENSIVE_MULTIPLE,
  LOOP_WINDOW_MS,
  SPAN_WITNESS_WINDOW_MS,
  SPARK_BUCKET_COUNT,
  SPARK_WINDOW_MS,
  TOKEN_ORIGINS,
} from './constants.js'
import { diagnose, isTerminalDone } from './diagnose.js'
import { findTrespasses } from './fences.js'
import { buildGaps } from './gaps.js'
import { buildLadder, calmEvidenceOf, errorCountsOf } from './ladder.js'
import { type LadderRank, worseRank } from './pathology.js'
import {
  activityOf,
  byAttentionThenSize,
  type Draft,
  dominantRole,
  emptyDraft,
  fenceFor,
  fenceHandleFor,
  filamentsOf,
  indexByLane,
  issueOf,
  latestCommitTsByBranch,
  latestSpanTsByLane,
  maxTs,
  median,
  mergeSpend,
  outputTokenEventsByHandle,
  perMinute,
  recentToolsByHandle,
  resolveLaneId,
  spanDecisionsByKey,
  subagentActivityFor,
  sumActiveSeconds,
  waitedOnHumanFor,
  ZERO_TOKEN_TOTALS,
} from './plumbing.js'
import type { BuildFleetOptions, Fleet, Lane } from './types.js'

export {
  EXPENSIVE_FLOOR_PER_MIN,
  EXPENSIVE_MULTIPLE,
  FROZEN_AFTER_MS,
  IDLE_AFTER_MS,
  LOOP_MAX_PERIOD,
  LOOP_MIN_PERIOD,
  LOOP_MIN_REPEATS,
  LOOP_WINDOW_MS,
  SPAN_WITNESS_WINDOW_MS,
  SPARK_BUCKET_COUNT,
  SPARK_WINDOW_MS,
  WAITING_PANE_FRESH_MS,
  WAITING_QUIET_MS,
} from './constants.js'
export { findCycle, isTerminalDone } from './diagnose.js'
export {
  DIAGNOSED_KINDS,
  evidenceLine,
  INFERRED_MARK,
  LADDER_ORDER,
  LADDER_WORD,
  type LadderRank,
  PATHOLOGY_KINDS,
  PATHOLOGY_RANK,
  PATHOLOGY_WORD,
  type Pathology,
  type PathologyKind,
  rankIndex,
  worseRank,
} from './pathology.js'
export { formatSpan } from './plumbing.js'
export {
  type AttentionItem,
  type AttentionKind,
  type BuildFleetOptions,
  type Burn,
  type CalmEvidence,
  type Filament,
  type Fleet,
  type Gap,
  type Ladder,
  type Lane,
  type LaneActivity,
  type LaneWaitedOnHuman,
  type RootMass,
} from './types.js'

/**
 * THE ONE DERIVED FLEET OBJECT.
 *
 * The attention strip, the fleet table, the burn strip and the scene are four
 * views of *this*, and of nothing else. That is the whole point: four surfaces
 * that each re-derive "how many lanes are working" will eventually disagree by
 * one, in public, on the one screen whose job is to be trusted at a glance.
 *
 * Everything below is derived by this package's own selectors over the same
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
  const usageEventsByHandle = outputTokenEventsByHandle(state, now - SPARK_WINDOW_MS, TOKEN_ORIGINS)
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
    draft.agentStatusWitness = view.agent?.witness ?? null
    draft.agentStatusDetail = view.agent?.detail ?? null
    draft.agentStatusDissent = view.agent?.dissent ?? null
    draft.aheadOfMain = view.aheadOfMain
    draft.dirtyCount = view.dirtyCount
    draft.dirtyStatusFailedSince = view.dirtyStatusFailedSince
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

  // The conductor's own telemetry handles — collected as they are met so
  // `subagentActivityFor` can look its bud up the same way a lane's is, off the
  // exact set of handles this file already resolved to the root rather than a
  // re-derived guess.
  const rootHandles = new Set<string>()

  let conductorOutputTokens = 0
  for (const spend of Object.values(tokenSpend)) {
    if (isRootSpend(spend)) {
      conductorOutputTokens += spend.tokens.output
      rootHandles.add(spend.lane)
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
    if (isRootSpend(spend)) {
      rootHandles.add(spend.lane)
      continue
    }
    claim(spend)
  }

  // --- fill the numbers -----------------------------------------------------
  /**
   * prd-57 ruling 1: actors indexed by the place they are in, built once rather
   * than re-scanned per lane.
   *
   * A GONE actor is kept in the index deliberately. The lane still holds it,
   * because ruling 5 reaches `crashed` from a `gone` that follows a `seen` —
   * dropping the row here would destroy the first half of that pair before the
   * raiser ever sees it. A reader that wants only live actors filters on
   * `goneAt`, which is a fact this object states rather than one it hides.
   *
   * An UNROOTED actor — one whose cwd is in no git worktree — belongs to no
   * lane and appears in no bucket. It is not lost: prd-58 ruling 6 gives that
   * case a home, and until then it lives in `state.processes` where anything
   * can still read it.
   */
  const actorsByWorktree = new Map<string, AgentProcess[]>()
  for (const actor of Object.values(state.processes)) {
    if (actor.worktreePath === null) continue
    const bucket = actorsByWorktree.get(actor.worktreePath)
    if (bucket === undefined) actorsByWorktree.set(actor.worktreePath, [actor])
    else bucket.push(actor)
  }

  const lanes: Lane[] = []
  for (const draft of drafts.values()) {
    const handles = [...draft.handles].sort(compareStrings)
    const tokens = mergeSpend(handles.map((handle) => tokenSpend[handle]))
    const costs = mergeSpend(handles.map((handle) => costSpend[handle]))
    const outputPerMin = handles.reduce(
      (sum, handle) => sum + perMinute(tokenRates[handle]?.totals.tokens.output ?? 0, windowMs),
      0,
    )
    const costUsdPerHour = handles.reduce((sum, handle) => sum + (costRates[handle]?.costUsdPerHour ?? 0), 0)
    const costRateEventCount = handles.reduce(
      (sum, handle) => sum + (costRates[handle]?.totals.costEventCount ?? 0),
      0,
    )
    const costRateEstimatedEventCount = handles.reduce(
      (sum, handle) => sum + (costRates[handle]?.totals.estimatedCostEventCount ?? 0),
      0,
    )
    const costRateIsAuthoritative = costRateEventCount === 0 ? null : costRateEstimatedEventCount === 0
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
    const recentOutputTokens = bucketizeSeries(
      handles.flatMap((handle) => usageEventsByHandle.get(handle) ?? []),
      { now, windowMs: SPARK_WINDOW_MS, bucketCount: SPARK_BUCKET_COUNT, sinceTs: draft.firstSeenAt },
    )
    const waitedOnHuman = waitedOnHumanFor(state, draft.id, draft.branch, handles, spanDecisionByKey)
    const subagents = subagentActivityFor(subagentActivityByLane, [
      draft.id,
      ...(draft.branch === null ? [] : [draft.branch]),
      ...handles,
    ])
    // prd-27 ruling 3 (#283): a beacon whose lane matches no draft id is simply
    // never read — no lane, no alarm (the #133 shape: a summons for a lane
    // nobody can attach to is a false summons in a new costume).
    const declaredRecord = state.declared[draft.id]

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
      agentStatusWitness: draft.agentStatusWitness,
      declared:
        declaredRecord === undefined
          ? null
          : { kind: declaredRecord.kind, at: declaredRecord.at, writer: declaredRecord.writer },
      activity: 'unknown',
      // prd-57 ruling 1. Placement is compared, never normalised: the collector
      // canonicalises before the event leaves it, because `canonicalize`
      // imports `node:fs` and ADR-0003 keeps that out of this package. A
      // `worktreePath` that arrived uncanonical would simply not match here,
      // which is why the obligation sits at the collector and is stated in the
      // schema rather than trusted.
      actors: draft.worktreePath === null ? [] : actorsByWorktree.get(draft.worktreePath) ?? [],

      tokens: tokens?.tokens ?? ZERO_TOKEN_TOTALS,
      outputTokens: tokens?.tokens.output ?? 0,
      costUsd: costs?.costUsd ?? 0,
      costIsAuthoritative: costs?.costIsAuthoritative ?? null,
      costEventCount: costs?.costEventCount ?? 0,
      requestCount: tokens?.requestCount ?? 0,
      toolCallCount: tokens?.toolCallCount ?? 0,
      outputPerMin,
      costUsdPerHour,
      costRateIsAuthoritative,
      recentOutputTokens,
      filaments: filamentsOf(tokens),
      model: fence?.model ?? null,

      aheadOfMain: draft.aheadOfMain,
      commitCount: draft.commitCount,
      dirtyCount: draft.dirtyCount,
      filesTouched: draft.filesTouched,
      dirtyStatusFailedSince: draft.dirtyStatusFailedSince,

      lastEventTs,
      ageMs: lastEventTs === null ? null : Math.max(0, now - lastEventTs),
      lastWorkTs,
      workAgeMs: lastWorkTs === null ? null : Math.max(0, now - lastWorkTs),
      dirtyStatusFailedForMs:
        draft.dirtyStatusFailedSince === null ? null : Math.max(0, now - draft.dirtyStatusFailedSince),
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
    // Committed touches only (issue #226) — matching `scripts/gate.sh`'s own
    // `git diff main...HEAD`, the committed diff against merge-base. A file a
    // lane only ever dirtied (package-lock.json, churned by every `npm
    // install`, chief among them) is invisible to the gate and must be
    // invisible here too, or the glass accuses a lane of a breach the gate
    // never would.
    const touched = lane.branch === null ? [] : (touches[lane.branch] ?? []).filter((t) => t.committed).map((t) => t.path)
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
      agentStatusDetail: draft.agentStatusDetail,
      agentStatusDissent: draft.agentStatusDissent,
      commitTs: lane.branch === null ? null : (commitTsByBranch.get(lane.branch) ?? null),
    })
    lane.rank = lane.pathologies.reduce<LadderRank>((worst, p) => worseRank(worst, p.rank), 'calm')
    lane.activity = activityOf(lane)
    // A lane FROZEN exempted as terminal-done (issue #226) reads DONE, not
    // IDLE — `activityOf` has no way to see that exemption on its own, so it
    // is applied here, off the same fact `detectFrozen` already read.
    if (lane.activity !== 'done' && isTerminalDone(lane)) lane.activity = 'done'
  }

  lanes.sort(byAttentionThenSize)

  const evidence = calmEvidenceOf(lanes, touches, collisions)
  const ladder = buildLadder(lanes, collisions, state, now, evidence)
  const errorCounts = errorCountsOf(lanes)

  const commitsHome = mainBranch === null ? 0 : (state.branches[mainBranch]?.commits.length ?? 0)
  const rootSubagents = subagentActivityFor(subagentActivityByLane, [
    ...(mainBranch === null ? [] : [mainBranch]),
    ...rootHandles,
  ])

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
      subagents: rootSubagents,
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
      errorCount: errorCounts.total,
      errorBlockedCount: errorCounts.blocked,
      errorParkedCount: errorCounts.parked,
      errorOffFenceCount: errorCounts.offFence,
    },
    collisions,
    gaps: buildGaps(state, costTotals, lanes, manifest),
    hasLaneManifest: manifest !== null,
    eventCount: state.eventCount,
  }
}
