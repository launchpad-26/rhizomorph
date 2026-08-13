import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
   * The full `ts`-sorted event log — a navigation view (#205), stable
   * identity across ticks, changing only when a new session loads.
   * Consumers that need the scrub prefix slice it themselves from
   * `scrubEventCount` rather than being handed a fresh array every tick: a
   * per-tick slice's fresh identity was what made `StreamContext` refold its
   * whole prefix from scratch on every scrub, twice over (#160, #162) — the
   * slice itself was never the expensive part. `state` below is folded
   * separately, in the session's own append order — this array exists so a
   * `ts`-ascending binary search (`StreamContext`'s news/history boundary)
   * has something to search, never to decide fold order.
   */
  scrubEvents: readonly RhizomorphEvent[]
  /** Count of `scrubEvents` at or before the scrub time. */
  scrubEventCount: number
  /**
   * The scrub position everything *derived* is standing at — the same instant
   * {@link state} was folded to, which is `playback.currentTs` coalesced to at
   * most one move per animation frame (#269).
   *
   * Two clocks, on purpose, and the split is the whole fix: `currentTs` is the
   * finger (the scrubber thumb is a controlled input reading it, so it can
   * never wait for anything), while this one is the derive. A pointer drag
   * emits ~120 seeks a second and the screen can show 60, so what pays for a
   * rebuild reads THIS — `FleetContext`'s `buildFleet`, through `ModeContext`'s
   * `useModeClock`, and the scene's `asOf`, which is read as a distance from
   * `fleet.now` and so has to agree with it rather than be fresher than it.
   * What merely paints the position it was handed reads `currentTs` and stays
   * exact to the pointer: the thumb, the elapsed labels beside it, the TIDE
   * playhead.
   *
   * Never more than one frame behind `currentTs`, and equal to it whenever the
   * scrub is at rest — a paused scrub, a lone click on the track or an arrow
   * key folds immediately, so nothing an operator does one action at a time
   * ever observes the two apart.
   */
  derivedTs: number
  /** State at the scrub time, folded through the core reducer — the replay controls' own summary. */
  state: SessionState
  isReplaying: boolean
}

/**
 * Schedules `callback` for the next animation frame and hands back its own
 * canceller. The seam exists because jsdom has a `requestAnimationFrame` but
 * no frame cadence — it fires on a ~16 ms timer that no `await act()` drives —
 * so a coalescer asserted against "whenever jsdom's timer happened to land"
 * would be asserting the box, not the code (`CONTRIBUTING.md`'s note on
 * quiet-machine greens). Tests inject a scheduler they flush by hand.
 */
export type FrameScheduler = (callback: () => void) => () => void

const defaultScheduleFrame: FrameScheduler = (callback) => {
  const handle = requestAnimationFrame(callback)
  return () => cancelAnimationFrame(handle)
}

export interface UseReplaySessionOptions {
  /** Test-only escape hatch for injecting a mock fetch implementation. */
  fetchImpl?: FetchLike
  /**
   * Injectable frame scheduler for {@link useFrameCoalescedTs}. Defaults to
   * `requestAnimationFrame`; a test passes a hand-driven one so "one derive
   * per frame" is a counted fact rather than a timing hope.
   */
  scheduleFrame?: FrameScheduler
}

/**
 * Owns session selection, history fetch and the scrubber clock — the single
 * source of replay truth that `ModeContext` serves to both the replay
 * controls and `StreamContext`, so panels and the transport never disagree
 * about "now" (architecture.md, "live and replay are the same reducer").
 */
export function useReplaySession({
  fetchImpl,
  scheduleFrame = defaultScheduleFrame,
}: UseReplaySessionOptions = {}): ReplaySession {
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

  // Navigation index built and keyframed once per session load (#160) —
  // everything a scrub does afterwards is O(log n) plus the events actually
  // crossed, and every one of those is folded in the record's own append
  // order, never a ts-sorted one (#205).
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

  // #269: the clock and the derive are decoupled here. `playback.currentTs`
  // moves on every scrubber `onChange` — up to ~120/s from a pointer drag, and
  // the thumb reads it directly, so it must never wait for anything. The fold
  // below (and every identity downstream of it: `state`, `StreamContext`'s
  // `replayState`, `FleetContext`'s `buildFleet`) moves at most once per
  // animation frame instead.
  const foldTs = useFrameCoalescedTs(
    playback.currentTs,
    sessionIndex,
    scheduleFrame,
    sessionIndex.sortedEvents.length > 0,
  )

  const { scrubEventCount, state } = useMemo(() => {
    const cached = cursorCacheRef.current
    const from = cached !== null && cached.index === sessionIndex ? cached.cursor : initialFoldCursor()
    const cursor = foldFrom(sessionIndex, foldTs, from)
    cursorCacheRef.current = { index: sessionIndex, cursor }
    return {
      scrubEventCount: cursor.index,
      state: cursor.state,
    }
  }, [sessionIndex, foldTs])
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
    scrubEvents: sessionIndex.sortedEvents,
    scrubEventCount,
    derivedTs: foldTs,
    state,
    isReplaying,
  }
}

/**
 * A scrub position that lands on the derive at most once per animation frame,
 * while the caller's own `currentTs` keeps moving synchronously (#269).
 *
 * The live path solved the same problem for arriving events in #183: fold the
 * lone one eagerly, coalesce anything that lands before that fold has drained.
 * This is that shape with a frame, not a microtask, as the window — a drag
 * emits a seek per pointer event (~120/s) and the screen can only show 60:
 *
 * - **A seek with the gate open folds immediately.** A click on the track, an
 *   arrow key, a jump from a chapter marker — one seek in isolation is visible
 *   the instant its handler returns, exactly as it always was. Nothing about
 *   an isolated interaction pays for the coalescer.
 * - **That fold consumes the frame.** Every further seek before the next frame
 *   only updates the pending position; no fold, no new `state` identity, no
 *   rebuild downstream. The eager fold *is* the frame's fold rather than an
 *   extra one on top of a trailing flush, which is what makes the ceiling
 *   exactly one derive per frame rather than two.
 * - **The frame flushes the last pending position and re-arms**, so a
 *   sustained drag settles into precisely one derive per frame, and the frame
 *   after a drag ends finds nothing pending, updates no state at all, and
 *   stops scheduling.
 *
 * `resetKey` (the session index) is not a seek: a newly loaded recording
 * reopens the gate AND makes its first fold free of the frame budget, so both
 * that fold and the operator's first seek into the recording land on the frame
 * they happen. A session load is a one-off — nothing follows it 119 more times
 * in the same second — and spending the budget on it would leave the first
 * seek after every load waiting a frame for no reason. A drag's seeks never
 * carry that exemption, so the one-derive-per-frame ceiling is untouched.
 *
 * **The exemption expires with the frame the reset armed** (#364), and that
 * bound is what keeps the sentence above true. The exemption is owed to a
 * *load fold*, which arrives in the commit right after the reset and so is
 * still inside that frame. But some switches owe no load fold at all — the
 * transport's re-base is keyed on `[start, end]`, so two recordings spanning an
 * identical range never move `currentTs`, and a switch mid-drag has already had
 * its position adopted by the reset. Unbounded, the exemption would survive
 * those switches and be spent on the operator's first seek instead: that seek
 * would fold with the gate left open, and a second seek in the same frame would
 * fold again — two derives in one frame, against a ceiling this comment states
 * as an invariant. Expiring it on the reset's own frame spends it on a load
 * fold or on nothing.
 *
 * The reset also *adopts* the current position rather than only dropping the
 * pending one, and that is load-bearing rather than tidy: switching recordings
 * mid-drag leaves a seek coalesced with a frame armed to fold it, and the reset
 * cancels that frame. Usually the transport's own reset-on-new-range effect
 * re-bases `currentTs` a commit later and the free fold lands on the new
 * recording's position — but that effect is keyed on `[start, end]`, so two
 * recordings spanning the identical range never re-base at all, and the seek
 * the operator's finger last asked for would stay unfolded until they touched
 * the scrubber again: a thumb sitting at one instant while the fleet reads
 * another. Adopting `currentTs` here costs a derive only when a switch really
 * did interrupt a drag (otherwise the two are already equal and React bails on
 * the update), and it spends no exemption, so the first seek into the new
 * recording is still instant.
 *
 * It runs as a layout effect for the ordering, not for the paint: a real
 * animation frame can fire between a commit and React's passive-effect flush,
 * and this must have re-based the gate before any flush belonging to the
 * previous recording gets to run against the new one's index.
 */
function useFrameCoalescedTs(
  currentTs: number,
  resetKey: unknown,
  scheduleFrame: FrameScheduler,
  hasRecording: boolean,
): number {
  const [foldTs, setFoldTs] = useState(currentTs)
  /** False once this frame's one derive has been spent. */
  const gateOpenRef = useRef(true)
  /** The latest seek that has not been folded yet, or null when there is none. */
  const pendingTsRef = useRef<number | null>(null)
  const cancelFrameRef = useRef<(() => void) | null>(null)
  /** True while the first fold of a freshly loaded recording is still owed. */
  const freeFoldRef = useRef(true)
  const scheduleFrameRef = useRef(scheduleFrame)
  scheduleFrameRef.current = scheduleFrame
  /**
   * Whether there is a recording to fold at all. Read through a ref so it does
   * not join the reset's deps: it is derived from `resetKey`, so listing it
   * would be a second name for the same change.
   */
  const hasRecordingRef = useRef(hasRecording)
  hasRecordingRef.current = hasRecording

  const armFrame = useCallback(() => {
    cancelFrameRef.current?.()
    cancelFrameRef.current = scheduleFrameRef.current(() => {
      cancelFrameRef.current = null
      gateOpenRef.current = true
      // The exemption never outlives the frame it was armed in (#364). A load
      // fold arrives in the commit immediately after the reset, so it is still
      // inside this frame and still free; anything later — an operator's first
      // seek, arriving whole frames afterwards — is an ordinary seek and pays
      // the ordinary budget. Cleared before the early return below, because the
      // frame that ends an unspent exemption is precisely the silent one.
      freeFoldRef.current = false
      const pending = pendingTsRef.current
      // Nothing coalesced: the burst is over. Deliberately no state update —
      // an idle frame must be silent, or every render of a replay surface
      // would be woken once more for nothing.
      if (pending === null) return
      pendingTsRef.current = null
      gateOpenRef.current = false
      setFoldTs(pending)
      armFrame()
    })
  }, [])

  useLayoutEffect(() => {
    cancelFrameRef.current?.()
    cancelFrameRef.current = null
    gateOpenRef.current = true
    pendingTsRef.current = null
    freeFoldRef.current = true
    // Adopt, don't just drop: whatever the finger last asked for is where this
    // recording starts being read from. A no-op (and no re-render) unless a
    // switch interrupted a drag.
    setFoldTs(currentTs)
    // Arm the frame that will expire the exemption if no load fold claims it
    // (#364). Silent when it fires — nothing is pending — so this costs one
    // scheduled callback per session switch and no render. Without it, a switch
    // that owes no fold leaves the exemption alive indefinitely, and the
    // operator's first seek spends it instead: that seek folds with the gate
    // left open, so a second seek in the same frame folds again, which is one
    // more derive than the ceiling this hook documents.
    //
    // Only with a recording loaded. An empty index has nothing to fold and so
    // nothing to exempt, and an instrument sitting in live mode should schedule
    // no frames on replay's account at all — `SceneView.test.tsx` asserts
    // exactly that about the mounted tree, and it is right to.
    if (hasRecordingRef.current) armFrame()
    // `currentTs` is deliberately absent from the deps below: this fires when
    // the recording changes and reads the position as of that moment.
  }, [resetKey, armFrame])

  useEffect(() => {
    if (currentTs === foldTs) {
      pendingTsRef.current = null
      return
    }
    if (!gateOpenRef.current) {
      pendingTsRef.current = currentTs
      // Insurance, not a fix for anything observed: the gate is shut and no
      // frame is coming to open it, which can only mean an armed one was
      // cancelled by a remount (a keyed parent, a Fast Refresh — StrictMode's
      // own double-mount arrives before anything is ever armed). Arming again
      // costs nothing — `armFrame` cancels whatever it replaces — and the
      // failure it rules out is a scrub position stranded until the next seek.
      if (cancelFrameRef.current === null) armFrame()
      return
    }
    pendingTsRef.current = null
    if (freeFoldRef.current) {
      // The first derive of a freshly loaded recording, budget-free: the gate
      // stays open, so the operator's first seek into it is still instant.
      freeFoldRef.current = false
      setFoldTs(currentTs)
      return
    }
    gateOpenRef.current = false
    setFoldTs(currentTs)
    armFrame()
  }, [currentTs, foldTs, armFrame])

  useEffect(
    () => () => {
      cancelFrameRef.current?.()
      cancelFrameRef.current = null
    },
    [],
  )

  return foldTs
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
    derivedTs: 0,
    state: initialSessionState(),
    isReplaying: false,
  }
}
