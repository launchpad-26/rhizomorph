import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  initialSessionState,
  voiceUnknownEvents,
  type RhizomorphEvent,
  type SessionState,
  type UnknownEventLine,
} from '@rhizomorph/core'
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
  /**
   * Re-reads `GET /api/sessions`. The listing is otherwise fetched once per
   * mount, which was true enough while recordings only ever appeared between
   * page loads — prd16 ruling 2 changed that: rotating closes a session *now*,
   * and the operator must find it in the picker immediately, not after a
   * reload. Called by the rotate button and nothing else.
   */
  refreshSessions(): void
  selectedId: string | null
  selectSession(id: string | null): void
  /** Selects a session and starts playback as soon as its events finish loading. */
  selectAndPlay(id: string): void
  /** Raw log for the selected session, fetched in full up front. */
  events: RhizomorphEvent[]
  /**
   * Events in the selected session that this bundle counted but could not fold
   * — prd17 ruling 3, item 1. Empty for a recording entirely from this era.
   *
   * Carried beside `events` rather than folded into `state`, because there is no
   * `RhizomorphEvent` to fold: an unknown is a preserved line, and inventing a
   * state change for it would be the guess the ruling forbids. Every replay
   * surface that voices the gap reads it from here.
   */
  unknown: UnknownEventLine[]
  /**
   * The ruling's own sentence over {@link unknown}, or `null` when there is
   * nothing to say. Computed once here so the banner and the session listing
   * cannot tell two different stories about one recording.
   */
  unknownVoice: string | null
  error: string | null
  playback: UsePlaybackResult
  range: TimeRange
  /**
   * The full sorted event log — stable identity across ticks, changing only
   * when a new session loads. Consumers that need the scrub prefix slice it
   * themselves from `scrubEventCount` rather than being handed a fresh array
   * every tick: a per-tick slice's fresh identity was what made `StreamContext`
   * refold its whole prefix from scratch on every scrub, twice over (#160,
   * #162) — the slice itself was never the expensive part.
   */
  scrubEvents: readonly RhizomorphEvent[]
  /** Count of `scrubEvents` at or before the scrub time. */
  scrubEventCount: number
  /** State at the scrub time, folded through the core reducer — the replay controls' own summary. */
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
  const [unknown, setUnknown] = useState<UnknownEventLine[]>([])
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

  /** Bumped to re-run the listing fetch below — see `refreshSessions`. */
  const [listingGeneration, setListingGeneration] = useState(0)
  const refreshSessions = useCallback(() => {
    setListingGeneration((generation) => generation + 1)
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
  }, [fetchImpl, listingGeneration])

  useEffect(() => {
    if (selectedId === null) {
      setEvents([])
      setUnknown([])
      return
    }
    let cancelled = false
    fetchSessionEvents(selectedId, fetchImpl)
      .then((loaded) => {
        if (cancelled) return
        setEvents(loaded.events)
        setUnknown(loaded.unknown)
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

  const { scrubEventCount, state } = useMemo(() => {
    const cached = cursorCacheRef.current
    const from = cached !== null && cached.index === sessionIndex ? cached.cursor : initialFoldCursor()
    const cursor = foldFrom(sessionIndex, playback.currentTs, from)
    cursorCacheRef.current = { index: sessionIndex, cursor }
    return {
      scrubEventCount: cursor.index,
      state: cursor.state,
    }
  }, [sessionIndex, playback.currentTs])
  const isReplaying = selectedId !== null && events.length > 0
  const unknownVoice = useMemo(() => voiceUnknownEvents(unknown), [unknown])

  return {
    sessions,
    refreshSessions,
    selectedId,
    selectSession,
    selectAndPlay,
    events,
    unknown,
    unknownVoice,
    error,
    playback,
    range,
    scrubEvents: sessionIndex.events,
    scrubEventCount,
    state,
    isReplaying,
  }
}

/** A replay slot with nothing selected — what `ModeContext` serves outside a `ModeProvider`. */
export function emptyReplaySession(): ReplaySession {
  const noop = () => {}
  return {
    sessions: [],
    refreshSessions: noop,
    selectedId: null,
    selectSession: noop,
    selectAndPlay: noop,
    events: [],
    unknown: [],
    unknownVoice: null,
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
    scrubEvents: [],
    scrubEventCount: 0,
    state: initialSessionState(),
    isReplaying: false,
  }
}
