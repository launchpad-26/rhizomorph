import { useMemo } from 'react'
import { initialSessionState, reduceAll, selectSessionSpend } from '@rhizomorph/core'
import { useModeClock, useReplay } from '../app/ModeContext.js'
import { useStream } from '../app/StreamContext.js'
import { TideDock } from '../tide/TideDock.js'
import { pickRichestSession, type SessionSummary } from './api.js'
import { formatSpend } from './format.js'
import { RotateButton } from './RotateButton.js'
import { timeRangeOf } from './replayFold.js'
import { PLAYBACK_SPEEDS } from './usePlayback.js'

/**
 * `GET /api/sessions` now serves a title (a label if the operator set one
 * with `rhizomorph label`, else an auto-title derived from the session's own
 * events) and lane counts alongside the summary fields `SessionSummary`
 * already types (#156). `api.ts`/`useReplaySession.ts` sit outside this
 * issue's fence, so their `SessionSummary` type hasn't grown those fields —
 * but the raw fetch response carries them on the same objects regardless
 * (JSON passes through a type guard unchanged), so this local, optional
 * extension reads them without that file needing to change. Every field is
 * optional so a session from a server that hasn't grown them yet still
 * renders — see {@link sessionDisplayName}'s fallback.
 */
interface SessionListing extends SessionSummary {
  title?: string
  label?: string | null
  lanes?: number
  landed?: number
}

/** A label always wins; the auto-title is next; the raw timestamp is the last-resort fallback for a server that hasn't grown a title yet. */
function sessionDisplayName(session: SessionListing): string {
  if (typeof session.label === 'string' && session.label.length > 0) return session.label
  if (typeof session.title === 'string' && session.title.length > 0) return session.title
  return new Date(session.startedAt).toISOString()
}

/**
 * Session picker + scrubber. All replay state (session list, selection,
 * fetched log, scrubber clock, fold) lives in `ModeContext` — `StreamContext`
 * reads the exact same slot to serve panels, so this component only renders
 * what's already there.
 */
