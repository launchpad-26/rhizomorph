import { formatElapsed } from './format.js'

export interface ScrubberProps {
  start: number
  end: number
  value: number
  onChange(ts: number): void
  disabled?: boolean
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
 * The elapsed/remaining labels sit on their own line *below* the input,
 * rather than flanking it as they used to, so the input itself spans the
 * component's full width — the one measurement `TideDock` needs in order to
 * lay the TIDE's bands over the exact same x-axis as this track (prd13
 * ruling 1's "share one x-axis"), without a second, hand-tuned offset.
 */
export function Scrubber({ start, end, value, onChange, disabled = false }: ScrubberProps) {
  const clamped = Math.min(end, Math.max(start, value))

  return (
    <div className="flex flex-1 flex-col normal-case tracking-normal">
      <input
        type="range"
        aria-label="Replay scrubber"
        min={start}
        max={Math.max(start, end)}
        value={clamped}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1 w-full accent-ice-200"
      />
      <div className="flex items-center justify-between text-[10px] leading-none text-ice-400">
        <span className="figures">{formatElapsed(clamped - start)}</span>
        <span className="figures">{formatElapsed(end - start)}</span>
      </div>
    </div>
  )
}
