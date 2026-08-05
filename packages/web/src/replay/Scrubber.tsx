import { useState } from 'react'
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
  const step = Math.max(1000, span / 1000)
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
