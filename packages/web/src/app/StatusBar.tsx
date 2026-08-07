import { useEffect, useMemo, useState } from 'react'
import { selectConnection, type CollectorState, type SourceFlow } from '@rhizomorph/core'
import { useFleet } from '../fleet/index.js'
import { formatTokens } from '../lib/format.js'
import { CONNECTION_DOT_CLASS, CONNECTION_LABEL } from './ConnectionBadge.js'
import { useMode, useReplay } from './ModeContext.js'
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

/**
 * THE SESSION VOICE (#181) — this same line also names the session driving
 * the fleet, so a multi-day 55k-event run reads as one instead of looking
 * indistinguishable from a session that just started.
 *
 * Identity, age and the live event count already flow through the event fold
 * every panel reads (`SessionInfo`/`Fleet.eventCount`) — no fetch needed for
 * those, and they stay accurate for a long-running session instead of aging
 * out of a boot-time snapshot. The one thing nothing else carries is *how
 * this boot decided to continue that session*: `resumedCount`,
 * `resumeWindowMs`, `lastBootReason` — #180's additive `/api/meta` fields,
 * fetched once here.
 */

type MetaFetchLike = (input: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

const SESSION_META_URL = '/api/meta'

/**
 * prd16 ruling 2 added two: `rotated` (this session exists because the
 * operator ended the last one, here or from `rhizomorph rotate`) and `closed`
 * (a boot that found a closed log and started fresh rather than resuming it).
 * A reason this list doesn't know still reads as "unavailable" rather than
 * being half-trusted — see {@link parseBootFacts}.
 */
const KNOWN_BOOT_REASONS = ['fresh-flag', 'resumed', 'stale', 'first-run', 'rotated', 'closed'] as const
type SessionBootReason = (typeof KNOWN_BOOT_REASONS)[number]

interface SessionBootFacts {
  resumedCount: number
  resumeWindowMs: number
  lastBootReason: SessionBootReason
}

type BootFactsState =
  | { status: 'loading' | 'absent' }
  | { status: 'ready'; facts: SessionBootFacts }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * `#180`'s additive shape, or `null` for anything else — a server that
 * predates it (missing fields entirely) and a malformed body both read the
 * same way to this bar: the boot facts are unavailable, never half-trusted.
 */
function parseBootFacts(body: unknown): SessionBootFacts | null {
  if (!isRecord(body)) return null
  const { resumedCount, resumeWindowMs, lastBootReason } = body
  if (
    typeof resumedCount === 'number' &&
    typeof resumeWindowMs === 'number' &&
    typeof lastBootReason === 'string' &&
    (KNOWN_BOOT_REASONS as readonly string[]).includes(lastBootReason)
  ) {
    return { resumedCount, resumeWindowMs, lastBootReason: lastBootReason as SessionBootReason }
  }
  return null
}

function defaultMetaFetch(): MetaFetchLike | null {
  return typeof globalThis.fetch === 'function'
    ? ((input: string) => globalThis.fetch(input)) as MetaFetchLike
    : null
}

/**
 * Fetched while live, and re-read whenever the live session's IDENTITY
 * changes. Replaying reads a *different* session's identity (point 3 below),
 * so asking `/api/meta` (which only ever describes the live recorder) while
 * replaying would be a wasted request whose answer must be discarded anyway.
 *
 * The re-read exists because of prd16 ruling 2: the operator can now end a
 * session and start another without restarting the instrument, and the boot
 * facts — `lastBootReason`, `resumedCount` — belong to the session being
 * recorded, not to the process. A session id that changed under a live stream
 * IS that boundary (the only other time it changes is the first
 * `session.started` arriving, one extra localhost GET of a small object,
 * which is a fair price for a provenance line that cannot go stale).
 */
function useSessionBootFacts(
  enabled: boolean,
  liveSessionId: string | null,
  fetchImpl?: MetaFetchLike,
): BootFactsState {
  const [state, setState] = useState<BootFactsState>({ status: 'loading' })

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'loading' })
      return
    }

    const impl = fetchImpl ?? defaultMetaFetch()
    if (impl === null) {
      setState({ status: 'absent' })
      return
    }

    let live = true
    setState({ status: 'loading' })
    impl(SESSION_META_URL)
      .then(async (response) => (response.ok ? parseBootFacts(await response.json()) : null))
      .catch(() => null)
      .then((facts) => {
        if (!live) return
        setState(facts === null ? { status: 'absent' } : { status: 'ready', facts })
      })

    return () => {
      live = false
    }
  }, [enabled, fetchImpl, liveSessionId])

  return state
}

