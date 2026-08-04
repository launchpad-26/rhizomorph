/**
 * THE HONEST BUCKET (issue #159) — turns a scatter of timestamped values into
 * the fixed-width series a sparkline draws, without ever inventing a reading
 * for a moment the subject didn't exist.
 *
 * A lane or branch that started five minutes ago has no true reading for the
 * other twenty-five minutes of a thirty-minute window — a zero there would say
 * "quiet", which is a real claim about a period that in fact never happened.
 * {@link BucketizeOptions.sinceTs} trims the series to the window's
 * intersection with the subject's own lifetime, so a young lane draws a short,
 * honest spark rather than a long one padded with fabricated silence.
 * {@link Sparkline} then refuses to draw anything shorter than three points —
 * this file's only job is to hand it a series that is honest, not to decide
 * whether it is long enough.
 */
export interface BucketizeOptions {
  /** The instant the window ends at — the mode clock, never `Date.now()` directly. */
  now: number
  /** How far back the window reaches. */
  windowMs: number
  /** How many equal-width slices the window is divided into. */
  bucketCount: number
  /**
   * The earliest instant the series may claim to represent — before this,
   * there is no subject to have been silent, so no bucket is emitted. `null`
   * when the caller has no lifetime bound to apply (the full window is used).
   */
  sinceTs: number | null
}

export interface SeriesEvent {
  ts: number
  value: number
}

/**
 * Sums `events` into `bucketCount` equal slices of `windowMs` ending at `now`,
 * then drops every leading slice that starts before `sinceTs` — the honesty
 * trim. Events outside `[max(now - windowMs, sinceTs ?? -Infinity), now]` are
 * ignored; a slice with no event in it is a real zero, not a gap, because by
 * construction the subject already existed for the whole of it.
 */
export function bucketizeSeries(
  events: readonly SeriesEvent[],
  options: BucketizeOptions,
): number[] {
  const { now, windowMs, bucketCount, sinceTs } = options
  if (bucketCount <= 0 || windowMs <= 0) return []

  const windowStart = now - windowMs
  const start = sinceTs === null ? windowStart : Math.max(windowStart, sinceTs)
  if (start >= now) return []

  const bucketMs = windowMs / bucketCount
  const buckets = new Array<number>(bucketCount).fill(0)

  for (const event of events) {
    if (event.ts < windowStart || event.ts > now) continue
    const index = Math.min(bucketCount - 1, Math.floor((event.ts - windowStart) / bucketMs))
    if (index < 0) continue
    buckets[index] = (buckets[index] as number) + event.value
  }

  const firstHonestBucket = Math.floor((start - windowStart) / bucketMs)
  return buckets.slice(Math.min(firstHonestBucket, bucketCount))
}
