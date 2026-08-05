/**
 * THE ONE TIME→X MAPPING (prd13 ruling 5's own warning, restated as code: "two
 * copies of a time scale is the drift the product exists to catch"). The TIDE
 * takes `{start, end}` and a pixel width and owns this mapping exactly once —
 * wave 3's playhead alignment and wave 4's selection are meant to import
 * {@link timeScale} rather than each write their own ratio.
 *
 * Session-to-now compression (prd13 ruling 2) is not a special case here: it is
 * simply what happens when the caller passes `end = now`. This file has no
 * opinion about live vs replay, the same way `coalesce` has no opinion about
 * pixels — the caller's business stays the caller's.
 */

export interface TimeScale {
  readonly start: number
  readonly end: number
  readonly width: number
  /** A timestamp, mapped to a pixel offset. Clamped to `[0, width]`. */
  xOf(ts: number): number
  /** The inverse of {@link xOf}: a pixel offset back to a timestamp. */
  tsOf(x: number): number
  /** A duration in ms, mapped to a pixel width — never a second copy of the ratio. */
  widthOf(ms: number): number
}

/**
 * `end` is never allowed to collide with `start` in the denominator: a
 * zero-span or inverted window still returns a scale that maps everything to
 * pixel 0 rather than dividing by zero. `xOf`/`tsOf` clamp on top of that, so
 * every output stays inside the bar regardless of what the caller passes.
 */
export function timeScale(start: number, end: number, width: number): TimeScale {
  const span = Math.max(1, end - start)
  const pxPerMs = width / span

  const xOf = (ts: number): number => {
    const clamped = Math.min(end, Math.max(start, ts))
    return Math.min(width, Math.max(0, (clamped - start) * pxPerMs))
  }

  const tsOf = (x: number): number => {
    const clamped = Math.min(width, Math.max(0, x))
    return start + clamped / pxPerMs
  }

  const widthOf = (ms: number): number => Math.max(0, ms) * pxPerMs

  return { start, end, width, xOf, tsOf, widthOf }
}

/**
 * One hover-sized pixel budget (prd13 ruling 4: "a band below the hover
 * threshold must coalesce rather than render"). `coalesce` itself takes no
 * opinion on pixels — this is the one place that budget becomes a number.
 */
export const HOVER_PX = 6

/** The hover-pixel budget, converted to a duration at this scale — `coalesce`'s `minSpanMs`. */
export function hoverThresholdMs(scale: TimeScale): number {
  if (scale.width <= 0) return 0
  return (HOVER_PX / scale.width) * (scale.end - scale.start)
}
