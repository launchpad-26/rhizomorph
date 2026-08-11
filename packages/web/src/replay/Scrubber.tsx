import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { formatElapsed } from './format.js'

/** One real chapter instant, for the drag label only — never a seek target of its own (that stays `onChange`/`onSeek`'s job). */
export interface ScrubberChapterMarker {
  ts: number
  label: string
}

export interface ScrubberProps {
  start: number
  end: number
  value: number
  onChange(ts: number): void
  disabled?: boolean
  /** Sorted or not — nearest-lookup is a linear scan either way. Used only for the drag label (research note §4 R2's YouTube idiom). */
  chapterMarkers?: readonly ScrubberChapterMarker[]
}

/**
 * Chrome, not a panel (ruling 16): no border, no fill beyond the native
 * track — it reads as part of the frame around the app, not a widget inside
 * it. Keyboard affordances are the native range input's own (arrow keys,
 * Home/End, Page Up/Down) — kept by construction, never reimplemented. This
 * remains the law wave 3 (#169, prd13 ruling 10) is required to restate
 * stronger, not weaken: the TIDE's body is docked *around* this input — a
 * band above it sharing its x-axis, a zoom-out and a `«`/`»` pan flanking it
 * — but nothing here adds an `onKeyDown`, changes `type`, or otherwise stands
 * between the browser and this element's own native behaviour. A test in
 * `Scrubber.test.tsx` asserts a keydown on this input is never
 * `preventDefault`-ed by anything this component wires up.
 *
 * **Issue #186 defect 3/R3: a real `step`, not the browser's ms-scale
 * default.** `min`/`max` already configure native behaviour rather than
 * replace it; `step` joins them the same way — one arrow press now moves
 * ~0.1% of the session instead of one millisecond. This is the same
 * "configure, never reimplement" law the module note above already states;
 * it does not reopen it.
 *
 * **Issue #270: that step is one pixel of the rendered track, not a fixed
 * 1/1000 of the session.** `max(1000, span / 1000)` quantized the input to
 * ~1000 stops (fewer — one per second — on any session under ~17 minutes),
 * and those stops are not a pointer affordance: they are notches the thumb
 * jumps between, for the drag *and* for a playback position handed back
 * through `value`, which the browser rounds onto the same grid. The claim
 * that "keyboard stepping and pointer dragging want different granularities"
 * only holds while you assume the pointer wants a sub-pixel one. It cannot
 * use one: a drag can address exactly as many positions as the track has
 * pixels. So the two requirements meet at one pixel, and a single `step` does
 * serve both — a notch is never wider than a pixel, at any track width, for
 * any session long enough to afford one (see `notchCount`: below roughly two
 * seconds the 1ms floor binds and a notch is wider than a pixel, which is
 * still strictly finer than what this replaced — `max(1000, span / 1000)` cut
 * a 1.5-second session into a single notch and froze the slider outright).
 * Meanwhile one arrow press moves half a pixel to a pixel of track, which on
 * a real dock is ~0.1% of the session: #186's calibration, held more honestly
 * than the 1-second floor held it on short recordings.
 *
 * This is deliberately the option that leaves the law above untouched — no
 * `onKeyDown`, no second granularity wired by hand, just a better-chosen
 * `step`. The cost, stated plainly: a seek from this input is now grid-
 * granular at roughly a pixel rather than 1/1000-granular, which on a track
 * narrower than 1000px is marginally coarser. No position a pointer can
 * address is unreachable at that granularity — `end` included, which is a
 * grid point by construction rather than by luck — and precision seeking goes
 * through the TIDE's zoom.
 *
 * **Issue #186 defect 2/R2: the nearest chapter's label while dragging**
 * (the YouTube "chapter title appears as you scrub" idiom) — a plain label
 * above the thumb, shown only while a pointer is down on this input. It
 * reads `chapterMarkers` only to find the nearest one; it never seeks and
 * never becomes a second click target.
 *
 * The elapsed/remaining labels sit on their own line *below* the input,
 * rather than flanking it as they used to, so the input itself spans the
 * component's full width — the one measurement `TideDock` needs in order to
 * lay the TIDE's bands over the exact same x-axis as this track (prd13
 * ruling 1's "share one x-axis"), without a second, hand-tuned offset.
 */
