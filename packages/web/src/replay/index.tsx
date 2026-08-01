import { useMemo } from 'react'
import { initialSessionState, reduceAll, selectSessionSpend } from '@observatory/core'
import { useReplay } from '../app/ModeContext.js'
import { pickRichestSession } from './api.js'
import { formatSpend } from './format.js'
import { Scrubber } from './Scrubber.js'
import { PLAYBACK_SPEEDS } from './usePlayback.js'

/**
 * Session picker + scrubber. All replay state (session list, selection,
 * fetched log, scrubber clock, fold) lives in `ModeContext` — `StreamContext`
 * reads the exact same slot to serve panels, so this component only renders
 * what's already there.
 */
export default function ReplayControls() {
  const {
    sessions,
    selectedId,
    selectSession,
    selectAndPlay,
    error,
    playback,
    range,
    state,
    events,
    isReplaying,
  } = useReplay()

  /** The whole loaded session's spend — cheap, since `events` is already in memory. */
  const sessionTotal = useMemo(
    () => selectSessionSpend(isReplaying ? reduceAll(events) : initialSessionState()),
    [events, isReplaying],
  )
  const scrubSpend = useMemo(() => selectSessionSpend(state), [state])

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
    <div className="flex flex-col gap-2 border-t border-ice-850 px-4 py-2 text-xs uppercase tracking-wide text-ice-500">
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
          <span className="uppercase tracking-wide text-ice-600">session</span>
          <select
            value={selectedId ?? ''}
            onChange={(event) => selectSession(event.target.value === '' ? null : event.target.value)}
            className="rounded border border-ice-850 bg-ice-1000 px-2 py-1 text-ice-200"
          >
            <option value="">Replay a recorded session…</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {new Date(session.startedAt).toISOString()}
              </option>
            ))}
          </select>
        </label>

        {isReplaying && (
          <span
            className="normal-case tracking-normal text-ice-600"
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

        <Scrubber
          start={range.start}
          end={range.end}
          value={playback.currentTs}
          onChange={playback.seek}
          disabled={!isReplaying}
        />

        <button
          type="button"
          onClick={() => selectSession(null)}
          disabled={!isReplaying}
          className="rounded border border-ice-850 px-2 py-1 hover:border-ice-400 hover:text-ice-050 disabled:opacity-50"
        >
          Return to live
        </button>
      </div>

      {error !== null && <p className="normal-case tracking-normal text-broken">{error}</p>}

      {isReplaying && (
        <p className="normal-case tracking-normal text-ice-600">
          {Object.keys(state.worktrees).length} worktrees · {Object.keys(state.commits).length}{' '}
          commits · {formatSpend(scrubSpend)} as of scrub time
        </p>
      )}

      {sessions.length === 0 && error === null && (
        <p className="normal-case tracking-normal text-ice-700">no recorded sessions yet</p>
      )}
    </div>
  )
}
