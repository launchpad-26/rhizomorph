import { compareStrings, type SpanDecision } from '@rhizomorph/core'
import type { Lane } from '../../fleet/index.js'

/**
 * prd9 ruling 6 / prd10 ruling 9's data layer, read for the strip's quiet
 * retrospective region: what the largest waits-on-a-human were, lane by
 * lane. Pure derivation over `Fleet.lanes` (each already carries its own
 * `waitedOnHuman`, `buildFleet.ts`'s job, not this file's), so this stays
 * testable without a reducer or a clock.
 *
 * This is memory, not a summons: nothing here reads or writes the ladder, and
 * `AttentionStripView.test.tsx`'s law test pins that a session full of past
 * waits still renders ALL CLEAR when nothing is live.
 */

/** C's triage rule applies here too — three is the whole point, not a start. */
export const MAX_WAITED_CHIPS = 3

export interface WaitedChip {
  laneId: string
  label: string
  waitMs: number
  toolName: string | null
  /** The specific decision `waitMs` belongs to — null only if the log truly never said. */
  decision: SpanDecision | null
}

/**
 * The biggest wait per lane, biggest lane first, capped at `limit`. A lane
 * that never sat blocked on a human (`longestWait: null`) contributes
 * nothing — the same honest-absence rule `waitedOnHuman` itself follows.
 */
export function selectWaitedChips(lanes: readonly Lane[], limit = MAX_WAITED_CHIPS): WaitedChip[] {
  const chips: WaitedChip[] = []

  for (const lane of lanes) {
    const longest = lane.waitedOnHuman.longestWait
    if (longest === null) continue
    chips.push({
      laneId: lane.id,
      label: lane.label,
      waitMs: longest.waitMs,
      toolName: longest.toolName,
      decision: lane.waitedOnHuman.longestWaitDecision,
    })
  }

  return chips
    .sort((a, b) => b.waitMs - a.waitMs || compareStrings(a.label, b.label))
    .slice(0, limit)
}
