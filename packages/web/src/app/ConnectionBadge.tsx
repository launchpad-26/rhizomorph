import type { ConnectionStatus } from '../hooks/useEventStream.js'
import { useMode, useReplay } from './ModeContext.js'

/** Exported so other frame chrome (StatusBar) can render the same states consistently. */
export const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'connecting…',
  open: 'live',
  error: 'connection error',
  closed: 'disconnected',
}

export const CONNECTION_DOT_CLASS: Record<ConnectionStatus, string> = {
  connecting: 'bg-neon-amber glow-amber animate-pulse',
  open: 'bg-neon-cyan glow-cyan',
  error: 'bg-neon-magenta glow-magenta',
  closed: 'bg-slate-600',
}

/** `mm:ss` elapsed since session start — mirrors the replay scrubber's own format. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * The header badge next to the app title: it must never let a screenshot of
 * the top of the page read as "live" while the app is folding a recorded
 * session. Reads mode from `ModeContext` (the one source of truth shared with
 * the replay bar) rather than inferring it from stream state.
 */
export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const mode = useMode()
  const { playback, range } = useReplay()

  if (mode === 'replay') {
    const elapsed = formatElapsed(playback.currentTs - range.start)
    const total = formatElapsed(range.end - range.start)
    return (
      <span className="inline-flex items-center gap-2 text-xs uppercase tracking-wide">
        <span className="h-2 w-2 rounded-full bg-neon-amber glow-amber" aria-hidden="true" />
        <span className="font-semibold text-neon-amber">replay</span>
        <span className="tabular-nums text-slate-500">
          {elapsed} / {total}
        </span>
        <span
          className="inline-flex items-center gap-1 normal-case tracking-normal text-slate-600"
          title={`Stream: ${CONNECTION_LABEL[status]}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${CONNECTION_DOT_CLASS[status]}`} aria-hidden="true" />
          sse
        </span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
      <span className={`h-2 w-2 rounded-full ${CONNECTION_DOT_CLASS[status]}`} aria-hidden="true" />
      {CONNECTION_LABEL[status]}
    </span>
  )
}
