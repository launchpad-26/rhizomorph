import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { LaneManifest } from '../fleet/fences.js'
import {
  FIXTURE_TICK_MS,
  SyntheticFleet,
  manifestFor,
  specFor,
  type FixtureId,
} from '../fleet/fixtures.js'
import type { ConnectionStatus, EventSourceFactory } from '../hooks/useEventStream.js'
import { useEventStream } from '../hooks/useEventStream.js'
import { useMode, useReplay } from './ModeContext.js'
import {
  NEWS_GRACE_MS,
  eventsWindowLabel,
  foldStreamEvents,
  initialStreamState,
  replayStreamState,
  type StreamState,
} from './streamState.js'

/**
 * The one stream every surface reads, whichever log is driving it.
 *
 * Three sources, **one reducer**: the live SSE connection, a twenty-lane
 * synthetic fleet, and the staged-pathology fleet (keys 1 / 2 / 3). A fixture
 * is not a mock of the dashboard — it is a different event log folded by the
 * same `foldStreamEvents`, read by the same selectors and diagnosed by the same
 * detectors. That is what makes "the detectors found the looping lane" a claim
 * about the code rather than about the fixture.
 *
 * Replay is the fourth source and works the same way (architecture.md: live and
 * replay are the same reducer), which is why "return to live" is just the mode
 * flipping back — the live connection below keeps folding the whole time.
 */

export type StreamSource = FixtureId

export const STREAM_SOURCE_KEYS: Record<string, StreamSource> = {
  '1': 'live',
  '2': 'fleet20',
  '3': 'pathology',
}

export interface StreamContextValue {
  state: StreamState
  status: ConnectionStatus
  /** Which log is driving. `live` unless a fixture key was pressed. */
  source: StreamSource
  setSource: (source: StreamSource) => void
  /**
   * A fixture knows what it dispatched, so it carries its own lane manifest.
   * Live has none here: it comes from `/api/lanes` (#76), and its absence is a
   * named gap rather than an inference.
   */
  fixtureManifest: LaneManifest | null
  /** Shown in the provenance bar — a fixture must never pass as live data. */
  provenance: string
  /**
   * Non-null only once the live event buffer's retention ceiling
   * (`streamState.ts`'s `MAX_EVENTS`) has actually evicted something —
   * `"showing the last N events"`. A surface reading `state.events` directly
   * (never `state.session`, which absorbed every event regardless) must say
   * this rather than let a bounded window pass as the whole session.
   */
  eventsWindowLabel: string | null
}

const StreamContext = createContext<StreamContextValue | null>(null)

/**
 * Replay's fold is the past by definition, so nothing in it is news: the
 * boundary sits beyond any real timestamp rather than at the scrub head. A
 * replayed session builds state and lights nothing (ruling 32's adopted pulse
 * rules); #83 owns what the mode *looks* like.
 *
 * #155 audit: this is the news/history boundary's own clock, and it is
 * already immune to the wall-clock bug that hit `FleetContext` and the
 * ledger — it is a fixed constant, never `Date.now()`, so nothing here reads
 * real time at all regardless of mode.
 */
const REPLAY_CONNECTED_AT = Number.MAX_SAFE_INTEGER

export interface StreamProviderProps {
  url: string
  children: ReactNode
  /** Test-only escape hatch for injecting a mock SSE source. */
  createSource?: EventSourceFactory
  /**
   * Test-only clock. Pinning it also pins the fixtures: a fixture generated
   * from a fixed `now` folds to the same fleet twice, and its live tick is
   * switched off entirely so no test races an interval.
   */
  now?: number
}

