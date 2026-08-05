import { compareStrings } from '@rhizomorph/core'

/**
 * WHICH LANE GETS WHICH ROW (prd13 rulings 3 and 4).
 *
 * Ruling 3: **lane rows are stable for the session.** A lane keeps its row for
 * as long as the session lasts, so it can be learned and pointed at — graft
 * g7's pointability argument applied to y instead of θ, and the same rule
 * `Lane.slot` already follows in the scene ("assigned by first sighting and
 * never reshuffled by rank"). Sorting by attention was explicitly rejected:
 * rows that move under the cursor destroy the muscle memory that makes a
 * timeline scannable, and urgency is already answered twice above the fold.
 *
 * Ruling 4: **density is bought by coalescing, never by stacking.** Past the
 * row budget the remainder becomes one `+N` row carrying its count — the
 * existing coalescing law on a new surface, not a new law.
 *
 * The ordering key is first-seen time, so it is a fact about the log rather
 * than about the moment of rendering: re-running `rowPlan` a second later with
 * one more event cannot reshuffle the rows that were already there. New lanes
 * append; they never insert.
 */

/** Anything that knows its handle and when it was first seen — `LaneBands` fits. */
export interface RowCandidate {
  lane: string
  firstSeenTs: number
}

export interface LaneRow {
  kind: 'lane'
  lane: string
  firstSeenTs: number
}

/** The remainder, coalesced (ruling 4). Carries its count *and* who is in it. */
export interface MoreRow {
  kind: 'more'
  count: number
  /** The coalesced handles, in the same session-stable order. Never empty. */
  lanes: readonly [string, ...string[]]
}

export type RowDescriptor = LaneRow | MoreRow

/**
 * The row plan: up to `topN` lane rows in first-seen order, then the remainder
 * as one `+N` descriptor.
 *
 * Laws, each one a test:
 *
 * - **Every lane is represented exactly once**, as a row or inside the `+N`
 *   row's own list. A lane is never dropped and never listed twice; duplicates
 *   in the input collapse onto their earliest sighting.
 * - **The order is first-seen, then handle.** Never rank, never size, never
 *   anything that moves while you look at it.
 * - **Prefix-stable**: whatever `topN` is, the lane rows are a prefix of one
 *   canonical order and the remainder is exactly the rest of it. Widening the
 *   bar reveals more of the same list; it never rearranges what was already
 *   visible.
 * - **`+1` is never a row.** A remainder of one costs the same single row as
 *   naming it and says strictly less, so the last lane keeps its name. The
 *   plan is therefore never longer than `topN + 1` descriptors.
 */
export function rowPlan(lanes: readonly RowCandidate[], topN: number): readonly RowDescriptor[] {
  const earliest = new Map<string, number>()
  for (const candidate of lanes) {
    const seen = earliest.get(candidate.lane)
    if (seen === undefined || candidate.firstSeenTs < seen) {
      earliest.set(candidate.lane, candidate.firstSeenTs)
    }
  }

  const ordered: LaneRow[] = [...earliest.entries()]
    .map(([lane, firstSeenTs]) => ({ kind: 'lane' as const, lane, firstSeenTs }))
    .sort((a, b) => a.firstSeenTs - b.firstSeenTs || compareStrings(a.lane, b.lane))

  const budget = Math.max(0, Math.floor(topN))
  // A remainder of one gets its name instead of a `+1` row: the coalescing is
  // only worth its silence when it actually buys a row back.
  if (ordered.length <= budget + 1) return ordered

  const rows = ordered.slice(0, budget)
  const remainder = ordered.slice(budget).map((row) => row.lane) as [string, ...string[]]

  return [...rows, { kind: 'more', count: remainder.length, lanes: remainder }]
}
