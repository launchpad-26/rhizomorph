import { canSummariseArm, MIN_COMPLETED_RUNS_TO_SUMMARISE } from '@rhizomorph/core'
import type { LabArm, LabExperiment, LabRun } from '../types.js'

/**
 * METRICS' ARITHMETIC (prd53 S4, #328) — every number with the sentence that
 * says where it came from, and nothing that includes an unmeasured run as a
 * zero. Pure: the surface prints these; it never computes a figure of its own.
 */

export interface ExperimentSpend {
  forkId: string
  /** Dollars booked to the runs that were measured and have a cost — null when none has. */
  bookedUsd: number | null
  /** Runs whose cost entered the sum. */
  bookedRuns: number
  /** Measured runs with no cost booked to their lane — excluded, and said so. */
  unbookedRuns: number
  /** Runs nobody has measured (or whose gate did not run) — excluded, and said so. */
  unmeasuredRuns: number
  /** The basis line — printed beside the figure, always. */
  basis: string
  /** What was left out, in words, or null when nothing was. */
  exclusionNote: string | null
}

function isMeasured(run: LabRun): boolean {
  return run.outcome !== undefined && run.outcome.verified !== 'not-run'
}

export function experimentSpend(experiment: LabExperiment): ExperimentSpend {
  let bookedUsd: number | null = null
  let bookedRuns = 0
  let unbookedRuns = 0
  let unmeasuredRuns = 0
  for (const arm of experiment.arms) {
    for (const run of arm.runs) {
      if (!isMeasured(run)) {
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
  if (unbookedRuns > 0) parts.push(`${unbookedRuns} measured run${unbookedRuns === 1 ? '' : 's'} with no cost booked`)
  return {
    forkId: experiment.forkId,
    bookedUsd,
    bookedRuns,
    unbookedRuns,
    unmeasuredRuns,
    basis: `booked from each arm lane's own recorded spend, over ${bookedRuns} measured run${bookedRuns === 1 ? '' : 's'}`,
    exclusionNote: parts.length === 0 ? null : `${parts.join(' and ')} — excluded from the total, never counted as zero`,
  }
}

export interface ArmFloor {
  arm: number
  measuredRuns: number
  totalRuns: number
  /** Core's floor (prd53 ruling 2): may a summary be stated about this arm? */
  canSummarise: boolean
  /** The refusal, when there is one — S4's rendered refusal on the shared scale. */
  refusal: string | null
}

export function armFloor(arm: LabArm): ArmFloor {
  const measuredRuns = arm.runs.filter(isMeasured).length
  const canSummarise = canSummariseArm(measuredRuns)
  return {
    arm: arm.arm,
    measuredRuns,
    totalRuns: arm.runs.length,
    canSummarise,
    refusal: canSummarise ? null : `refuses to summarise — ${measuredRuns} of ${arm.runs.length} measured, needs ${MIN_COMPLETED_RUNS_TO_SUMMARISE}`,
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
        costUsd: outcome === undefined || outcome.verified === 'not-run' ? null : outcome.costUsd,
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
