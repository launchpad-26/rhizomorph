import type { ArmInput, ArmState } from './branching/index.js'
import type { Arm as CompareArm, ComparisonInput, Run as CompareRun } from './compare/index.js'
import type { LabArm, LabArmOutcome, LabExperiment, LabRun } from './types.js'

/**
 * THIN ADAPTERS (prd14 wave 5, the assembly wave) — `lab/branching/` and
 * `lab/compare/` both took plain inputs by design, each leaving "wiring this
 * to the real launch/checkpoint types" as a later, trivial adapter (their own
 * file docs say exactly that). These two functions are that adapter: they
 * translate `lab/types.ts` shapes into each module's own vocabulary and
 * invent no fact the fixed types don't already carry.
 *
 * `LabArm.outcome` is undefined until a comparison has actually measured the
 * arm (`types.ts`'s own doc) — and today `server/src/api/lab.ts`'s
 * `LabExperimentDTO` has no `outcome` field at all, so every arm the real
 * server answers with reads as still running. That is not a gap this adapter
 * papers over: an arm nobody has measured yet IS, honestly, still running.
 */

function armState(arm: LabArm): ArmState {
  if (arm.outcome === undefined) return 'running'
  // 'not-run' means the gate never ran for this arm — read as abandoned
  // (dead), distinct from a measured pass or fail (both finished).
  if (arm.outcome.verified === 'not-run') return 'dead'
  return 'finished'
}

/**
 * `lab/branching/`'s plain `ArmInput[]` (prd14 ruling 1) — one experiment's
 * arms, kept in the order they arrive in the experiment so the layout's own
 * "arms keep the order they arrive in" law has a caller that agrees with it.
 */
export function toBranchingArms(experiment: LabExperiment): ArmInput[] {
  return experiment.arms.map((arm) => ({ id: `arm-${arm.arm}`, state: armState(arm) }))
}

/**
 * True once at least one arm carries a measured outcome. The assembly law
 * this backs: a launched-but-running experiment (every arm still `running`)
 * shows its arms without a comparison, rather than a comparison surface full
 * of "too few runs to summarise" — an honestly empty comparison is still the
 * empty comparison the direction asks this console not to show.
 */
export function experimentHasOutcome(experiment: LabExperiment): boolean {
  return experiment.arms.some((arm) => arm.outcome !== undefined)
}

/**
 * The brief's own text never reaches this console (`LabTreatment`'s own doc:
 * the operator's words are never copied into an artifact) — only its digest.
 * `LabPage`'s existing experiments listing already reads a digest this same
 * way; this mirrors it rather than inventing a second convention.
 */
function briefLabel(promptDigest: string | null): string {
  return promptDigest === null ? 'no-brief' : promptDigest.slice(0, 8)
}

function toCompareRun(run: LabRun, outcome: LabArmOutcome | undefined): CompareRun {
  if (outcome === undefined) return { id: run.eventId, status: 'pending' }
  if (outcome.verified !== 'pass') {
    return outcome.verifiedDetail === null
      ? { id: run.eventId, status: 'failed' }
      : { id: run.eventId, status: 'failed', error: outcome.verifiedDetail }
  }
  // Verified pass, but nothing has been booked to the ledger yet: there is no
  // honest number to compare with, so this reads as still pending rather than
  // a fabricated value.
  if (outcome.costUsd === null) return { id: run.eventId, status: 'pending' }
  return { id: run.eventId, status: 'complete', value: outcome.costUsd }
}

function toCompareArm(arm: LabArm): CompareArm {
  return {
    id: `arm-${arm.arm}`,
    model: arm.treatment.model ?? 'default',
    brief: briefLabel(arm.treatment.promptDigest),
    runs: arm.runs.map((run) => toCompareRun(run, arm.outcome)),
  }
}

/** `lab/compare/`'s plain `ComparisonInput` (prd14 ruling 3) — one experiment's arms, each with its own runs. */
export function toComparisonInput(experiment: LabExperiment): ComparisonInput {
  return { arms: experiment.arms.map(toCompareArm) }
}
