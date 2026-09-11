/**
 * THE LAB'S SHARED VOCABULARY (prd14 wave 1) — every name the rest of the
 * console (launch, branching, comparison — waves 2–4, sibling lanes) imports
 * from. Derived from what the engine actually emits, never invented in
 * parallel:
 *
 * - {@link LabCheckpoint} mirrors `CheckpointRecord`
 *   (`packages/core/src/state.ts`) — the fold of one `fork.checkpoint` event
 *   (`packages/core/src/events/lab.ts`).
 * - {@link LabExperiment} / {@link LabArm} / {@link LabRun} mirror
 *   `ForkState`/`ForkDispatchRecord` — the fold of `fork.dispatched` events,
 *   grouped by `forkId` (an experiment) and then by `arm` (one arm, r
 *   recorded runs of it — prd53 ruling 1).
 * - {@link LabRunOutcome} mirrors `LabRunOutcomeDTO`
 *   (`packages/server/src/api/lab.ts`) — the fold of the newest
 *   `fork.measured` for a run, with its provenance (prd53 ruling 3).
 *
 * prd14 ruling 2 — free-form arms, the reporting carries the rigour: each
 * arm carries its OWN {@link LabTreatment} (model + brief), configured
 * independently. There is no separate "experiment-wide knob" type here on
 * purpose; a shape like that would let the console declare a shared
 * dimension the arms could then disagree with. What differs between arms is
 * never declared — {@link computeExperimentDimensions} always COMPUTES it
 * from the arms actually present, which is why every arm must carry its own
 * full treatment rather than pointing at a shared one. Since prd53 ruling 2
 * the computation itself is core's (`dimensionsOf`), so this console and the
 * CLI table cannot disagree about which dimensions vary or what a confound is.
 */

import { dimensionsOf, type ExperimentDimensions } from '@rhizomorph/core'

export { isCleanlyControlled } from '@rhizomorph/core'

/** Who triggered a checkpoint capture — mirrors `forkCheckpointCapturedBySchema` (`core/events/lab.ts`). */
export type LabCheckpointCapturedBy = 'dispatch' | 'gate' | 'operator'

/**
 * One `fork.checkpoint` capture: a scrub point a lane can be forked from.
 * prd12 ruling 2 — captured live, never synthesized after the fact.
 */
export interface LabCheckpoint {
  /** The `fork.checkpoint` event's own id. */
  eventId: string
  /** The lane this checkpoint was captured from. */
  lane: string
  checkpointId: string
  /** When the capture ran (event ts, epoch ms). */
  capturedAt: number
  capturedBy: LabCheckpointCapturedBy
  /** The namespaced ref the snapshot commit lives under (prd12 ruling 1's write fence). */
  snapshotRef: string
  snapshotSha: string
  /** HEAD at capture time — the snapshot commit's parent. */
  headSha: string
  /** Where in the lane's session the cut fell — the tie-break for two cuts at one byte (prd53 S1). */
  eventIndex: number
  /** The byte the session was cut at; position on the axis is this over `sessionByteLength`, never wall-clock. */
  sessionCutByte: number
  /** The session file's length now, or null when it cannot be read — S1's degraded state, a marker with its reason. */
  sessionByteLength: number | null
}

/**
 * What was configured for one arm — prd14 ruling 2: free-form, the arm's
 * own model and brief, never a value shared with its siblings. Both fields
 * nullable: an arm may vary neither (it ran the fleet/lane default of each).
 */
export interface LabTreatment {
  /** Model handle the arm's agent ran, or null when it inherited the default. */
  model: string | null
  /**
   * sha256 digest of the arm's brief (prompt file), or null when it ran
   * without one. The brief's own text is the operator's, never copied into
   * an artifact (see `core/events/lab.ts`'s `forkTreatmentSchema` doc) — this
   * is the one honest way to say "these two arms ran the same brief" or "this
   * arm's brief differed" without holding the words themselves.
   */
  promptDigest: string | null
}

/** Who ran the gate, which command, and when — an outcome without these is a bare tick nobody can check. */
export interface LabOutcomeProvenance {
  source: 'measure-route' | 'compare-cli'
  verifyCommand: string
  /** When the gate ran (the `fork.measured` event's ts, epoch ms). */
  measuredAt: number
}

/**
 * prd53 ruling 3 — ONE RUN's measured outcome. Absent until something has
 * actually run the run's gate — never invented, never defaulted to a zero or
 * a guess. `not-run` is a legal outcome and means exactly that: the gate did
 * not run, and no outcome stands in for the one it would have given.
 *
 * This replaces prd14 wave 1's arm-level `LabArmOutcome`, which handed every
 * run in an arm the same verdict — wrong the moment an arm held two runs
 * (prd53 ruling 1).
 */
export interface LabRunOutcome {
  verified: 'pass' | 'fail' | 'not-run'
  /** Why `verified` is what it is — a failing command's first line, or the reason it was not run. */
  verifiedDetail: string | null
  /** Dollars booked to this run's lane in the event log. Null when nothing has been recorded yet. */
  costUsd: number | null
  /** Dispatch → newest recorded event for the run's lane, in ms. Null when nothing has been recorded since. */
  durationMs: number | null
  /** Commits the run made on top of its restored checkpoint. Null when its worktree could not be read. */
  commits: number | null
  provenance: LabOutcomeProvenance
}

/**
 * One recorded run of an arm — its own worktree, its own handle, and (once
 * measured) its own outcome. prd14 ruling 3's "n runs of one arm, shown
 * individually, never collapsed" is a fact of the record since prd53 ruling 1.
 */
