import type { Chapter } from './chapters.js'

/**
 * MARKS COALESCE UNDER DENSITY TOO (prd13 ruling 12: "the existing coalescing
 * law, applied to marks"). `coalesce.ts`'s own algorithm does not transfer
 * literally — it merges the shortest band of a *tiling* into a neighbour, and
 * a mark has no duration and no tiling to preserve, only a position. What
 * carries over is the law, not the code: **below the caller's hover
 * resolution, marks that would collide render as one counted cluster instead
 * of an unhoverable pile of slivers.**
 *
 * The algorithm is single-link clustering over sorted instants: walk the
 * marks in time order, and a mark joins the run in progress when it lands
 * within `minSpanMs` of the *previous* mark in that run (not the run's first
 * mark — a chain, not a fixed-width bucket, so two dense stretches separated
 * by a wide-open gap never merge just because both are internally tight).
 *
 * Laws, tested in `markCoalesce.test.ts`:
 *
 * - **Every input mark is in exactly one group's `members`.** Coalescing
 *   never drops a chapter, only folds its rendering.
 * - **A group's seek target is its earliest member's `ts`, exactly.** Never
 *   an average, never the cluster's midpoint — an exact instant a real event
 *   attested, so "clicking is exact, not approximate" (prd13 ruling 12)
 *   holds for a cluster the same as for a lone mark.
 * - **Deterministic.** Same chapters in, byte-equal groups out.
 */

export interface MarkGroup {
  /** The seek target: the earliest member's `ts`. */
  readonly ts: number
  readonly members: readonly [Chapter, ...Chapter[]]
}

export function coalesceMarks(chapters: readonly Chapter[], minSpanMs: number): readonly MarkGroup[] {
  const sorted = [...chapters].sort((a, b) => a.ts - b.ts)
  const groups: MarkGroup[] = []

  for (const chapter of sorted) {
    const current = groups[groups.length - 1]
    const previousMember = current?.members[current.members.length - 1]

    if (current !== undefined && previousMember !== undefined && chapter.ts - previousMember.ts < minSpanMs) {
      groups[groups.length - 1] = { ts: current.ts, members: [...current.members, chapter] as [Chapter, ...Chapter[]] }
      continue
    }

    groups.push({ ts: chapter.ts, members: [chapter] })
  }

  return groups
}
