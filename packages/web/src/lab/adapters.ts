import { isCompletedVerdict } from '@rhizomorph/core'
import type { ArmInput, ArmState } from './branching/index.js'
import type { LabArm, LabExperiment, LabRun } from './types.js'

/**
 * THIN ADAPTERS (prd14 wave 5, the assembly wave) — `lab/branching/` took
 * plain inputs by design, leaving "wiring this to the real launch/checkpoint
 * types" as a later, trivial adapter. These functions are that adapter: they
 * translate `lab/types.ts` shapes into the module's own vocabulary and invent
 * no fact the fixed types don't already carry. (The comparison surface's own
 * adapter is `compare/fromExperiment.ts`, per measure — the one this file used
 * to carry encoded the pre-prd53 reading of "complete" and was retired with
 * ruling 2's amendment of 2026-09-08.)
 *
 * Since prd53 ruling 3 an outcome is PER RUN (`LabRun.outcome`), read off the
 * newest `fork.measured` the server folded for that run. Before that the
 * console carried an arm-level outcome nothing ever populated, and handed
 * every run in an arm the same verdict — wrong the moment an arm held two
 * runs. A run nobody has measured has no outcome, and reads as exactly that.
 * Whether a run has been judged is core's call (`isCompletedVerdict`), never
 * spelled here.
 */

/** The one sentence for a run with no verdict — `not-run` included. Nothing is invented in its place. */
export const NOT_MEASURED_VOICE = 'not measured yet — no outcome is invented in its place'

/**
 * What a run's outcome says, in words a surface can print. An unmeasured run
 * and a `not-run` verdict both read as not measured: in neither case did a
 * gate judge the run, and a "failed" would be a claim nobody made.
 */
export function runOutcomeVoice(run: LabRun): string {
  const outcome = run.outcome
  if (outcome === undefined || !isCompletedVerdict(outcome.verified)) return NOT_MEASURED_VOICE
  const by = `${outcome.provenance.verifyCommand} (${outcome.provenance.source})`
  if (outcome.verified === 'pass') return `passed ${by}`
  return outcome.verifiedDetail === null ? `failed ${by}` : `failed ${by}: ${outcome.verifiedDetail}`
}

/**
 * An arm is running until one of its runs has been judged; finished once any
 * run passed or failed; dead only when every judged run reports the gate did
 * not run at all.
 */
function armState(arm: LabArm): ArmState {
  const outcomes = arm.runs.map((run) => run.outcome).filter((outcome) => outcome !== undefined)
  if (outcomes.length === 0) return 'running'
  if (!outcomes.some((outcome) => isCompletedVerdict(outcome.verified))) return 'dead'
  return 'finished'
}

/**
 * `lab/branching/`'s plain `ArmInput[]` (prd14 ruling 1) — one experiment's
 * arms, kept in the order they arrive in the experiment so the layout's own
 * "arms keep the order they arrive in" law has a caller that agrees with it.
 *
 * Since prd-55 ruling 11 (#385) each arm also carries HOW MANY RUNS it
 * dispatched, because the branching diagram is now a header glyph drawing a
 * strand per run rather than per arm — the same count the lane canvas below it
 * draws from the record, so the header and the drawing cannot disagree about
 * how many things there are. It is `arm.runs.length` and nothing else: an arm
 * that has dispatched nothing says zero, and `branching/geometry.ts` is the one
 * that decides an arm it was told about is an arm it draws.
 */
export function toBranchingArms(experiment: LabExperiment): ArmInput[] {
  return experiment.arms.map((arm) => ({ id: `arm-${arm.arm}`, state: armState(arm), runs: arm.runs.length }))
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
 * What one experiment's RAIL ROW says (prd-55 ruling 8): arms · runs · verdict
 * counts. Counted here rather than in the rail so the row cannot disagree with
 * the comparison the stage draws beside it — whether a run has been judged is
 * core's call (`isCompletedVerdict`), the same predicate
 * `compare/fromExperiment.ts` and `metrics/spend.ts` ask, and
 * `floor-agreement-law.test.ts` keeps all of them to that one spelling. A run
 * nobody has measured and a run whose gate never ran are ONE bucket here for
 * the same reason they are one bucket there: no gate judged either, so neither
 * has a verdict to count.
 *
 * `arms` is the arms ON THE RECORD — the ones that dispatched. An arm the
 * launch asked for that never dispatched is not here at all: it is a
 * launch-time fact the page threads separately (ruling 7), and the rail row's
 * *k of N arms* line is built from the two together in `rail/rows.ts`.
 */
export interface ExperimentRowCounts {
  /** Arms on the record — dispatched arms, never the count a launch requested. */
  arms: number
  /** Recorded runs across every arm (prd53 ruling 1: r runs of one arm). */
  runs: number
  passed: number
  failed: number
  /** Runs no gate has judged — unmeasured, or judged not to have run at all. */
  unmeasured: number
}

export function experimentRowCounts(experiment: LabExperiment): ExperimentRowCounts {
  const counts: ExperimentRowCounts = { arms: experiment.arms.length, runs: 0, passed: 0, failed: 0, unmeasured: 0 }
  for (const arm of experiment.arms) {
    for (const run of arm.runs) {
      counts.runs += 1
      const outcome = run.outcome
      if (outcome === undefined || !isCompletedVerdict(outcome.verified)) {
        counts.unmeasured += 1
      } else if (outcome.verified === 'pass') {
        counts.passed += 1
      } else {
        counts.failed += 1
      }
    }
  }
  return counts
}
