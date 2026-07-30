import type { ConnectionStatus } from '../hooks/useEventStream.js'

const LABEL: Record<ConnectionStatus, string> = {
  connecting: 'connecting…',
  open: 'live',
  error: 'connection error',
  closed: 'disconnected',
}

const DOT_CLASS: Record<ConnectionStatus, string> = {
  connecting: 'bg-neon-amber glow-amber animate-pulse',
  open: 'bg-neon-cyan glow-cyan',
  error: 'bg-neon-magenta glow-magenta',
  closed: 'bg-slate-600',
}

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
      <span className={`h-2 w-2 rounded-full ${DOT_CLASS[status]}`} aria-hidden="true" />
      {LABEL[status]}
    </span>
  )
}
