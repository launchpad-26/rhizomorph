import { HOVER_PX } from './scale.js'

/**
 * THE TRANSPORT'S MISSING AFFORDANCES (prd13 ruling 10, wave 3 / #169;
 * extended for issue #186 defect 3, "no reachable granularity").
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
 *
 * **Depth is capped by the log's own grain, not offered unconditionally**
 * (research note §4 R4). `ZOOM_FRACTIONS` extends geometrically down to
 * 1/64 — deep enough for a 43.5h session to reach single-digit-second
 * windows — but {@link usefulMaxZoomLevel} stops recommending depth once the
 * window's own hover threshold (`HOVER_PX` converted to a duration at that
 * window's scale) reaches the log's median event spacing
 * ({@link medianEventSpacingMs}): past that point every mark has already
 * split off its neighbours, and further magnification buys empty pixels
 * around the same instants, not more instants. `windowForLevel` itself stays
 * total — it will honour any level up to `MAX_ZOOM_LEVEL` if asked — the cap
 * is `TideDock`'s own button/wheel affordances declining to ask for more,
 * the same "declared, not silent" posture ruling 5 asks of the window
 * bracket.
 */

export interface TideWindow {
  readonly start: number
  readonly end: number
}

/**
 * Window width as a fraction of the full range, indexed by zoom level.
 * Level 0 is "fully zoomed out" (Audacity's "Fit Project" floor). Extended
 * geometrically past the original ⅛ floor so a dense, hours-long session has
 * somewhere to go once `usefulMaxZoomLevel` says it is worth going there.
 */
const ZOOM_FRACTIONS = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625] as const

export const MAX_ZOOM_LEVEL = ZOOM_FRACTIONS.length - 1

/**
 * The depth #169 already shipped and tested (1, ½, ¼, ⅛) — always offered
 * unconditionally, regardless of what the log's grain says. The median-
 * spacing cap only ever *extends past* this floor; it never retracts below
 * it. Without that floor, a short, sparse fixture (or a quiet real session)
 * would compute a cap of 0 and silently disable the zoom button entirely —
 * exactly the kind of silent narrowing ruling 5 forbids.
 */
const BASE_ZOOM_LEVEL = 3

/**
 * The deepest zoom level worth offering for this session, on this track
 * width: starting from {@link BASE_ZOOM_LEVEL}, the shallowest level whose
 * hover threshold has already fallen to or below `medianSpacingMs` — the
 * level where a run of median-spaced marks would just barely stop
 * coalescing. Falls back to {@link MAX_ZOOM_LEVEL} when the spacing fact is
 * unusable (fewer than two events, or no pixels to measure against yet)
 * rather than silently refusing to zoom.
 */
export function usefulMaxZoomLevel(fullSpanMs: number, widthPx: number, medianSpacingMs: number): number {
  if (!Number.isFinite(medianSpacingMs) || medianSpacingMs <= 0 || widthPx <= 0) return MAX_ZOOM_LEVEL

  for (let level = BASE_ZOOM_LEVEL; level <= MAX_ZOOM_LEVEL; level += 1) {
    const windowSpan = fullSpanMs * (ZOOM_FRACTIONS[level] as number)
    const thresholdMs = (HOVER_PX / widthPx) * windowSpan
    if (thresholdMs <= medianSpacingMs) return level
  }
  return MAX_ZOOM_LEVEL
}

/** `"1/4"`, `"1/64"`, or `"1"` at level 0 — the window label's own figures-voice fraction (research note §4 R1). */
export function zoomFractionLabel(level: number): string {
  const fraction = ZOOM_FRACTIONS[clampLevel(level)] as number
  const denominator = Math.round(1 / fraction)
  return denominator <= 1 ? '1' : `1/${denominator}`
}

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