export interface LabRun {
  /** The `fork.dispatched` event's own id. */
  eventId: string
  /** When this run was dispatched (event ts, epoch ms). */
  dispatchedAt: number
  /** 1-based run within its arm (prd53 ruling 1). */
  run: number
  /** The synthetic lane handle this run executes under. */
  laneHandle: string
  /** Absolute path of the restored worktree this run executes in. */
  worktreePath: string
  /** Present only once this run has been measured (prd53 ruling 3). */
  outcome?: LabRunOutcome
}

/**
 * One arm of an experiment: an independently-configured reality forked from
 * the same checkpoint (prd14 ruling 2), holding r runs.
 */
export interface LabArm {
  /** 1-based arm number within its experiment. */
  arm: number
  treatment: LabTreatment
  runs: LabRun[]
}

/**
 * One experiment: n arms forked from one checkpoint of one lane (prd12
 * ruling 6's "fork"; prd14 names it for the operator). Grouped by `forkId` —
 * every arm of one experiment shares it.
 */
export interface LabExperiment {
  forkId: string
  /** The real lane that was forked. */
  parentLane: string
  /** The checkpoint every arm of this experiment was restored from. */
  checkpointId: string
  arms: LabArm[]
}

/**
 * Which dimensions this experiment's arms actually differ on — prd14 ruling
 * 2: "the dimensions that differ are computed from the arms, not declared by
 * the operator — a declared intent can be wrong, the configuration cannot."
 * Never stored, never carried on the wire: always derived fresh from
 * {@link LabExperiment.arms} by {@link computeExperimentDimensions}. The
 * shape is core's (`ExperimentDimensions`, prd53 ruling 2).
 */
export type LabExperimentDimensions = ExperimentDimensions

/** How many of an experiment's arms actually differ on model and/or brief — computed by core, never declared (ruling 2). */
export function computeExperimentDimensions(experiment: LabExperiment): LabExperimentDimensions {
  return dimensionsOf(experiment.arms.map((arm) => arm.treatment))
}

// --- prd-55 wave 6 — the R&D tab's DTOs (ruling 1, 2, 3, 4, 9; S5) ----------
//
// Mirror the R&D route's answer (`/api/lab/rd`'s `RdResult`, `packages/server/src/api/
// lab.ts`) field for field, the same discipline `LabCheckpoint`/`LabExperiment`
// keep with the two GET routes above — a shape the route does not send is a
// shape this console does not invent. `packages/core/src/events/lab.ts`'s
// `rdProvenanceSchema` names `total_cost_usd`/`duration_ms` in snake_case ON
// PURPOSE ("a direct copy of what the CLI returned, not a rhizomorph-shaped
// figure") and this DTO keeps that spelling for the same reason: the
// provenance line's cost must equal the event's, and renaming the field here
// would be one more place the two could quietly drift.

/** Which corpus a run read (prd-55 ruling 2) — the record `lab.rdCorpus` declares. */
export type LabRdCorpusChoice = 'local' | 'local+tracker'

/** The closed vocabulary a proposal's arms may vary in (prd-55 ruling 3). */
export type LabRdVariesDimension = 'model' | 'brief' | 'checkpoint' | 'gate'

/** Every rd.* run's audit trail (ruling 1) — the CLI's own reported figures, copied never re-derived. */
export interface LabRdProvenance {
  model: string
  total_cost_usd: number
  duration_ms: number
  promptDigest: string
  corpusDigest: string
  claudeVersion: string
  corpus: LabRdCorpusChoice
}

/** One pattern the hand grouped from the corpus (ruling 3). */
export interface LabRdPattern {
  patternId: string
  shape: string
  sourceItems: string[]
  count: number
  heldBack: boolean
}

/** What one arm of a proposal carries on each of the four dimensions (ruling 3). `null` means the arm inherits the default. */
export interface LabRdArm {
  model: string | null
  briefDigest: string | null
  checkpointId: string | null
  gateCommand: string | null
}

/** One checkpoint the hand considered and did not choose, with why (ruling 3). */
export interface LabRdCheckpointConsideration {
  checkpointId: string
  reason: string
}

/** The hand's checkpoint pick (ruling 3): the chosen checkpoint, and every considered-and-rejected one with its reason. */
export interface LabRdCheckpointPick {
  chosenCheckpointId: string
  rejected: LabRdCheckpointConsideration[]
}

/** One clean, single-dimension proposal the hand drew from a pattern (ruling 3). */
export interface LabRdProposal {
  proposalId: string
  patternId: string
  varies: LabRdVariesDimension
  arms: LabRdArm[]
  checkpointPick: LabRdCheckpointPick
}

/** A proposal the pure laws refused (ruling 3, ruling 9) — the reason, verbatim, beside the pattern it was drawn from. */
export interface LabRdRefusal {
  patternId: string
  reason: string
}

/** What corpus was read, and how much of it (ruling 2) — never the items' own text, which this route does not send back. */
export interface LabRdCorpusSummary {
  choice: LabRdCorpusChoice
  digest: string
  itemCount: number
  /** Set when `local+tracker` was asked for and `gh` could not answer. */
  trackerRefusal: string | null
}

/** One R&D route (`/api/lab/rd`) answer, parsed (`rd/rd.ts`'s `requestRd`). */
export interface LabRdRun {
  lane: string
  /** False means the operator's CLI is not on the server's PATH — `reason` is the sentence, verbatim, and nothing was spawned. */
  available: boolean
  reason: string | null
  corpus: LabRdCorpusSummary
  patterns: LabRdPattern[]
  proposals: LabRdProposal[]
  refusals: LabRdRefusal[]
  provenance: LabRdProvenance | null
  turns: number
}
