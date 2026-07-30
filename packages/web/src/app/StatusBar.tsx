import { useMemo } from 'react'
import { reduceAll, type CollectorState } from '@observatory/core'
import { CONNECTION_DOT_CLASS, CONNECTION_LABEL } from './ConnectionBadge.js'
import { useStream } from './StreamContext.js'

/** The three optional sources prd0 promises degrade gracefully. */
type SourceKey = 'git' | 'tmux' | 'workmux'

const SOURCES: readonly SourceKey[] = ['git', 'tmux', 'workmux']

const SOURCE_LABEL: Record<SourceKey, string> = {
  git: 'Git',
  tmux: 'Tmux',
  workmux: 'Workmux',
}

type SourceHealth = 'live' | 'disabled' | 'errored'

const HEALTH_DOT_CLASS: Record<SourceHealth, string> = {
  live: 'bg-neon-cyan glow-cyan',
  disabled: 'bg-slate-600',
  errored: 'bg-neon-magenta glow-magenta',
}

interface SourceStatus {
  health: SourceHealth
  message: string | null
}

/** No `collector.*` event seen for a source yet — that silence *is* "live". */
function sourceStatus(collector: CollectorState | undefined): SourceStatus {
  if (collector === undefined) return { health: 'live', message: null }
  if (collector.status === 'disabled') {
    return { health: 'disabled', message: collector.disabledReason }
  }
  return { health: 'errored', message: collector.lastErrorMessage }
}

/** One quiet line: per-source collector health, plus the SSE connection state. */
export function StatusBar() {
  const { state, status } = useStream()
  const session = useMemo(() => reduceAll(state.events), [state.events])

  return (
    <div className="flex h-8 items-center gap-4 border-t border-void-line bg-void-raised px-4 text-xs">
      <span className="text-[10px] uppercase tracking-widest text-slate-600">Sources</span>
      {SOURCES.map((source) => {
        const { health, message } = sourceStatus(session.collectors[source])
        const label = SOURCE_LABEL[source]
        const description = message === null ? `${label}: ${health}` : `${label}: ${health} — ${message}`
        return (
          <span
            key={source}
            data-source={source}
            data-health={health}
            role="status"
            tabIndex={0}
            title={message ?? undefined}
            aria-label={description}
            className="inline-flex items-center gap-1.5 rounded outline-none focus-visible:ring-1 focus-visible:ring-neon-cyan"
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${HEALTH_DOT_CLASS[health]}`}
            />
            <span className="text-slate-400">{label}</span>
          </span>
        )
      })}
      <span
        className="ml-auto inline-flex items-center gap-1.5"
        title={CONNECTION_LABEL[status]}
        aria-label={`Stream: ${CONNECTION_LABEL[status]}`}
      >
        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${CONNECTION_DOT_CLASS[status]}`} />
        <span className="text-slate-400">SSE</span>
      </span>
    </div>
  )
}
