import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { initialSessionState, type RhizomorphEvent, type SessionState } from '@rhizomorph/core'
import { fetchSessionEvents, fetchSessions, type FetchLike, type SessionSummary } from './api.js'
import {
  buildSessionIndex,
  foldFrom,
  initialFoldCursor,
  timeRangeOf,
  type FoldCursor,
  type SessionIndex,
  type TimeRange,
} from './replayFold.js'
import { usePlayback, type UsePlaybackResult } from './usePlayback.js'

export interface ReplaySession {
  sessions: SessionSummary[]
  selectedId: string | null
  selectSession(id: string | null): void
  /** Selects a session and starts playback as soon as its events finish loading. */
  selectAndPlay(id: string): void
  /** Raw log for the selected session, fetched in full up front. */
  events: RhizomorphEvent[]
  error: string | null
  playback: UsePlaybackResult
  range: TimeRange
  /** Events at or before the scrub time — the raw shape `StreamContext` serves panels. */
  eventsAtScrubTime: RhizomorphEvent[]
  /** The same slice, folded through the core reducer — the replay controls' own summary. */
  state: SessionState
  isReplaying: boolean
}

export interface UseReplaySessionOptions {
  /** Test-only escape hatch for injecting a mock fetch implementation. */
  fetchImpl?: FetchLike
}

/**
 * Owns session selection, history fetch and the scrubber clock — the single
 * source of replay truth that `ModeContext` serves to both the replay
 * controls and `StreamContext`, so panels and the transport never disagree
 * about "now" (architecture.md, "live and replay are the same reducer").
 */
export function useReplaySession({ fetchImpl }: UseReplaySessionOptions = {}): ReplaySession {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [events, setEvents] = useState<RhizomorphEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  /** Session id awaiting its events before auto-starting playback (`selectAndPlay`). */
  const autoplaySessionIdRef = useRef<string | null>(null)

  const selectSession = useCallback((id: string | null) => {
    autoplaySessionIdRef.current = null
    setSelectedId(id)
  }, [])

  const selectAndPlay = useCallback((id: string) => {
    autoplaySessionIdRef.current = id
    setSelectedId(id)
  }, [])

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

  // Sorted once and keyframed once per session load (#160) — everything a
  // scrub does afterwards is O(log n) plus the events actually crossed.
  const sessionIndex = useMemo(() => buildSessionIndex(events), [events])

  // Runs after `usePlayback`'s own reset-on-new-range effect (hook call order
  // within this component determines effect order), so this play() wins over
  // that effect's pause-on-load reset instead of racing it.
  useEffect(() => {
    if (
      autoplaySessionIdRef.current !== null &&
      autoplaySessionIdRef.current === selectedId &&
      events.length > 0
    ) {
      autoplaySessionIdRef.current = null
      playback.play()
    }
  }, [events, selectedId, playback])

  // Caches the last cursor so an ordinary playback tick (time moving forward
  // by a few ticks' worth of events) folds only the events it crossed rather
  // than the whole prefix (#160 layer 2). A scrub backward, or a new
  // `sessionIndex` entirely, falls back to the nearest keyframe inside
  // `foldFrom` — never a stale cursor from a previous session, since the
  // cache is keyed on `sessionIndex`'s own identity.
  const cursorCacheRef = useRef<{ index: SessionIndex; cursor: FoldCursor } | null>(null)

  const { eventsAtScrubTime, state } = useMemo(() => {
    const cached = cursorCacheRef.current
    const from = cached !== null && cached.index === sessionIndex ? cached.cursor : initialFoldCursor()
    const cursor = foldFrom(sessionIndex, playback.currentTs, from)
    cursorCacheRef.current = { index: sessionIndex, cursor }
    return {
      eventsAtScrubTime: sessionIndex.events.slice(0, cursor.index),
      state: cursor.state,
    }
  }, [sessionIndex, playback.currentTs])
  const isReplaying = selectedId !== null && events.length > 0

  return {
    sessions,
    selectedId,
    selectSession,
    selectAndPlay,
    events,
    error,
    playback,
    range,
    eventsAtScrubTime,
    state,
    isReplaying,
  }
}

/** A replay slot with nothing selected — what `ModeContext` serves outside a `ModeProvider`. */
export function emptyReplaySession(): ReplaySession {
  const noop = () => {}
  return {
    sessions: [],
    selectedId: null,
    selectSession: noop,
    selectAndPlay: noop,
    events: [],
    error: null,
    playback: {
      currentTs: 0,
      playing: false,
      speed: 1,
      play: noop,
      pause: noop,
      setSpeed: noop,
      seek: noop,
      reset: noop,
    },
    range: { start: 0, end: 0 },
    eventsAtScrubTime: [],
    state: initialSessionState(),
    isReplaying: false,
  }
}
