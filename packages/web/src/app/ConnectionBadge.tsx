import type { ConnectionStatus } from '../hooks/useEventStream.js'
import { useMode, useReplay } from './ModeContext.js'
import { formatElapsed } from '../replay/format.js'
import { useStream } from './StreamContext.js'

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
 * session — or a fixture (prd-19 ruling 6: "a fixture must never pass as
 * live data"). Reads mode from `ModeContext` (the one source of truth shared
 * with the replay bar) rather than inferring it from stream state, and reads
 * `source`/`provenance` from `StreamContext` for the fixture case — keys
 * 1/2/3 flip `source` away from `'live'` without ever touching `mode`.
 *
 * The replay indicator itself stays in the ice register, never a ladder hue
 * (law 9) — a mode is not a status, so it must not borrow the vocabulary the
 * alarm ladder owns exclusively. In replay, the small sse dot keeps the
 * ladder mapping: there the `status` prop is the live hook's own reading.
 *
 * Outside replay the dot follows the same source split as the label: while a
 * fixture drives, `StreamContext`'s fixture branch FABRICATES `status: 'open'`
 * (StreamContext.tsx — it never consults the real SSE), so the ladder hue
 * would be a costume, not a reading. A fixture's dot therefore joins the ice
 * register, like replay's mode dot — a synthetic source has no connection
 * health to report. (PR #282 review finding; the earlier claim here that the
 * dot's status stays "real" under fixtures was wrong.)
 */
export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const mode = useMode()
  const { playback, range } = useReplay()
  const { source, provenance } = useStream()

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

  // Ruling 6: the driving log's own provenance stands in for the connection
  // label the instant it is not `live` — a fixture fleet (keys 1/2/3) must
  // never read as the real thing, whatever the SSE status underneath it is.
  const label = source === 'live' ? CONNECTION_LABEL[status] : provenance
  // ...and the dot goes with it: the fixture branch fabricates `status`, so
  // only a live source may wear a ladder hue (see the header comment).
  const dotClass = source === 'live' ? CONNECTION_DOT_CLASS[status] : 'bg-ice-100 glow-calm'

  return (
    <span className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-ice-400">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
      {label}
    </span>
  )
}
