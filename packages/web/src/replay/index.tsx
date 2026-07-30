import type { ObservatoryEvent } from '@observatory/core'
import { useEffect, useMemo, useState } from 'react'
import { fetchSessionEvents, fetchSessions, type FetchLike, type SessionSummary } from './api.js'
import { foldUpTo, timeRangeOf } from './replayFold.js'
import { Scrubber } from './Scrubber.js'
import { PLAYBACK_SPEEDS, usePlayback } from './usePlayback.js'

export interface ReplayControlsProps {
  /** Test-only escape hatch for injecting a mock fetch implementation. */
  fetchImpl?: FetchLike
}

/**
 * Session picker + scrubber. Replay folds a fetched history slice through the
 * exact same core reducer live uses (`foldUpTo`) — that shared identity is
 * the whole reason this panel can exist without its own derivation logic.
 */
export default function ReplayControls({ fetchImpl }: ReplayControlsProps = {}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [events, setEvents] = useState<ObservatoryEvent[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchSessions(fetchImpl)
      .then((loaded) => {
        if (!cancelled) setSessions(loaded)
      })
      .catch(() => {
        if (!cancelled) setError('could not load sessions')
      })
    return () => {
      cancelled = true
    }
  }, [fetchImpl])

  useEffect(() => {
    if (selectedId === null) {
      setEvents([])
      return
    }
    let cancelled = false
    fetchSessionEvents(selectedId, fetchImpl)
      .then((loaded) => {
        if (!cancelled) setEvents(loaded)
      })
      .catch(() => {
        if (!cancelled) setError(`could not load session "${selectedId}"`)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, fetchImpl])

  const range = useMemo(() => timeRangeOf(events) ?? { start: 0, end: 0 }, [events])
  const playback = usePlayback({ start: range.start, end: range.end })
  const state = useMemo(() => foldUpTo(events, playback.currentTs), [events, playback.currentTs])

  const isReplaying = selectedId !== null && events.length > 0

  return (
    <div className="flex flex-col gap-2 border-t border-void-line bg-void-raised px-4 py-2 text-xs uppercase tracking-wide text-slate-400">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold text-neon-cyan">
          {isReplaying ? 'Replay mode' : 'Live mode'}
        </span>

        <label className="flex items-center gap-2 normal-case tracking-normal">
          <span className="uppercase tracking-wide text-slate-500">session</span>
          <select
            value={selectedId ?? ''}
            onChange={(event) => setSelectedId(event.target.value === '' ? null : event.target.value)}
            className="rounded border border-void-line bg-void px-2 py-1 text-slate-200"
          >
            <option value="">— select a session —</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {new Date(session.startedAt).toISOString()}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => (playback.playing ? playback.pause() : playback.play())}
          disabled={!isReplaying}
          className="rounded border border-void-line px-2 py-1 hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-50"
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
                  ? 'border-neon-cyan text-neon-cyan'
                  : 'border-void-line hover:border-neon-cyan hover:text-neon-cyan'
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
          onClick={() => setSelectedId(null)}
          disabled={!isReplaying}
          className="rounded border border-void-line px-2 py-1 hover:border-neon-magenta hover:text-neon-magenta disabled:opacity-50"
        >
          Return to live
        </button>
      </div>

      {error !== null && <p className="normal-case tracking-normal text-neon-magenta">{error}</p>}

      {isReplaying && (
        <p className="normal-case tracking-normal text-slate-500">
          {Object.keys(state.worktrees).length} worktrees · {Object.keys(state.commits).length}{' '}
          commits · {Object.keys(state.agents).length} agents as of scrub time
        </p>
      )}

      {sessions.length === 0 && error === null && (
        <p className="normal-case tracking-normal text-slate-600">no recorded sessions yet</p>
      )}
    </div>
  )
}
