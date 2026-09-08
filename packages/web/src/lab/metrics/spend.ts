import { canSummariseArm, isCompletedVerdict, MIN_COMPLETED_RUNS_TO_SUMMARISE } from '@rhizomorph/core'
import type { LabArm, LabExperiment, LabRun } from '../types.js'

/**
 * METRICS' ARITHMETIC (prd53 S4, #328) — every number with the sentence that
 * says where it came from, and nothing that includes an unmeasured run as a
 * zero. Pure: the surface prints these; it never computes a figure of its own.
 *
 * "Completed" is core's word, not this module's (ruling 2, amendment
 * 2026-09-08): a run is completed when a gate judged it, pass or fail —
 * `isCompletedVerdict`. Compare and the CLI count with the same predicate, so
 * the floor this module reports for an arm is the floor Compare reports for
 * it (`../floor-agreement-law.test.ts`). Before that this file spelled its own
 * `isMeasured`, and the two surfaces disagreed about the same arm on one page.
 */

export interface ExperimentSpend {
  forkId: string
  /** Dollars booked to the runs that were completed and have a cost — null when none has. */
  bookedUsd: number | null
  /** Runs whose cost entered the sum. */
  bookedRuns: number
  /** Completed runs with no cost booked to their lane — excluded, and said so. */
  unbookedRuns: number
  /** Runs no gate has judged — unmeasured, or a gate that did not run — excluded, and said so. */
  unmeasuredRuns: number
  /** The basis line — printed beside the figure, always. */
  basis: string
  /** What was left out, in words, or null when nothing was. */
  exclusionNote: string | null
}

function isCompleted(run: LabRun): boolean {
  return isCompletedVerdict(run.outcome?.verified)
}

export function experimentSpend(experiment: LabExperiment): ExperimentSpend {
  let bookedUsd: number | null = null
  let bookedRuns = 0
  let unbookedRuns = 0
  let unmeasuredRuns = 0
  for (const arm of experiment.arms) {
    for (const run of arm.runs) {
      if (!isCompleted(run)) {
        unmeasuredRuns += 1
        continue
      }
      const cost = run.outcome?.costUsd ?? null
      if (cost === null) {
        unbookedRuns += 1
        continue
      }
      bookedUsd = (bookedUsd ?? 0) + cost
      bookedRuns += 1
    }
  }
  const parts: string[] = []
  if (unmeasuredRuns > 0) parts.push(`${unmeasuredRuns} run${unmeasuredRuns === 1 ? '' : 's'} not measured`)
  if (unbookedRuns > 0) parts.push(`${unbookedRuns} completed run${unbookedRuns === 1 ? '' : 's'} with no cost booked`)
  return {
    forkId: experiment.forkId,
    bookedUsd,
    bookedRuns,
    unbookedRuns,
    unmeasuredRuns,
    basis: `booked from each arm lane's own recorded spend, over ${bookedRuns} completed run${bookedRuns === 1 ? '' : 's'}`,
    exclusionNote: parts.length === 0 ? null : `${parts.join(' and ')} — excluded from the total, never counted as zero`,
  }
}

export interface ArmFloor {
  arm: number
  /** Runs a gate has judged, pass or fail — core's denominator, the one Compare and the CLI count too. */
  completedRuns: number
  totalRuns: number
  /** Core's floor (prd53 ruling 2): may a summary be stated about this arm? */
  canSummarise: boolean
  /** The refusal, when there is one — S4's rendered refusal on the shared scale. */
  refusal: string | null
}

/** What the word beside the floor's count means — printed as the count's basis, so the denominator is on the page. */
export const FLOOR_BASIS = "completed = judged by the gate, pass or fail — core's floor, the same count Compare reads"

export function armFloor(arm: LabArm): ArmFloor {
  const completedRuns = arm.runs.filter(isCompleted).length
  const canSummarise = canSummariseArm(completedRuns)
  return {
    arm: arm.arm,
    completedRuns,
    totalRuns: arm.runs.length,
    canSummarise,
    refusal: canSummarise ? null : `refuses to summarise — ${completedRuns} of ${arm.runs.length} completed, needs ${MIN_COMPLETED_RUNS_TO_SUMMARISE}`,
  }
}

export interface ProvenanceRow {
  arm: number
  run: number
  laneHandle: string
  /** `pass` / `fail` / `not-run`, or `not measured` when nothing has judged the run. */
  verified: 'pass' | 'fail' | 'not-run' | 'not measured'
  source: string | null
  verifyCommand: string | null
  measuredAt: number | null
  /** Null for any row without a verdict, and for a verdict with no cost booked — never a zero. */
  costUsd: number | null
}

/** One row per run, in arm-then-run order. A row without a verdict has no number beside it. */
export function provenanceRows(experiment: LabExperiment): ProvenanceRow[] {
  const rows: ProvenanceRow[] = []
  for (const arm of experiment.arms) {
    for (const run of arm.runs) {
      const outcome = run.outcome
      rows.push({
        arm: arm.arm,
        run: run.run,
        laneHandle: run.laneHandle,
        verified: outcome === undefined ? 'not measured' : outcome.verified,
        source: outcome?.provenance.source ?? null,
        verifyCommand: outcome?.provenance.verifyCommand ?? null,
        measuredAt: outcome?.provenance.measuredAt ?? null,
        costUsd: outcome !== undefined && isCompletedVerdict(outcome.verified) ? outcome.costUsd : null,
      })
    }
  }
  return rows
}

/** "2 of 3 arms dispatched" — the partial-launch line (ruling 7), given the arms that never came. */
export function dispatchedLine(experiment: LabExperiment, failedArms: number): string | null {
  if (failedArms === 0) return null
  const dispatched = experiment.arms.length
  return `${dispatched} of ${dispatched + failedArms} arms dispatched — the spend is the spend of the ${dispatched}`
}
