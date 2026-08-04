import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createEventFactory } from '@rhizomorph/core'
import { ModeProvider, useReplay } from '../app/ModeContext.js'
import { StreamProvider } from '../app/StreamContext.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import type { FetchLike as ReplayFetchLike } from '../replay/api.js'
import { FLEET_TICK_MS, FleetProvider, useFleet } from './FleetContext.js'
import { fixtureHistory, fleet20Spec, pathologySpec } from './fixtures.js'
import type { FetchLike } from './manifest.js'

afterEach(cleanup)

/**
 * The provider chain end to end: a source, folded by one reducer, read by one
 * derived object. Nothing here mocks `buildFleet` — the point is that the fleet
 * a surface will actually receive is the one the detectors produced.
 */

/** Pinned, so the fixtures and the derived fleet never move under the test. */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

/**
 * `StreamProvider` builds each fixture's history the first time a test presses
 * its key, which is also the moment vitest's per-test timeout clock is
 * running. Warming `fixtures.ts`'s memo here — same spec singleton, same
 * `now`, same default seed the provider uses — moves that one-time ~8,000-event
 * build into setup, so no single test pays for it under load.
 */
beforeAll(() => {
  fixtureHistory(fleet20Spec(), NOW)
  fixtureHistory(pathologySpec(), NOW)
})

class SilentEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

/** A server that has not shipped `/api/lanes` yet (#76) — the wave-1 truth. */
const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

/** A server that has: the manifest the keystone's own dispatch would have written. */
const withLaneManifest: FetchLike = async () => ({
  ok: true,
  json: async () => ({
    lanes: {
      '75-instrument-keystone': {
        handle: '75-instrument-keystone',
        fence: ['packages/web/src/fleet/**'],
        issue: '75',
        model: 'claude-opus-5',
      },
    },
  }),
})

function Probe() {
  const fleet = useFleet()
  return (
    <div>
      <span data-testid="rank">{fleet.rank}</span>
      <span data-testid="lanes">{fleet.lanes.length}</span>
      <span data-testid="manifest">{String(fleet.hasLaneManifest)}</span>
      <span data-testid="gaps">{fleet.gaps.map((gap) => gap.id).join(',')}</span>
      <span data-testid="items">
        {fleet.ladder.rank === 'calm' ? fleet.ladder.evidence.line : fleet.ladder.items.map((item) => item.kind).sort().join(',')}
      </span>
    </div>
  )
}

async function renderChain(fetchLanes: FetchLike) {
  await act(async () => {
    render(
      <StreamProvider url="/api/stream" now={NOW} createSource={() => new SilentEventSource()}>
        <FleetProvider now={NOW} fetchLanes={fetchLanes}>
          <Probe />
        </FleetProvider>
      </StreamProvider>,
    )
  })
}

describe('FleetProvider', () => {
  it('derives an empty, calm fleet from a stream that has said nothing', async () => {
    await renderChain(noLaneManifest)

    expect(screen.getByTestId('rank').textContent).toBe('calm')
    expect(screen.getByTestId('lanes').textContent).toBe('0')
    // An empty instrument still speaks in the gap voice rather than reassuring.
    expect(screen.getByTestId('gaps').textContent).toContain('no-lane-manifest')
    expect(screen.getByTestId('gaps').textContent).toContain('no-cost-feed')
  })

  it('takes the lane manifest from the server when it serves one (#76)', async () => {
    await renderChain(withLaneManifest)

    expect(screen.getByTestId('manifest').textContent).toBe('true')
    expect(screen.getByTestId('gaps').textContent).not.toContain('no-lane-manifest')
  })

  it('rebuilds from a fixture source, detectors and all', async () => {
    await renderChain(noLaneManifest)

    await act(async () => {
      fireEvent.keyDown(window, { key: '3' })
    })

    expect(screen.getByTestId('lanes').textContent).toBe('9')
    expect(screen.getByTestId('rank').textContent).toBe('broken')
    // A fixture brings the manifest it was dispatched with, so off-fence is
    // available here even though the server has none.
    expect(screen.getByTestId('manifest').textContent).toBe('true')
    expect(screen.getByTestId('items').textContent).toBe(
      'expensive,frozen,looping,off-fence,waiting',
    )
  })

  it('reads ALL CLEAR with its evidence on the twenty-lane fleet', async () => {
    await renderChain(noLaneManifest)

    await act(async () => {
      fireEvent.keyDown(window, { key: '2' })
    })

    expect(screen.getByTestId('rank').textContent).toBe('calm')
    expect(screen.getByTestId('items').textContent).toBe(
      'collisions: 0 — checked 20 branches / 20 files',
    )
  })
})

// ── the one clock rule (#155) ───────────────────────────────────────────────

/**
 * A recording from long before this test suite runs, so the bug — reading
 * `Date.now()` regardless of mode — has a huge, unmissable ageMs to produce.
 * If `FleetProvider` ever regresses to the wall clock, `lawlane`'s events
 * (all `T0`-relative) would read as years stale no matter what `T0` is, which
 * is exactly why this doesn't need `vi.setSystemTime` to prove the point.
 */
const T0 = Date.UTC(2020, 0, 1)
const LAW_LANE = 'lawlane'
const LAW_LANE_PATH = `/repo-wt/${LAW_LANE}`

