/**
 * THE TRANSPORT'S MISSING AFFORDANCES (prd13 ruling 10, wave 3 / #169).
 *
 * A pure window-of-time computation, deliberately split out from `TideDock.tsx`
 * so it can be proven by table tests without a DOM. It knows nothing about
 * pixels (that is `scale.ts`'s job, #168) and nothing about the fleet (that is
 * `bands.ts`'s job, #167) — it only ever narrows or slides a `[start, end]`
 * pair inside a fixed outer bound.
 *
 * This is intentionally **local to the dock**: the window computed here only
 * ever changes what the TIDE itself renders. It never reaches another panel,
 * never touches the URL, and never restricts what the transport can scrub —
 * those are ruling 5's "scope to selection" and the deep-link (ruling 9), both
 * #170's wave 4. Ruling 10 is a narrower, already-due claim: the transport
 * lacks a zoom-out and a pan, and this file is exactly that, nothing more.
 */

export interface TideWindow {
  readonly start: number
  readonly end: number
}

/** Window width as a fraction of the full range, indexed by zoom level. Level 0 is "fully zoomed out". */
const ZOOM_FRACTIONS = [1, 0.5, 0.25, 0.125] as const

export const MAX_ZOOM_LEVEL = ZOOM_FRACTIONS.length - 1

function clampLevel(level: number): number {
  return Math.min(MAX_ZOOM_LEVEL, Math.max(0, Math.floor(level)))
}

function clampWindow(start: number, end: number, fullStart: number, fullEnd: number): TideWindow {
  const span = Math.min(Math.max(1, fullEnd - fullStart), Math.max(0, end - start))
  let clampedStart = Math.min(Math.max(fullStart, start), fullEnd)
  let clampedEnd = clampedStart + span
  if (clampedEnd > fullEnd) {
    clampedEnd = fullEnd
    clampedStart = clampedEnd - span
  }
  return { start: clampedStart, end: clampedEnd }
}

/**
 * The window for a given zoom level, centred on `centerTs` and clamped inside
 * `[fullStart, fullEnd]`. Level 0 always returns the full range exactly —
 * "zoom out" has a real floor, never an approximation of one.
 */
export function windowForLevel(
  level: number,
  centerTs: number,
  fullStart: number,
  fullEnd: number,
): TideWindow {
  const fullSpan = Math.max(1, fullEnd - fullStart)
  const clamped = clampLevel(level)
  if (clamped === 0) return { start: fullStart, end: fullEnd }

  const span = fullSpan * ZOOM_FRACTIONS[clamped]!
  const half = span / 2
  return clampWindow(centerTs - half, centerTs + half, fullStart, fullEnd)
}

/**
 * Slides a window by half its own width, in `direction` (`-1` earlier, `1`
 * later), clamped inside `[fullStart, fullEnd]`. A window already at the
 * bound it is asked to slide toward is unchanged — the caller reads that from
 * {@link canShiftWindow} rather than from a silent no-op here.
 *
 * (Parameter named `win`, not `window` — this directory's own purity law,
 * `purity.test.ts`, forbids any source in it from reaching the DOM global,
 * and its check is a plain `/\bwindow\./` scan with no notion of scope.)
 */
export function shiftWindow(win: TideWindow, fullStart: number, fullEnd: number, direction: -1 | 1): TideWindow {
  const span = win.end - win.start
  const step = span * 0.5 * direction
  return clampWindow(win.start + step, win.end + step, fullStart, fullEnd)
}

/** Whether {@link shiftWindow} in `direction` would actually move anything. */
export function canShiftWindow(win: TideWindow, fullStart: number, fullEnd: number, direction: -1 | 1): boolean {
  if (win.end - win.start >= fullEnd - fullStart) return false
  return direction < 0 ? win.start > fullStart : win.end < fullEnd
}