const MINUTE_MS = 60_000
const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR

/** `"3d4h"`, `"2h04m"`, `"12m"` — the session line's own compact span text. */
function formatSessionSpan(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / MINUTE_MS))
  const days = Math.floor(totalMinutes / MINUTES_PER_DAY)
  const hours = Math.floor((totalMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR)
  const minutes = totalMinutes % MINUTES_PER_HOUR
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

/**
 * The hover explanation (point 2): the reason and the window, in the boot
 * line's own voice. It does not restate the CLI boot line's precise "newest
 * event 2h04m old" figure — `previousAgeMs` is `decideSessionBoot`'s own
 * internal fact (`session-log.ts`), never added to `/api/meta`'s contract,
 * so reproducing it here would mean guessing rather than reading it.
 */
function bootExplanation(facts: SessionBootFacts): string {
  const window = formatSessionSpan(facts.resumeWindowMs)
  switch (facts.lastBootReason) {
    case 'resumed':
      return `resumed: this boot continued the session — its last activity was inside the ${window} window — --fresh or --resume-window forces a boundary`
    case 'stale':
      return `starting: the previous session's activity was outside the ${window} window — --resume-window widens it`
    case 'fresh-flag':
      return `starting: --fresh forced a new session regardless of the ${window} window`
    case 'first-run':
      return `starting: no earlier session was found for this repo`
    case 'rotated':
      return `rotated: you ended the previous session here — this one began the moment you did, and the closed recording is in the replay picker`
    case 'closed':
      return `starting: the previous session was ended explicitly (\`rhizomorph rotate\`) — a closed recording is never resumed, whatever the ${window} window says`
  }
}

interface SessionVoice {
  text: string
  title: string
}

/**
 * Live: identity/age/count from the event fold (`fleet.now` — #155's mode
 * clock — minus `session.startedAt`), the resume clause from the boot facts
 * once they arrive. Before they arrive, or on a server that predates them,
 * point 4's honest gap: the session id alone with an em dash, never a
 * fabricated age or count.
 *
 * Replay: point 3 — the REPLAYED session's own identity (id, span, event
 * count), read from `useReplay()`, never the live facts above. There is no
 * boot-facts concept for an arbitrary recorded session (`/api/meta` only
 * ever describes the live recorder), so the resumed clause never appears
 * here.
 */
function useSessionVoice(bootFacts: BootFactsState): SessionVoice | null {
  const mode = useMode()
  const replay = useReplay()
  const { state } = useStream()
  const fleet = useFleet()
  // `state.session` is the whole folded `SessionState` (collectors,
  // worktrees, …); the session's own identity is nested one level deeper —
  // the `session.started` event's payload, or null before it has arrived.
  const info = state.session.session

  return useMemo<SessionVoice | null>(() => {
    if (mode === 'replay') {
      const spanMs = replay.range.end - replay.range.start
      const count = formatTokens(replay.events.length)
      return {
        text: `session ${replay.selectedId ?? '—'} · ${formatSessionSpan(spanMs)} · ${count} events`,
        title: `replayed session — ${replay.events.length} events across ${formatSessionSpan(spanMs)}`,
      }
    }

    if (info === null) return null

    if (bootFacts.status !== 'ready') {
      return {
        text: `session ${info.sessionId} —`,
        title: 'boot facts unavailable — the server may predate resume-window support, or has not answered yet',
      }
    }

    const ageMs = fleet.now - info.startedAt
    const resumedClause =
      bootFacts.facts.resumedCount > 0 ? ` · resumed x${bootFacts.facts.resumedCount}` : ''
    return {
      text: `session ${formatSessionSpan(ageMs)} · ${formatTokens(fleet.eventCount)} events${resumedClause}`,
      title: bootExplanation(bootFacts.facts),
    }
  }, [mode, replay.selectedId, replay.range, replay.events.length, info, bootFacts, fleet.now, fleet.eventCount])
}

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

type SourceHealth = 'live' | 'waiting' | 'disabled' | 'errored'

/**
 * Law 9: only `errored` is a real ladder rung here (`buildFleet` climbs an
 * errored collector to NOTICE), so only it may wear a ladder hue. `live` is
 * the calm, neutral ice register; `waiting` and `disabled` share the same
 * muted mark the ice ramp reserves for "absent" — an unproven source is an
 * expected degrade, same as a deliberately-off one, never an alarm.
 */
const HEALTH_DOT_CLASS: Record<SourceHealth, string> = {
  live: 'bg-calm glow-calm',
  waiting: 'bg-ice-700',
  disabled: 'bg-ice-700',
  errored: 'bg-notice glow-notice',
}

interface SourceStatus {
  health: SourceHealth
  message: string | null
}

/**
 * prd19 ruling 4 — SILENCE IS NEVER LIVE. The rule this replaces, kept here
 * verbatim for the record because it is the exact lie ruling 4 exists to
 * kill: "No `collector.*` event seen for a source yet — that silence *is*
 * 'live'." A never-connected OTel receiver wore the same calm dot as a
 * healthy one, and a stranger who started the server had no way to learn
 * that nothing had ever arrived.
 *
 * `live` now requires PROOF: a folded record `selectConnection` (#251) can
 * point at, over the same folded state every other panel reads. No collector
 * record *and* no flow renders `waiting` ("no data yet") — a muted dot, the
 * same visual weight `disabled` already wears, because a source that has
 * proved nothing yet is an expected degrade, never an alarm. This is honest
 * rather than alarmist on purpose: an OTel exporter's first batch can lag the
 * transcript by an export interval, so "waiting" is the correct reading for
 * a source that is merely quiet, not necessarily broken (#258 owns whether a
 * consumer should weigh elapsed time before calling it anything stronger).
 *
 * A collector record is still the stronger fact and wins outright, exactly as
 * before this ruling — this only changes what "no record at all" defaults to.
 */
function sourceStatus(collector: CollectorState | undefined, flow: SourceFlow): SourceStatus {
  if (collector === undefined) {
    return flow.firstEventTs === null
      ? { health: 'waiting', message: 'no data yet' }
      : { health: 'live', message: null }
  }
  if (collector.status === 'disabled') {
    return { health: 'disabled', message: collector.disabledReason }
  }
  return { health: 'errored', message: collector.lastErrorMessage }
}

export interface StatusBarProps {
  /** Test-only escape hatch for injecting a mock `/api/meta` fetch (#181). */
  fetchMeta?: MetaFetchLike
}

/** One quiet line: per-source collector health, the gap voice, the session voice, and the SSE state. */
export function StatusBar({ fetchMeta }: StatusBarProps = {}) {
  const { state, status } = useStream()
  const fleet = useFleet()
  const mode = useMode()
  const session = state.session

  const bootFacts = useSessionBootFacts(
    mode === 'live',
    // The folded live identity — a rotation replaces it mid-stream.
    session.session?.sessionId ?? null,
    fetchMeta,
  )
  const sessionVoice = useSessionVoice(bootFacts)

  // prd19 ruling 4's proof: one pass over the same fold every other panel
  // reads, so live view, replay and fixtures cannot disagree about which
  // sources have proved flow.
  const connection = useMemo(() => selectConnection(session), [session])

  // Law 12: WHAT is missing → WHY it matters → THE command. Only the dead
  // (disabled) collectors speak here; a merely errored one already reads
  // `errored` in the pill above and has escalated to the strip separately.
  const deadCollectorGaps = fleet.gaps.filter((gap) => gap.id.startsWith('collector-disabled:'))

  return (
    <div className="flex flex-col gap-1 border-t border-ice-850 bg-ice-950 px-4 py-1.5 text-xs">
      <div className="flex h-6 items-center gap-4">
        <span className="text-[10px] uppercase tracking-widest text-ice-400">Sources</span>
        {SOURCES.map((source) => {
          const { health, message } = sourceStatus(session.collectors[source], connection[source])
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
        {sessionVoice !== null && (
          <span
            data-testid="session-voice"
            role="status"
            tabIndex={0}
            title={sessionVoice.title}
            aria-label={sessionVoice.title}
            className="figures text-ice-400 outline-none focus-visible:ring-1 focus-visible:ring-notice"
          >
            {sessionVoice.text}
          </span>
        )}
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
              className="flex flex-wrap items-baseline gap-1.5 text-[11px] text-ice-400"
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