/** session.started, a worktree, one burst of work, then a long silence. */
function lawEvents() {
  const f = createEventFactory({ startTs: T0, idPrefix: 'law' })
  f.sessionStarted()
  f.at(T0 + 1_000).worktreeDiscovered({
    path: LAW_LANE_PATH,
    branch: LAW_LANE,
    head: 'sha-0',
    isMain: false,
  })
  f.at(T0 + 5_000).llmUsage({ lane: LAW_LANE, branch: LAW_LANE, worktreePath: LAW_LANE_PATH })
  // Far past the work above by wall time (T0 + 15min) — the tail event that
  // gives the scrubber's range room to seek to any position in between.
  f.at(T0 + 900_000).llmUsage({ lane: LAW_LANE, branch: LAW_LANE, worktreePath: LAW_LANE_PATH })
  return f.all()
}

function lawFetch(): ReplayFetchLike {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessions: [{ id: 'law', fileName: 'law.jsonl', startedAt: T0, sizeBytes: 100 }],
        }),
      } as unknown as Response
    }
    if (href === '/api/sessions/law/events') {
      return { ok: true, status: 200, json: async () => ({ events: lawEvents() }) } as unknown as Response
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as ReplayFetchLike
}

class SilentReplayEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

/** Drives session selection and the scrub position; renders the fleet's read of `lawlane`. */
function ReplayFleetProbe() {
  const { sessions, selectSession, playback } = useReplay()
  const fleet = useFleet()
  const lane = fleet.lanes.find((candidate) => candidate.id === LAW_LANE) ?? null
  const snapshot = {
    fleetNow: fleet.now,
    activity: lane?.activity ?? null,
    rank: lane?.rank ?? null,
    pathologies: lane?.pathologies.map((p) => p.kind).sort() ?? [],
    ageMs: lane?.ageMs ?? null,
    workAgeMs: lane?.workAgeMs ?? null,
  }
  return (
    <div>
      <button onClick={() => selectSession(sessions[0]?.id ?? null)}>select session</button>
      <button onClick={() => playback.seek(T0 + 35_000)}>seek working</button>
      <button onClick={() => playback.seek(T0 + 2_000)}>seek early</button>
      <span data-testid="snapshot">{JSON.stringify(snapshot)}</span>
    </div>
  )
}

/**
 * Fake timers are installed BEFORE mount, so `FleetProvider`'s effect (were it
 * to start a live-mode interval by mistake) registers it as a fake timer from
 * the moment it exists — installing fake timers only after mount would leave
 * an already-running real interval untouched by `vi.advanceTimersByTime` and
 * let a real regression slip past silently.
 */
async function renderReplayFleet() {
  vi.useFakeTimers()
  await act(async () => {
    render(
      <ModeProvider fetchImpl={lawFetch()}>
        <StreamProvider url="/api/stream" createSource={() => new SilentReplayEventSource()}>
          <FleetProvider fetchLanes={noLaneManifest}>
            <ReplayFleetProbe />
          </FleetProvider>
        </StreamProvider>
      </ModeProvider>,
    )
  })
}

describe('the one clock rule (#155)', () => {
  afterEach(() => vi.useRealTimers())

  it('renders a lane WORKING, not flatlined, when scrubbed to a moment it was working', async () => {
    await renderReplayFleet()

    await act(async () => {
      fireEvent.click(screen.getByText('select session'))
    })
    act(() => {
      fireEvent.click(screen.getByText('seek working'))
    })

    const snapshot = JSON.parse(screen.getByTestId('snapshot').textContent ?? '{}')
    // The exact reported bug: judged against the real wall clock, this lane's
    // T0-relative events are years stale, so it would read FROZEN/idle
    // instead. Judged against the scrub position (T0 + 35s, 30s after the
    // work event), it reads working with nothing wrong.
    expect(snapshot.fleetNow).toBe(T0 + 35_000)
    expect(snapshot.activity).toBe('working')
    expect(snapshot.pathologies).toEqual([])
    expect(snapshot.rank).toBe('calm')
  })

  it('gives identical fleet output scrubbing back to a position it already visited, even as real time passes', async () => {
    await renderReplayFleet()

    await act(async () => {
      fireEvent.click(screen.getByText('select session'))
    })
    act(() => {
      fireEvent.click(screen.getByText('seek working'))
    })
    const before = screen.getByTestId('snapshot').textContent

    // Real time passing between the two visits to the same scrub position is
    // exactly what would leak a wall clock into the reading, if there were one.
    act(() => {
      vi.advanceTimersByTime(5 * FLEET_TICK_MS)
    })
    act(() => {
      fireEvent.click(screen.getByText('seek early'))
    })
    expect(screen.getByTestId('snapshot').textContent).not.toBe(before)

    act(() => {
      vi.advanceTimersByTime(5 * FLEET_TICK_MS)
    })
    act(() => {
      fireEvent.click(screen.getByText('seek working'))
    })
    // No wall-clock leakage: the exact same scrub position must derive the
    // exact same fleet, regardless of what real time it is or which other
    // positions were visited in between.
    expect(screen.getByTestId('snapshot').textContent).toBe(before)
  })

  it('does not change its derived state over real time while paused', async () => {
    await renderReplayFleet()

    await act(async () => {
      fireEvent.click(screen.getByText('select session'))
    })
    act(() => {
      fireEvent.click(screen.getByText('seek working'))
    })
    const before = screen.getByTestId('snapshot').textContent

    act(() => {
      // Several times FleetProvider's own live-mode tick interval — proof
      // that no timer of any kind is moving this reading while replaying.
      vi.advanceTimersByTime(5 * FLEET_TICK_MS)
    })

    expect(screen.getByTestId('snapshot').textContent).toBe(before)
  })
})
