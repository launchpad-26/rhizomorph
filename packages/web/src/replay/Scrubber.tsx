export interface ScrubberProps {
  start: number
  end: number
  value: number
  onChange(ts: number): void
  disabled?: boolean
}

/** `mm:ss` since the start of the session — readable without a real clock. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function Scrubber({ start, end, value, onChange, disabled = false }: ScrubberProps) {
  const clamped = Math.min(end, Math.max(start, value))

  return (
    <div className="flex flex-1 items-center gap-2 normal-case tracking-normal">
      <span className="tabular-nums text-slate-500">{formatElapsed(clamped - start)}</span>
      <input
        type="range"
        aria-label="Replay scrubber"
        min={start}
        max={Math.max(start, end)}
        value={clamped}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1 flex-1 accent-neon-cyan"
      />
      <span className="tabular-nums text-slate-500">{formatElapsed(end - start)}</span>
    </div>
  )
}
