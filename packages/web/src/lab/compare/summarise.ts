import type { Arm, ArmSummary } from './types.js'

/**
 * PER-ARM SUMMARY (prd14 ruling 3, inheriting prd12 ruling 4). Every run is
 * kept on the summary unconditionally (law 1). A spread is computed only
 * from runs that actually completed, and only once there are at least 3 of
 * them (law 3) — under any code path, never a greyed-out number standing in.
 *
 * A partial experiment — an arm still waiting on pending runs, or one that
 * lost a run to failure — reports what is missing rather than silently
 * averaging over the gap: `insufficientReason` when there aren't enough
 * completed runs to summarise at all, `incompleteNote` when there are enough
 * to show a spread but the arm still isn't finished.
 */
export function summariseArm(arm: Arm): ArmSummary {
  const completedValues: number[] = []
  let pendingCount = 0
  let failedCount = 0

  for (const run of arm.runs) {
    if (run.status === 'complete') completedValues.push(run.value)
    else if (run.status === 'pending') pendingCount += 1
    else failedCount += 1
  }

  const base = {
    armId: arm.id,
    model: arm.model,
    brief: arm.brief,
    runs: arm.runs,
    completedValues,
    pendingCount,
    failedCount,
  }

  if (completedValues.length < 3) {
    return {
      ...base,
      spread: null,
      insufficientReason: insufficientReason(arm.runs.length, completedValues.length, pendingCount, failedCount),
      incompleteNote: null,
    }
  }

  return {
    ...base,
    spread: { min: Math.min(...completedValues), max: Math.max(...completedValues) },
    insufficientReason: null,
    incompleteNote:
      pendingCount > 0 || failedCount > 0
        ? incompleteNote(arm.runs.length, completedValues.length, pendingCount, failedCount)
        : null,
  }
}

function insufficientReason(totalRuns: number, completed: number, pending: number, failed: number): string {
  if (pending > 0) {
    return `${completed} of ${totalRuns} run${totalRuns === 1 ? '' : 's'} completed so far — too few completed to summarise yet`
  }
  const failedSuffix = failed > 0 ? ` (${failed} failed)` : ''
  return `n=${completed} — too few runs to summarise${failedSuffix}`
}

function incompleteNote(totalRuns: number, completed: number, pending: number, failed: number): string {
  const parts: string[] = []
  if (pending > 0) parts.push(`${pending} still pending`)
  if (failed > 0) parts.push(`${failed} failed`)
  return `${completed} of ${totalRuns} runs completed — ${parts.join(', ')}`
}
