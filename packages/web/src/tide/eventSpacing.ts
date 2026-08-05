/**
 * THE LOG'S OWN GRAIN (issue #186, defect 3 — "the only depth any job asked
 * for"). Deeper zoom is only useful up to the point where the log's own
 * events stop clustering — beyond that, magnification shows more empty
 * space around the same instants, not more instants. This file answers
 * exactly one question, in one pass, with no opinion about pixels or
 * windows (that is `tideWindow.ts`'s job): **how far apart are this log's
 * events, typically?**
 *
 * Median rather than mean on purpose: a single dense burst (a cluster of
 * `pane.activity` a millisecond apart) would drag a mean down to near-zero
 * and demand max zoom depth even when the rest of the session is idle for
 * hours — exactly the "◆(1023)" pathology issue #186 diagnoses. The median
 * gap is the typical spacing a human scanning the log actually meets.
 */

/** Anything with a timestamp — `RhizomorphEvent` fits without importing it. */
export interface Timestamped {
  readonly ts: number
}

/**
 * The median gap between consecutive events, in ms, after sorting by `ts`
 * (the log is expected non-decreasing already, but this does not trust
 * that — same defensive stance `coalesce.ts`/`chaptersFor` take). `Infinity`
 * for fewer than two events: there is no spacing fact to report, and a
 * caller treating that as "no cap" is the honest reading, not a lie about a
 * gap that was never observed.
 */
export function medianEventSpacingMs(events: readonly Timestamped[]): number {
  if (events.length < 2) return Infinity

  const sorted = [...events].map((event) => event.ts).sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    gaps.push((sorted[i] as number) - (sorted[i - 1] as number))
  }
  gaps.sort((a, b) => a - b)

  const mid = Math.floor(gaps.length / 2)
  return gaps.length % 2 === 0
    ? ((gaps[mid - 1] as number) + (gaps[mid] as number)) / 2
    : (gaps[mid] as number)
}
