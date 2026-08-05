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
 *   grouped by `forkId` (an experiment) and then by `arm` (one arm, one or
 *   more recorded runs of it).
 *
 * prd14 ruling 2 — free-form arms, the reporting carries the rigour: each
 * arm carries its OWN {@link LabTreatment} (model + brief), configured
 * independently. There is no separate "experiment-wide knob" type here on
 * purpose; a shape like that would let the console declare a shared
 * dimension the arms could then disagree with. What differs between arms is
 * never declared — {@link computeExperimentDimensions} always COMPUTES it
 * from the arms actually present, which is why every arm must carry its own
 * full treatment rather than pointing at a shared one.
 */

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

/**
 * One recorded dispatch of an arm. Today an arm is dispatched exactly once —
 * `dispatchFork` mints one `fork.dispatched` per arm number — so `LabArm.runs`
 * always holds one entry in practice. The shape is a list, not a single run,
 * so prd14 ruling 3's "n runs of one arm, shown individually, never
 * collapsed" is representable the day the engine grows repeat dispatch,
 * without another shape change rippling through every consumer.
 */
export interface LabRun {
  /** The `fork.dispatched` event's own id. */
  eventId: string
  /** When this run was dispatched (event ts, epoch ms). */
  dispatchedAt: number
  /** The synthetic lane handle this run executes under. */
  laneHandle: string
  /** Absolute path of the restored worktree this run executes in. */
  worktreePath: string
}

/**
 * prd12 ruling 4 / prd14 ruling 3's measured result for one arm: runs and
 * spread, never a point. Absent until a comparison has actually run the
 * arm's gate — never invented, never defaulted to a zero or a guess. Wave 1
 * declares the shape; computing it is `lab/compare.ts`'s job (wave 4).
 */
export interface LabArmOutcome {
  verified: 'pass' | 'fail' | 'not-run'
  /** Why `verified` is what it is — a failing command's first stderr line, or the reason it was not run. */
  verifiedDetail: string | null
  /** Dollars booked to this arm's lane in the event log. Null when nothing has been recorded yet. */
  costUsd: number | null
  /** Dispatch → newest recorded event for the arm's lane, in ms. Null when nothing has been recorded since. */
  durationMs: number | null
  /** Commits the arm made on top of its restored checkpoint. Null when its worktree could not be read. */
  commits: number | null
}

/**
 * One arm of an experiment: an independently-configured reality forked from
 * the same checkpoint (prd14 ruling 2). `outcome` is undefined until a
 * comparison has measured it — a wave-1 listing never fabricates one.
 */
export interface LabArm {
  /** 1-based arm number within its experiment. */
  arm: number
  treatment: LabTreatment
  runs: LabRun[]
  outcome?: LabArmOutcome
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
 * {@link LabExperiment.arms} by {@link computeExperimentDimensions}.
 */
export interface LabExperimentDimensions {
  modelVaries: boolean
  promptVaries: boolean
}

/** How many of an experiment's arms actually differ on model and/or brief — computed, never declared (ruling 2). */
export function computeExperimentDimensions(experiment: LabExperiment): LabExperimentDimensions {
  const models = new Set(experiment.arms.map((arm) => arm.treatment.model))
  const prompts = new Set(experiment.arms.map((arm) => arm.treatment.promptDigest))
  return { modelVaries: models.size > 1, promptVaries: prompts.size > 1 }
}

/**
 * True exactly when arms differ in ONE dimension — ruling 2's "compared
 * properly" case, eligible for the full ruling-3 spread treatment. Two or
 * more varying dimensions means a difference cannot be attributed to either,
 * and the reporting surface must say so rather than imply a conclusion.
 */
export function isCleanlyControlled(dimensions: LabExperimentDimensions): boolean {
  return (dimensions.modelVaries ? 1 : 0) + (dimensions.promptVaries ? 1 : 0) === 1
}
