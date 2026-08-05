/**
 * TEXT, NOT PIXELS. `formatClock`/`formatClockSeconds` are what the axis
 * (`TideDock`) and the mark hover (`chapterLabel`, `chapters.ts`) read a
 * timestamp as. `formatDuration`/`formatRange` — the band hover's "start –
 * end … Duration 1h 20m" (prd13 ruling 6) — went with the density band when
 * ruling 13 cut it (issue #194): a duration span belongs to a band, and
 * there is no band left to carry one.
 *
 * No `Date` object anywhere: every digit here is arithmetic on the
 * millisecond count itself (`purity.test.ts` forbids constructing one
 * anywhere in this directory), which is also what keeps the output identical
 * on a stranger's machine regardless of its local timezone — the same
 * guarantee `formatWallClock` makes for the replay banner, restated without
 * touching the clock.
 */

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS

/** `HH:MM`, UTC, by arithmetic alone — pads a two-digit clock reading from an epoch ms. */
export function formatClock(ts: number): string {
  const totalMinutes = Math.floor(ts / MINUTE_MS)
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = ((totalMinutes % 60) + 60) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/**
 * `HH:MM:SS` — the same arithmetic as {@link formatClock}, one tier finer.
 * A chapter mark is an instant rather than a span, so its hover (prd13 ruling
 * 12: `163 landed · 14:32:07`) needs the second `formatClock`'s minute
 * resolution would round away.
 */
export function formatClockSeconds(ts: number): string {
  const totalSeconds = Math.floor(ts / SECOND_MS)
  const hours = Math.floor(totalSeconds / 3600) % 24
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = ((totalSeconds % 60) + 60) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
