/**
 * TEXT, NOT PIXELS (prd13 ruling 6): "the hover reads `start – end · lane ·
 * STATE · Duration 1h 20m` … the number must be readable, not inferred from
 * pixel width." This file is where that number becomes a string.
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
const HOUR_MS = 60 * MINUTE_MS

/** `"1h 20m"`, `"38m"`, `"45s"` — the hover's own duration text (ruling 6). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  if (total < MINUTE_MS) return `${Math.round(total / SECOND_MS)}s`
  if (total < HOUR_MS) return `${Math.round(total / MINUTE_MS)}m`
  const hours = Math.floor(total / HOUR_MS)
  const minutes = Math.round((total % HOUR_MS) / MINUTE_MS)
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

/** `HH:MM`, UTC, by arithmetic alone — pads a two-digit clock reading from an epoch ms. */
export function formatClock(ts: number): string {
  const totalMinutes = Math.floor(ts / MINUTE_MS)
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = ((totalMinutes % 60) + 60) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/**
 * `"14:00 – 14:38"`, or `"14:38 – now"` for a band still open at the log's
 * edge (`endTs: null` — `bands.ts`'s own open-band convention). Never
 * `formatClock(null)`: the open case is named in words rather than coerced
 * into a fake timestamp.
 */
export function formatRange(startTs: number, endTs: number | null): string {
  return `${formatClock(startTs)} – ${endTs === null ? 'now' : formatClock(endTs)}`
}
