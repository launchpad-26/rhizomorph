import type { ArmInput, ArmState } from './branching/index.js'
import type { Arm as CompareArm, Run as CompareRun, ComparisonInput } from './compare/index.js'
import type { LabArm, LabExperiment, LabRun } from './types.js'

/**
 * THIN ADAPTERS (prd14 wave 5, the assembly wave) — `lab/branching/` and
 * `lab/compare/` both took plain inputs by design, each leaving "wiring this
 * to the real launch/checkpoint types" as a later, trivial adapter (their own
 * file docs say exactly that). These functions are that adapter: they
 * translate `lab/types.ts` shapes into each module's own vocabulary and
 * invent no fact the fixed types don't already carry.
 *
 * Since prd53 ruling 3 an outcome is PER RUN (`LabRun.outcome`), read off the
 * newest `fork.measured` the server folded for that run. Before that the
 * console carried an arm-level outcome nothing ever populated, and handed
 * every run in an arm the same verdict — wrong the moment an arm held two
 * runs. A run nobody has measured has no outcome, and reads as exactly that.
 */

/** The one sentence for a run with no verdict — `not-run` included. Nothing is invented in its place. */
export const NOT_MEASURED_VOICE = 'not measured yet — no outcome is invented in its place'

/**
 * What a run's outcome says, in words a surface can print. An unmeasured run
 * and a `not-run` verdict both read as not measured: in neither case did a
 * gate judge the run, and a "failed" would be a claim nobody made.
 */
export function runOutcomeVoice(run: LabRun): string {
  if (run.outcome === undefined || run.outcome.verified === 'not-run') return NOT_MEASURED_VOICE
  const by = `${run.outcome.provenance.verifyCommand} (${run.outcome.provenance.source})`
  if (run.outcome.verified === 'pass') return `passed ${by}`
  return run.outcome.verifiedDetail === null ? `failed ${by}` : `failed ${by}: ${run.outcome.verifiedDetail}`
}

/**
 * An arm is running until one of its runs has been judged; finished once any
 * run passed or failed; dead only when every judged run reports the gate did
 * not run at all.
 */
function armState(arm: LabArm): ArmState {
  const outcomes = arm.runs.map((run) => run.outcome).filter((outcome) => outcome !== undefined)
  if (outcomes.length === 0) return 'running'
  if (outcomes.every((outcome) => outcome.verified === 'not-run')) return 'dead'
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
 * True once at least one run carries a measured outcome. The assembly law
 * this backs: a launched-but-running experiment (every run still unmeasured)
 * shows its arms without a comparison, rather than a comparison surface full
 * of "too few runs to summarise" — an honestly empty comparison is still the
 * empty comparison the direction asks this console not to show.
 */
export function experimentHasOutcome(experiment: LabExperiment): boolean {
  return experiment.arms.some((arm) => arm.runs.some((run) => run.outcome !== undefined))
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

function toCompareRun(run: LabRun): CompareRun {
  const outcome = run.outcome
  // Unmeasured, or measured and the gate never ran: no verdict exists, so
  // this is pending — never a fabricated value and never a failure nobody
  // recorded (prd53 ruling 3: `not-run` is legal and voiced as not measured).
  if (outcome === undefined || outcome.verified === 'not-run') return { id: run.eventId, status: 'pending' }
  if (outcome.verified === 'fail') {
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
    runs: arm.runs.map(toCompareRun),
  }
}

/** `lab/compare/`'s plain `ComparisonInput` (prd14 ruling 3) — one experiment's arms, each with its own runs and each run its own verdict. */
export function toComparisonInput(experiment: LabExperiment): ComparisonInput {
  return { arms: experiment.arms.map(toCompareArm) }
}