export function StreamProvider({ url, children, createSource, now }: StreamProviderProps) {
  // #155 audit: wall-clock is correct here. This is the LIVE SSE connection's
  // own news/history boundary — it exists whether or not the app is ever put
  // into replay mode, and when `mode === 'replay'` the value below (`value`,
  // further down) never even reads `live.state`, so this clock cannot leak
  // into a replayed reading.
  const [initialLive] = useState(() => initialStreamState(now ?? Date.now()))
  // #166 proved `foldStreamEvents` (one O(n) batched pass) bit-for-bit
  // identical to folding the same events one at a time through
  // `foldStreamEvent`, but left it unwired: naively coalescing a burst means
  // deferring every fold at least one tick past the synchronous
  // `handleMessage` call, which broke every existing test suite in this
  // package that asserts on state synchronously right after
  // `act(() => source.emit(...))` with nothing awaited. #183 wires it in a
  // way that doesn't require that: `useEventStream.ts` folds a lone arrival
  // eagerly (so a single live tick is still visible the instant its handler
  // returns, exactly as before) and only buffers anything that lands before
  // that fold has actually drained — the shape a burst has, not the shape a
  // live tick has. `reduce` below is `foldStreamEvents`, not
  // `foldStreamEvent`, so a fresh page load's full-session replay (no
  // `Last-Event-ID` yet, #166) and a resumed reconnect's smaller backlog both
  // fold through the same buffer-then-flush path instead of one `setState`
  // per event.
  const live = useEventStream(url, {
    initialState: initialLive,
    reduce: foldStreamEvents,
    createSource,
  })

  const [source, setSource] = useState<StreamSource>('live')
  const fixture = useFixtureStream(source, now)

  useFixtureKeys(setSource)

  const mode = useMode()
  const replay = useReplay()
  // #162: this used to be `foldStreamEvents(initial, replay.eventsAtScrubTime)`
  // — a full refold from scratch every scrub tick, because `eventsAtScrubTime`
  // was a fresh `.slice()` with a new identity every tick, so this memo never
  // hit. `replay.state` is already replay's own incrementally-folded session
  // (#160's `foldFrom`, never redone here), and `replayStreamState` composes
  // the rest — the events slice and the news/history split — without a fold.
  const replayState = useMemo(
    () => replayStreamState(replay.scrubEvents, replay.scrubEventCount, replay.state, REPLAY_CONNECTED_AT),
    [replay.scrubEvents, replay.scrubEventCount, replay.state],
  )

  const value = useMemo<StreamContextValue>(() => {
    if (mode === 'replay') {
      return {
        state: replayState,
        status: 'open',
        source,
        setSource,
        fixtureManifest: null,
        provenance: 'replay · recorded session',
        eventsWindowLabel: eventsWindowLabel(replayState),
      }
    }
    if (source !== 'live' && fixture !== null) {
      return {
        state: fixture.state,
        status: 'open',
        source,
        setSource,
        fixtureManifest: fixture.manifest,
        provenance: fixture.provenance,
        eventsWindowLabel: eventsWindowLabel(fixture.state),
      }
    }
    return {
      state: live.state,
      status: live.status,
      source,
      setSource,
      fixtureManifest: null,
      // This branch also carries the one render between a fixture keypress and
      // its effect populating `fixture` — provenance must come from the spec,
      // not the live template, or that frame pairs source='fleet20' with a
      // string that begins "live" (prd-19 ruling 6, found by PR #282's review).
      provenance: source === 'live' ? `live · ${url}` : specFor(source).provenance,
      eventsWindowLabel: eventsWindowLabel(live.state),
    }
  }, [mode, replayState, source, fixture, live.state, live.status, url])

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>
}

export function useStream(): StreamContextValue {
  const value = useContext(StreamContext)
  if (value === null) {
    throw new Error('useStream must be used within a StreamProvider')
  }
  return value
}

interface FixtureStream {
  state: StreamState
  manifest: LaneManifest
  provenance: string
}

/**
 * A synthetic fleet, folded exactly like the live stream: its history arrives
 * as history (so it builds state and lights nothing) and its tick arrives as
 * news (so the scene has real events to move on).
 *
 * #155 audit: the `Date.now()` calls below (and the generator's own tick
 * timer) are correct as wall-clock. A fixture only ever drives `source`
 * (keys 1/2/3), and `StreamProvider`'s `value` always prefers the replay
 * fold whenever `mode === 'replay'` — a fixture cannot be "in replay", so
 * there is no scrub position for this clock to disagree with.
 */
function useFixtureStream(
  source: StreamSource,
  nowOverride: number | undefined,
): FixtureStream | null {
  const [stream, setStream] = useState<FixtureStream | null>(null)

  useEffect(() => {
    if (source === 'live') {
      setStream(null)
      return
    }

    const spec = specFor(source)
    const now = nowOverride ?? Date.now()
    const generator = new SyntheticFleet(spec)
    const manifest = manifestFor(spec)

    // The boundary sits one grace window ahead of the fixture's own `now`, so
    // every event the generator wrote *as history* is history — including the
    // two-second-old tail that a live connection would rightly have called
    // news. A fixture declares its whole past to be past; only its tick, which
    // happens later by the wall clock, is news.
    let current = foldStreamEvents(
      initialStreamState(now + NEWS_GRACE_MS),
      generator.history(now),
    )
    setStream({ state: current, manifest, provenance: spec.provenance })

    // A pinned clock means a test asked for a still image; a ticking generator
    // would make every assertion below it a race against an interval.
    if (nowOverride !== undefined) return

    const timer = setInterval(() => {
      const events = generator.tick(Date.now())
      if (events.length === 0) return
      current = foldStreamEvents(current, events)
      setStream({ state: current, manifest, provenance: spec.provenance })
    }, FIXTURE_TICK_MS)

    return () => clearInterval(timer)
  }, [source, nowOverride])

  return stream
}

/**
 * Keys 1 / 2 / 3 switch the driving log. Ignored while the operator is typing
 * or holding a modifier — a page whose number keys hijack a text field is a
 * page nobody can file a bug from.
 */
function useFixtureKeys(setSource: (source: StreamSource) => void): void {
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      if (isTypingTarget(event.target)) return
      const next = STREAM_SOURCE_KEYS[event.key]
      if (next !== undefined) setSource(next)
    },
    [setSource],
  )

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