export function Scrubber({ start, end, value, onChange, disabled = false, chapterMarkers = [] }: ScrubberProps) {
  const clamped = Math.min(end, Math.max(start, value))
  const span = Math.max(1, end - start)
  const [trackRef, trackWidth] = useTrackWidth()
  const step = trackWidth > 0 ? span / notchCount(span, trackWidth) : Math.max(1000, span / 1000)
  const [dragging, setDragging] = useState(false)

  const nearest = dragging ? nearestMarker(chapterMarkers, clamped) : null
  const thumbPercent = ((clamped - start) / span) * 100

  return (
    <div className="relative flex flex-1 flex-col normal-case tracking-normal">
      {nearest !== null && (
        <div
          aria-hidden="true"
          data-testid="scrubber-drag-label"
          className="pointer-events-none absolute -top-5 -translate-x-1/2 whitespace-nowrap rounded border border-ice-700 bg-ice-950 px-1 py-0.5 text-[10px] text-ice-100"
          style={{ left: `${thumbPercent}%` }}
        >
          {nearest.label}
        </div>
      )}
      <input
        ref={trackRef}
        type="range"
        aria-label="Replay scrubber"
        min={start}
        max={Math.max(start, end)}
        step={step}
        value={clamped}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        className="h-1 w-full accent-ice-200"
      />
      <div className="flex items-center justify-between text-[10px] leading-none text-ice-400">
        <span className="figures">{formatElapsed(clamped - start)}</span>
        <span className="figures">{formatElapsed(end - start)}</span>
      </div>
    </div>
  )
}

/**
 * How many notches to cut the session into: the smallest power of two that is
 * at least the track's width in pixels, capped so a notch is never finer than
 * one millisecond.
 *
 * A power of two, and not the pixel count itself, because `end` has to *be* a
 * grid point. The grid is `min + n * step`, and both the browser and jsdom
 * test membership in decimal arithmetic on the serialized `step` attribute —
 * where `span / 1907` does not divide `span`, however close the doubles look.
 * The far end then rounds down to the previous notch and the last pixel of
 * track, `End`, and a drag to the right edge all land a full step short: up to
 * ~2.4 minutes on an eight-hour session at a narrow width. `span / 2 ** k` is
 * exact in binary, terminates in decimal, and multiplies back to exactly
 * `span`, so the endpoint is on the grid by construction at every width.
 *
 * The cost of rounding the notch count up to a power of two is up to 2x more
 * notches than pixels — which is free, since a finer-than-pixel grid is still
 * invisible, and it is never *coarser* than a pixel.
 */
function notchCount(span: number, trackWidth: number): number {
  let notches = 1
  while (notches < trackWidth && notches * 2 <= span) notches *= 2
  return notches
}

/**
 * The input's own rendered width in whole pixels — `0` until it is knowable,
 * which is the honest answer under a DOM that reports no layout at all
 * (jsdom) as well as before the first measurement. Same shape as `TideDock`'s
 * `useElementWidth`, deliberately: measure once, then follow a
 * `ResizeObserver` where the platform has one. A layout effect rather than a
 * plain one so the very first painted frame is already pixel-stepped, instead
 * of showing one frame snapped to the coarse fallback grid.
 */
function useTrackWidth(): [RefObject<HTMLInputElement | null>, number] {
  const ref = useRef<HTMLInputElement | null>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return

    const measure = () => setWidth(Math.max(0, Math.floor(el.getBoundingClientRect().width)))
    measure()

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(el)
    return () => observer?.disconnect()
  }, [])

  return [ref, width]
}

function nearestMarker(
  markers: readonly ScrubberChapterMarker[],
  ts: number,
): ScrubberChapterMarker | null {
  let best: ScrubberChapterMarker | null = null
  let bestDist = Infinity
  for (const marker of markers) {
    const dist = Math.abs(marker.ts - ts)
    if (dist < bestDist) {
      bestDist = dist
      best = marker
    }
  }
  return best
}
