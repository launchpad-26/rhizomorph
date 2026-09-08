/**
 * THE LABORATORY'S LAWS — prd53 ruling 2: one floor, one confound clause, one
 * counterfactual clause, in core, and every surface reads the same function.
 *
 * Before this module there were two floors with two denominators: the CLI's
 * `MIN_ARMS_TO_RANK` counted ARMS (`server/src/lab/compare.ts`) and the
 * console's summariser counted COMPLETED RUNS (`web/src/lab/compare/
 * summarise.ts`). Both were right about different questions, and neither
 * could see the other, so the CLI and the browser could report the same data
 * differently. Both questions live here now, named for what they gate:
 *
 * - {@link canSummariseArm} — may a SUMMARY be stated about one arm? Gated by
 *   completed runs of that arm. Below the floor an arm has observations, not a
 *   distribution ({@link COUNTERFACTUAL_CLAUSE}).
 * - {@link canRankArms} — may a CROSS-ARM claim be stated? Gated by arms.
 *   prd12 ruling 4's floor, extended here and never loosened: below three arms
 *   a comparison reports what happened, never which arm was better.
 *
 * The confound clause is the third law ({@link confoundVoice}): arms that
 * differ in model AND brief cannot attribute a difference to either, and every
 * surface says so in the same words rather than printing a ranked spread with
 * no warning — which is what the CLI did before this module existed.
 *
 * Pure and browser-safe (ADR-0003): no `node:*`, no I/O, no zod even — these
 * are counts and sentences. A consumer that restates a number here locally is
 * what `compare.test.ts`'s grep law exists to catch.
 */

/** A summary of one arm needs this many COMPLETED runs of it. prd12 ruling 4's "three", read per run (prd53 ruling 2). */
export const MIN_COMPLETED_RUNS_TO_SUMMARISE = 3

/** A cross-arm claim — a ranking, a distribution across arms — needs this many ARMS. prd12 ruling 4, unchanged. */
export const MIN_ARMS_TO_RANK = 3

/** May a summary statistic be stated about an arm with this many completed runs? */
export function canSummariseArm(completedRuns: number): boolean {
  return Number.isInteger(completedRuns) && completedRuns >= MIN_COMPLETED_RUNS_TO_SUMMARISE
}

/** May a claim be made ACROSS arms — a distribution, a ranking — given this many arms? */
export function canRankArms(arms: number): boolean {
  return Number.isInteger(arms) && arms >= MIN_ARMS_TO_RANK
}

/**
 * Below the floor this is the whole of what may be said. One observation is a
 * fact about one run; it is not evidence about the treatment.
 */
export const COUNTERFACTUAL_CLAUSE = 'what actually happened is one observation, not a distribution'

/** The two treatment dimensions an arm may vary (prd14 ruling 2 — free-form, but these are the two the record holds). */
export interface LabTreatmentLike {
  model: string | null
  promptDigest: string | null
}

export interface ExperimentDimensions {
  modelVaries: boolean
  promptVaries: boolean
}

/** Which dimensions differ across these treatments. Order-free; one or zero arms vary nothing. */
export function dimensionsOf(treatments: readonly LabTreatmentLike[]): ExperimentDimensions {
  const models = new Set(treatments.map((treatment) => treatment.model))
  const prompts = new Set(treatments.map((treatment) => treatment.promptDigest))
  return { modelVaries: models.size > 1, promptVaries: prompts.size > 1 }
}

/**
 * Exactly one dimension varies — the only shape in which a difference between
 * arms can be attributed to anything. Zero varying dimensions is a replication
 * (honest, but not a comparison of treatments); two is a confound.
 */
export function isCleanlyControlled(dimensions: ExperimentDimensions): boolean {
  return (dimensions.modelVaries ? 1 : 0) + (dimensions.promptVaries ? 1 : 0) === 1
}

/** The one sentence every surface prints for a confounded experiment. */
export const CONFOUND_VOICE = 'these arms differ in model and brief — a difference cannot be attributed to either'

/** {@link CONFOUND_VOICE} when both dimensions vary; null otherwise. Surfaces print it verbatim or not at all. */
export function confoundVoice(dimensions: ExperimentDimensions): string | null {
  return dimensions.modelVaries && dimensions.promptVaries ? CONFOUND_VOICE : null
}
