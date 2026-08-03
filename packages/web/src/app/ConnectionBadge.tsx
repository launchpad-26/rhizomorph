import type { ConnectionStatus } from '../hooks/useEventStream.js'
import { useMode, useReplay } from './ModeContext.js'
import { formatElapsed } from '../replay/format.js'

/** Exported so other frame chrome (StatusBar) can render the same states consistently. */
export const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'connecting…',
  open: 'live',
  error: 'connection error',
  closed: 'disconnected',
}

export const CONNECTION_DOT_CLASS: Record<ConnectionStatus, string> = {
  connecting: 'bg-needs-you glow-needs-you animate-pulse',
  open: 'bg-notice glow-notice',
  error: 'bg-broken glow-broken',
  closed: 'bg-ice-700',
}

/**
 * The header badge next to the app title: it must never let a screenshot of
 * the top of the page read as "live" while the app is folding a recorded
 * session. Reads mode from `ModeContext` (the one source of truth shared with
 * the replay bar) rather than inferring it from stream state.
 *
 * The replay indicator itself stays in the ice register, never a ladder hue
 * (law 9) — a mode is not a status, so it must not borrow the vocabulary the
 * alarm ladder owns exclusively. The connection dot beside it keeps the
 * ladder mapping: SSE health is a real status, replay or not.
 */
export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const mode = useMode()
  const { playback, range } = useReplay()

  if (mode === 'replay') {
    const elapsed = formatElapsed(playback.currentTs - range.start)
    const total = formatElapsed(range.end - range.start)
    return (
      <span className="inline-flex items-center gap-2 text-xs uppercase tracking-wide">
        <span className="h-2 w-2 rounded-full bg-ice-100 glow-calm" aria-hidden="true" />
        <span className="font-semibold text-ice-100">replay</span>
        <span className="figures text-ice-400">
          {elapsed} / {total}
        </span>
        <span
          className="inline-flex items-center gap-1 normal-case tracking-normal text-ice-400"
          title={`Stream: ${CONNECTION_LABEL[status]}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${CONNECTION_DOT_CLASS[status]}`} aria-hidden="true" />
          sse
        </span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-ice-400">
      <span className={`h-2 w-2 rounded-full ${CONNECTION_DOT_CLASS[status]}`} aria-hidden="true" />
      {CONNECTION_LABEL[status]}
    </span>
  )
}
