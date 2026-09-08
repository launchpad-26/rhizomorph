import { canSummariseArm } from '@rhizomorph/core'
import type { Arm, ArmSummary } from './types.js'

/**
 * PER-ARM SUMMARY (prd14 ruling 3, inheriting prd12 ruling 4). Every run is
 * kept on the summary unconditionally (law 1). The FLOOR is core's
 * (`canSummariseArm`, prd53 ruling 2) over the runs a gate has judged — the
 * `complete` runs, pass or fail, whatever this measure is — so this surface,
 * Metrics and the CLI count the same denominator for the same arm
 * (`../floor-agreement-law.test.ts`). The SPREAD is a separate question: it is
 * taken over the completed runs that have a value under this measure, and
 * states its n beside the completed count. At the floor with no values at all
 * — three judged runs, no cost booked to any — nothing is invented: the
 * summary says so in `unbookedNote` instead of a `$0`.
 *
 * A partial experiment — an arm still waiting on pending runs — reports what
 * is missing rather than silently averaging over the gap: `insufficientReason`
 * below the floor, `incompleteNote` at it.
 */
export function summariseArm(arm: Arm): ArmSummary {
  const values: number[] = []
  let completedCount = 0
  let passCount = 0
  let failCount = 0
  let pendingCount = 0

  for (const run of arm.runs) {
    if (run.status === 'complete') {
      completedCount += 1
      if (run.verdict === 'pass') passCount += 1
      else failCount += 1
      if (run.value !== null) values.push(run.value)
    } else {
      pendingCount += 1
    }
  }

  const base = {
    armId: arm.id,
    model: arm.model,
    brief: arm.brief,
    runs: arm.runs,
    completedCount,
    passCount,
    failCount,
    pendingCount,
    values,
  }

  if (!canSummariseArm(completedCount)) {
    return {
      ...base,
      spread: null,
      insufficientReason: insufficientReason(arm.runs.length, completedCount, pendingCount),
      unbookedNote: null,
      incompleteNote: null,
    }
  }

  const spread = values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) }
  return {
    ...base,
    spread,
    insufficientReason: null,
    unbookedNote: spread === null ? `${completedCount} completed — no value is booked under this measure for any of them yet` : null,
    incompleteNote: pendingCount > 0 ? `${completedCount} of ${arm.runs.length} runs completed — ${pendingCount} still pending` : null,
  }
}

function insufficientReason(totalRuns: number, completed: number, pending: number): string {
  if (pending > 0) {
    return `${completed} of ${totalRuns} run${totalRuns === 1 ? '' : 's'} completed so far — too few completed to summarise yet`
  }
  return `n=${completed} — too few runs to summarise`
}