export default function ReplayControls() {
  const {
    sessions,
    refreshSessions,
    selectedId,
    selectSession,
    selectAndPlay,
    error,
    playback,
    range,
    state,
    events,
    isReplaying,
    unknownVoice,
  } = useReplay()

  /** The whole loaded session's spend — cheap, since `events` is already in memory. */
  const sessionTotal = useMemo(
    () => selectSessionSpend(isReplaying ? reduceAll(events) : initialSessionState()),
    [events, isReplaying],
  )
  const scrubSpend = useMemo(() => selectSessionSpend(state), [state])

  /**
   * THE TIDE'S FEED (prd13 wave 3, #169) — live and replay read two different
   * logs, the same way `StreamContext.tsx`'s own `value` does: replay's is the
   * whole session `useReplay()` already has in memory (the band body is a map
   * of the whole recording, not just what has scrubbed into view — ruling 2's
   * "the band *is* the recording's map"); live's is the raw log the *live*
   * stream source has folded so far, read via `useStream()` exactly the way
   * every panel already does, never via `StreamContext`'s replay-scoped
   * branch (that one is a scrub prefix, the wrong shape for a map of the
   * whole session-to-now).
   */
  const stream = useStream()
  const now = useModeClock()
  const liveEvents = stream.state.events
  const liveStart = useMemo(() => timeRangeOf(liveEvents)?.start ?? now, [liveEvents, now])
  const tideEvents = isReplaying ? events : liveEvents
  const tideStart = isReplaying ? range.start : liveStart
  const tideEnd = isReplaying ? range.end : now

  function replayBirth() {
    const richest = pickRichestSession(sessions)
    if (!richest) return
    if (isReplaying && selectedId === richest.id) {
      playback.play()
      return
    }
    selectAndPlay(richest.id)
  }

  return (
    <div className="flex flex-col gap-1 border-t border-ice-850 px-4 py-2 text-xs uppercase tracking-wide text-ice-400">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold tracking-widest text-ice-300">Replay</span>
        <span className="font-semibold text-ice-100">
          {isReplaying ? 'Replay mode' : 'Live mode'}
        </span>

        <button
          type="button"
          onClick={replayBirth}
          disabled={sessions.length === 0}
          title={sessions.length === 0 ? 'No recorded sessions yet' : "Replay this session's birth"}
          className="rounded border border-ice-700 px-2 py-1 normal-case tracking-normal text-ice-200 hover:border-ice-400 hover:text-ice-050 disabled:opacity-50"
        >
          {"Replay this session's birth"}
        </button>

        <label className="flex items-center gap-2 normal-case tracking-normal">
          <span className="uppercase tracking-wide text-ice-400">session</span>
          <select
            value={selectedId ?? ''}
            onChange={(event) => selectSession(event.target.value === '' ? null : event.target.value)}
            className="rounded border border-ice-850 bg-ice-1000 px-2 py-1 text-ice-200"
          >
            <option value="">Replay a recorded session…</option>
            {(sessions as SessionListing[]).map((session) => (
              <option key={session.id} value={session.id}>
                {sessionDisplayName(session)}
              </option>
            ))}
          </select>
        </label>

        {isReplaying && (
          <span
            className="normal-case tracking-normal text-ice-400"
            title="total spend for this whole recorded session, not just up to the scrub time"
          >
            total {formatSpend(sessionTotal)}
          </span>
        )}

        <button
          type="button"
          onClick={() => (playback.playing ? playback.pause() : playback.play())}
          disabled={!isReplaying}
          title={isReplaying ? undefined : 'Select a session first to enable playback'}
          className="rounded border border-ice-850 px-2 py-1 hover:border-ice-400 hover:text-ice-050 disabled:opacity-50"
        >
          {playback.playing ? 'Pause' : 'Play'}
        </button>

        <div className="flex items-center gap-1" role="group" aria-label="playback speed">
          {PLAYBACK_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              onClick={() => playback.setSpeed(speed)}
              disabled={!isReplaying}
              aria-pressed={playback.speed === speed}
              className={`rounded border px-2 py-1 disabled:opacity-50 ${
                playback.speed === speed
                  ? 'border-ice-400 text-ice-050'
                  : 'border-ice-850 hover:border-ice-400 hover:text-ice-050'
              }`}
            >
              {speed}x
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => selectSession(null)}
          disabled={!isReplaying}
          className="rounded border border-ice-850 px-2 py-1 hover:border-ice-400 hover:text-ice-050 disabled:opacity-50"
        >
          Return to live
        </button>
      </div>

      {/*
        THE OPERATOR'S SESSION BOUNDARY (prd16 ruling 2) — on its own row
        beside the picker, because that is where "which recording am I looking
        at" is already the question. Refreshing the listing on success is what
        puts the session it just closed in the picker above, immediately.
      */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold tracking-widest text-ice-300">Session</span>
        <RotateButton onRotated={refreshSessions} />
      </div>

      <TideDock
        mode={isReplaying ? 'replay' : 'live'}
        events={tideEvents}
        start={tideStart}
        end={tideEnd}
        value={playback.currentTs}
        onSeek={playback.seek}
        seekEnabled={isReplaying}
      />

      {error !== null && <p className="normal-case tracking-normal text-broken">{error}</p>}

      {isReplaying && (
        <p className="normal-case tracking-normal text-ice-400">
          {Object.keys(state.worktrees).length} worktrees · {Object.keys(state.commits).length}{' '}
          commits · {formatSpend(scrubSpend)} as of scrub time
        </p>
      )}

      {/*
        THE SESSION LISTING'S OWN VOICE (prd17 ruling 3, item 1) — on the row
        under the picker, because the picker is where a recording is CHOSEN and
        "what is in it" belongs beside that choice, not only in the banner over
        the panels.
      */}
      {unknownVoice !== null && (
        <p
          data-testid="replay-listing-unknown-era"
          className="normal-case tracking-normal text-ice-100"
          title="this recording came from a newer instrument; these events were kept in the log but this build cannot fold them"
        >
          {unknownVoice}
        </p>
      )}

      {sessions.length === 0 && error === null && (
        <p className="normal-case tracking-normal text-ice-400">no recorded sessions yet</p>
      )}
    </div>
  )
}
