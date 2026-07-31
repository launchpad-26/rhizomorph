import type { CollectorState } from '@observatory/core'
import { useFleet } from '../fleet/index.js'
import { CONNECTION_DOT_CLASS, CONNECTION_LABEL } from './ConnectionBadge.js'
import { useStream } from './StreamContext.js'

/**
 * THE PROVENANCE BAR (ruling 15) — ambient bottom line naming each
 * collector/source and its state, plus the gap voice (law 12) for the ones
 * that are dead. A collector that has gone from disabled to genuinely
 * *broken* (`status: 'error'`) also escalates to the attention strip through
 * the one derived fleet object's gap registry (`buildFleet`, #75) — this bar
 * renders the ambient line, never the strip.
 *
 * Reconciled minimally against #75: the mode affordance (live/replay) moved
 * to the shell's `ConnectionBadge` next to the wordmark; the connection dot
 * this bar already had stays here, since nothing asked it to move.
 */

/** The five optional sources prd0/prd2 promise degrade gracefully. */
type SourceKey = 'git' | 'tmux' | 'workmux' | 'sessionlog' | 'otel'

const SOURCES: readonly SourceKey[] = ['git', 'tmux', 'workmux', 'sessionlog', 'otel']

const SOURCE_LABEL: Record<SourceKey, string> = {
  git: 'Git',
  tmux: 'Tmux',
  workmux: 'Workmux',
  sessionlog: 'Sessionlog',
  otel: 'OTel',
}

type SourceHealth = 'live' | 'disabled' | 'errored'

/**
 * Law 9: only `errored` is a real ladder rung here (`buildFleet` climbs an
 * errored collector to NOTICE), so only it may wear a ladder hue. `live` is
 * the calm, neutral ice register; `disabled` is the same muted mark the ice
 * ramp reserves for "absent" — an expected degrade, not an alarm.
 */
const HEALTH_DOT_CLASS: Record<SourceHealth, string> = {
  live: 'bg-calm glow-calm',
  disabled: 'bg-ice-700',
  errored: 'bg-notice glow-notice',
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

/** One quiet line: per-source collector health, the gap voice, and the SSE state. */
export function StatusBar() {
  const { state, status } = useStream()
  const fleet = useFleet()
  const session = state.session

  // Law 12: WHAT is missing → WHY it matters → THE command. Only the dead
  // (disabled) collectors speak here; a merely errored one already reads
  // `errored` in the pill above and has escalated to the strip separately.
  const deadCollectorGaps = fleet.gaps.filter((gap) => gap.id.startsWith('collector-disabled:'))

  return (
    <div className="flex flex-col gap-1 border-t border-ice-850 bg-ice-950 px-4 py-1.5 text-xs">
      <div className="flex h-6 items-center gap-4">
        <span className="text-[10px] uppercase tracking-widest text-ice-600">Sources</span>
        {SOURCES.map((source) => {
          const { health, message } = sourceStatus(session.collectors[source])
          const label = SOURCE_LABEL[source]
          const description =
            message === null ? `${label}: ${health}` : `${label}: ${health} — ${message}`
          return (
            <span
              key={source}
              data-source={source}
              data-health={health}
              role="status"
              tabIndex={0}
              title={message ?? undefined}
              aria-label={description}
              className="inline-flex items-center gap-1.5 rounded outline-none focus-visible:ring-1 focus-visible:ring-notice"
            >
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${HEALTH_DOT_CLASS[health]}`}
              />
              <span className="text-ice-400">{label}</span>
            </span>
          )
        })}
        <span
          className="ml-auto inline-flex items-center gap-1.5"
          title={CONNECTION_LABEL[status]}
          aria-label={`Stream: ${CONNECTION_LABEL[status]}`}
        >
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${CONNECTION_DOT_CLASS[status]}`}
          />
          <span className="text-ice-400">SSE</span>
        </span>
      </div>

      {deadCollectorGaps.length > 0 ? (
        <ul className="flex flex-col gap-0.5" aria-label="Collector gaps">
          {deadCollectorGaps.map((gap) => (
            <li
              key={gap.id}
              role="status"
              data-testid="gap-voice"
              className="flex flex-wrap items-baseline gap-1.5 text-[11px] text-ice-500"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-ice-700" />
              <span className="font-medium text-ice-300">{gap.what}</span>
              <span>— {gap.why} — run:</span>
              <span className="figures text-ice-200">{gap.command}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
