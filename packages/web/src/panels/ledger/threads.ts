import type { BranchSpend, LaneSpend, SessionState, ThreadSpend } from '@rhizomorph/core'
import { selectSpendForLane } from '@rhizomorph/core'

/**
 * A branch row's thread sub-rows, or none when they cannot be shown honestly.
 *
 * `#64`'s per-thread sub-totals live on {@link LaneSpend}, not on
 * {@link BranchSpend} — and core keeps them there deliberately, never merged
 * across lanes (a branch fed by two lanes has two separate reconciled thread
 * breakdowns, not one). This panel's rows are branches, so a branch fed by
 * more than one lane has no single thread breakdown that is provably *the
 * branch's* — merging them here would be exactly the kind of invented number
 * this codebase refuses to render. Same when a lane's own totals do not match
 * the branch's own (spend from that lane the branch filter didn't count):
 * no lane's threads can stand in for the branch's without lying about the
 * total they add up to.
 *
 * So sub-rows render only for the unambiguous case — exactly one contributing
 * lane, whose totals equal the branch's own — and render none at all
 * otherwise, same as a branch with no thread data.
 */
export function selectThreadRowsForBranch(state: SessionState, row: BranchSpend): ThreadSpend[] {
  if (row.lanes.length !== 1) return []
  const lane = selectSpendForLane(state, row.lanes[0]!)
  if (lane === null || lane.threads.length === 0) return []
  if (!reconciles(lane, row)) return []
  return lane.threads
}

function reconciles(lane: LaneSpend, row: BranchSpend): boolean {
  return lane.tokens.total === row.tokens.total && lane.costUsd === row.costUsd
}
