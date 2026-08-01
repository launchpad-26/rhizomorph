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
 * Home/End, Page Up/Down) — kept by construction, never reimplemented.
 */
export function Scrubber({ start, end, value, onChange, disabled = false }: ScrubberProps) {
  const clamped = Math.min(end, Math.max(start, value))

  return (
    <div className="flex flex-1 items-center gap-2 normal-case tracking-normal">
      <span className="figures text-ice-500">{formatElapsed(clamped - start)}</span>
      <input
        type="range"
        aria-label="Replay scrubber"
        min={start}
        max={Math.max(start, end)}
        value={clamped}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1 flex-1 accent-ice-200"
      />
      <span className="figures text-ice-500">{formatElapsed(end - start)}</span>
    </div>
  )
}
