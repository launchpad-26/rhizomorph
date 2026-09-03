import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildFleet,
  createEvent,
  createEventFactory,
  fixtureHistory,
  fleet20Spec,
  initialSessionState,
  pathologySpec,
  reduce,
  reduceAll,
} from '@rhizomorph/core'
import { ModeProvider, useReplay } from '../app/ModeContext.js'
import { StreamProvider } from '../app/StreamContext.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import type { FetchLike as ReplayFetchLike } from '../replay/api.js'
import { FLEET_INPUT_SLICES, FLEET_TICK_MS, FleetProvider, useFleet } from './FleetContext.js'
import Scene from '../scene/index.js'
import { SelectionProvider } from './selection.js'
import { LANES_URL, type FetchLike } from './manifest.js'

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

// ── the repo boundary reaches the lane manifest (#390 review) ───────────────

/**
 * The fold resets on a session boundary (`core`'s `opensNewSession`, which a
 * repo change is one case of), but the lane manifest never went *through* the
 * fold, so resetting the fold cannot reach it. `/api/lanes` used to be fetched
 * once for the life of the page — its effect could only re-run on `enabled`
 * (`source === 'live'`, unchanged by a retarget) or `fetchImpl` (a stable
 * prop) — which left repo B's freshly-reset lanes fenced by repo A's manifest.
 *
 * Same class as #370: state beside the fold has to be invalidated whenever the
 * thing it describes changes, or the two drift apart while each looks correct.
 * The key here is the REPO, deliberately narrower than the fold's own reset
 * since #592 widened that to every rotation: `/api/lanes` describes the repo's
 * workmux lanes, not the recording, so a rotation gives it nothing to re-read
 * (`foldedRepoPath` in `app/streamState.ts` says the same from its end).
 */
class EmittingEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
  }

  close() {}
}

/** A manifest naming one lane, so `hasLaneManifest` reads true when it applies. */
const laneManifestBody = {
  lanes: {
    'dev-1': { handle: 'dev-1', fence: ['packages/web/**'], issue: '1', model: 'claude-opus-5' },
  },
}

/**
 * Serves a different body per call and records every request, so a test can
 * say both *that* the manifest was re-asked and *what* the answer became.
 * The last body repeats if the calls outrun it.
 */
function countingLanes(bodies: readonly (object | null)[]) {
  const calls: string[] = []
  const impl: FetchLike = async (input) => {
    const body = bodies[Math.min(calls.length, bodies.length - 1)] ?? null
    calls.push(input)
    return { ok: body !== null, json: async () => body }
  }
  return { impl, calls }
}

let boundaryEventId = 0
function startedFor(repo: string, sessionId: string) {
  boundaryEventId += 1
  return createEvent(
    'session.started',
    { sessionId, repoPath: `/repos/${repo}`, repoName: repo, mainBranch: 'main' },
    { id: `boundary-${boundaryEventId}`, ts: NOW },
  )
}

async function renderBoundaryChain(fetchLanes: FetchLike) {
  let source: EmittingEventSource | undefined
  await act(async () => {
    render(
      <StreamProvider
        url="/api/stream"
        now={NOW}
        createSource={() => {
          source = new EmittingEventSource()
          return source
        }}
      >
        <FleetProvider now={NOW} fetchLanes={fetchLanes}>
          <Probe />
        </FleetProvider>
      </StreamProvider>,
    )
  })
  return { getSource: () => source as EmittingEventSource }
}

describe('the lane manifest across a repo boundary (#390 review)', () => {
  it('re-asks /api/lanes when session.started names a different repo, and drops the old answer', async () => {
    // Boot asks with no repo named yet; repo A asks again; repo B asks a
    // third time and this server has no manifest for it.
    const lanes = countingLanes([laneManifestBody, laneManifestBody, null])
    const { getSource } = await renderBoundaryChain(lanes.impl)

    await act(async () => {
      getSource().emit(startedFor('alpha', 's-alpha'))
    })
    expect(screen.getByTestId('manifest').textContent).toBe('true')
    expect(lanes.calls).toEqual([LANES_URL, LANES_URL])

    // The retarget. Repo A's manifest must not survive it.
    await act(async () => {
      getSource().emit(startedFor('beta', 's-beta'))
    })

    expect(lanes.calls).toHaveLength(3)
    expect(lanes.calls.every((url) => url === LANES_URL)).toBe(true)
    // The load-bearing assertion: repo B is not fenced by repo A's manifest.
    // Before this fix the answer stayed `true` — repo A's lanes, fencing
    // repo B's fleet, with nothing on screen to say so.
    expect(screen.getByTestId('manifest').textContent).toBe('false')
    expect(screen.getByTestId('gaps').textContent).toContain('no-lane-manifest')
  })

  it('does NOT re-ask for an ordinary rotation over the same repo', async () => {
    // The other half of the rule, and the one an over-eager dep would break:
    // a rotation changes `sessionId`, never `repoPath`, so the manifest the
    // server already served still describes this repo.
    const lanes = countingLanes([laneManifestBody])
    const { getSource } = await renderBoundaryChain(lanes.impl)

    await act(async () => {
      getSource().emit(startedFor('alpha', 's-alpha-1'))
    })
    const afterFirstRepo = lanes.calls.length

    await act(async () => {
      getSource().emit(startedFor('alpha', 's-alpha-2'))
    })

    expect(lanes.calls).toHaveLength(afterFirstRepo)
    expect(screen.getByTestId('manifest').textContent).toBe('true')
  })
})

// ── seek coalescing (#269) ──────────────────────────────────────────────────

/**
 * The one number the fix is judged on, end to end: how many times a pointer
 * drag rebuilds the fleet. Still nothing mocked — `buildFleet` returns a fresh
 * object every call, so a rebuild IS a `fleet` identity change, and the probe
 * below counts exactly those.
 *
 * Two deps of this memo move under a drag (`FleetContext`'s `[state.session,
 * clock, manifest]`), and coalescing only one of them buys nothing: the fold's
 * identity settling once per frame while `now` went on changing once per seek
 * would only split what used to be one recompute per seek into two. Measured
 * with a throwaway harness while building this, over an 80-seek drag across 10
 * frames: 79 rebuilds before, 90 with the fold alone coalesced, 11 with both.
 * The assertion below is the part that ships and can be re-run.
 *
 * 2,000 events rather than the 25,000 the issue names because the count
 * asserted here does not depend on the recording's size — only on frames and
 * seeks. `useReplaySession.test.ts` carries the 25,000-event proof of the same
 * ceiling one layer down, where a session that size is affordable.
 */
const DRAG_FRAME_MS = 16

function dragEvents() {
  const f = createEventFactory({ startTs: T0, stepMs: 100, idPrefix: 'drag' })
  const paths = ['/repo-wt/drag-a', '/repo-wt/drag-b', '/repo-wt/drag-c']
  f.sessionStarted()
  for (const path of paths) {
    f.worktreeDiscovered({
      path,
      branch: path.split('/').pop()!,
      head: 'sha-0',
      isMain: path.endsWith('drag-a'),
    })
  }
  for (let i = 0; i < 2_000; i++) {
    const path = paths[i % paths.length]!
    const branch = path.split('/').pop()!
    if (i % 5 === 0) {
      f.commitLanded({ sha: `sha-${i}`, branch, message: `commit ${i}` })
    } else {
      f.worktreeDirty({ path, branch, files: [{ path: `file-${i}.ts`, status: 'modified' }] })
    }
  }
  return f.all()
}

function dragFetch(): ReplayFetchLike {
  const events = dragEvents()
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessions: [{ id: 'drag', fileName: 'drag.jsonl', startedAt: T0, sizeBytes: 100 }],
        }),
      } as unknown as Response
    }
    if (href === '/api/sessions/drag/events') {
      return { ok: true, status: 200, json: async () => ({ events }) } as unknown as Response
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as ReplayFetchLike
}

describe('seek coalescing (#269)', () => {
  afterEach(() => vi.useRealTimers())

  it('rebuilds the fleet at most once per animation frame across a drag, not once per seek', async () => {
    // Installed before mount so the coalescer's `requestAnimationFrame` is a
    // faked one from the moment it exists — a frame here is an advance this
    // test made, never one jsdom's own ~16 ms timer happened to slip in.
    vi.useFakeTimers()

    let replay: ReturnType<typeof useReplay> | null = null
    let lastFleet: unknown = null
    let rebuilds = 0

    function DragProbe() {
      replay = useReplay()
      const fleet = useFleet()
      if (fleet !== lastFleet) {
        lastFleet = fleet
        rebuilds++
      }
      return <span data-testid="drag-lanes">{fleet.lanes.length}</span>
    }

    await act(async () => {
      render(
        <ModeProvider fetchImpl={dragFetch()}>
          <StreamProvider url="/api/stream" createSource={() => new SilentReplayEventSource()}>
            {/* No pinned `now`: the fleet's clock is the scrub position, which
                is the half of this memo the drag actually moves. */}
            <FleetProvider fetchLanes={noLaneManifest}>
              <DragProbe />
            </FleetProvider>
          </StreamProvider>
        </ModeProvider>,
      )
    })
    await act(async () => {
      replay?.selectSession('drag')
    })

    const range = replay!.range
    expect(range.end).toBeGreaterThan(range.start)

    const FRAMES = 8
    const SEEKS_PER_FRAME = 10
    rebuilds = 0

    for (let frame = 0; frame < FRAMES; frame++) {
      for (let i = 0; i < SEEKS_PER_FRAME; i++) {
        const progress = (frame * SEEKS_PER_FRAME + i + 1) / (FRAMES * SEEKS_PER_FRAME)
        act(() => {
          replay?.playback.seek(range.start + progress * (range.end - range.start))
        })
      }
      act(() => {
        vi.advanceTimersByTime(DRAG_FRAME_MS)
      })
    }

    // 80 seeks, 8 frames: one rebuild per frame, plus the drag's single
    // leading edge (the first seek of a burst folds on the spot so a lone
    // click or arrow key never waits for a frame). Uncoalesced, this is 79.
    expect(rebuilds).toBe(FRAMES + 1)
    // And the drag ends where the finger left it, fully folded.
    expect(replay!.derivedTs).toBe(range.end)
    expect(replay!.playback.currentTs).toBe(range.end)
  })
})

// ── the scene reads the fleet's own clock (#269) ────────────────────────────

/**
 * `layout.ts` and `marks/frame.ts` both age a lane by `asOf - fleet.now` — the
 * timeline distance between the snapshot and the moment it is read at. That
 * difference was exactly zero in replay while both numbers came from the raw
 * scrub position. Coalescing `buildFleet`'s clock without coalescing the
 * scene's would open it to a whole frame of *timeline* under a forward drag,
 * which on a long recording is minutes — past `RECENCY_SPAN_MS` — so every
 * lane would grey out as stale mid-drag and the summons pulses would inflate
 * to match. The two clocks have to be one clock; this pins that they are, on
 * every frame of a drag rather than only at rest.
 *
 * It lives here rather than beside the scene because the property under test
 * is `FleetContext`'s clock agreeing with its consumer, and because #269's
 * fence reaches this file.
 */
const sceneFrames = vi.hoisted(() => ({ seen: [] as { asOf?: number; fleetNow: number }[] }))

vi.mock('../scene/SceneView.js', () => ({
  SceneView: ({ asOf, fleet }: { asOf?: number; fleet: { now: number } }) => {
    sceneFrames.seen.push({ asOf, fleetNow: fleet.now })
    return <span data-testid="scene-stub" />
  },
}))

describe('the scene and the fleet share one state clock (#269)', () => {
  afterEach(() => vi.useRealTimers())

  it('hands the scene the exact instant the fleet was built at, on every frame of a drag', async () => {
    vi.useFakeTimers()
    sceneFrames.seen.length = 0

    let replay: ReturnType<typeof useReplay> | null = null

    function Driver() {
      replay = useReplay()
      return null
    }

    await act(async () => {
      render(
        <ModeProvider fetchImpl={dragFetch()}>
          <StreamProvider url="/api/stream" createSource={() => new SilentReplayEventSource()}>
            <FleetProvider fetchLanes={noLaneManifest}>
              <SelectionProvider>
                <Driver />
                <Scene />
              </SelectionProvider>
            </FleetProvider>
          </StreamProvider>
        </ModeProvider>,
      )
    })
    await act(async () => {
      replay?.selectSession('drag')
    })

    const range = replay!.range
    // Live renders (before a session is selected) legitimately pass no `asOf`
    // at all — `SceneView` falls back to its own real clock there. The drag is
    // what is under test.
    sceneFrames.seen.length = 0

    for (let frame = 0; frame < 6; frame++) {
      for (let i = 0; i < 10; i++) {
        const progress = (frame * 10 + i + 1) / 60
        act(() => {
          replay?.playback.seek(range.start + progress * (range.end - range.start))
        })
      }
      act(() => {
        vi.advanceTimersByTime(DRAG_FRAME_MS)
      })
    }

    // Every render the scene made, not just the last: a single frame reading
    // `asOf` ahead of `fleet.now` is one frame of every lane greying out.
    expect(sceneFrames.seen.length).toBeGreaterThan(6)
    const disagreements = sceneFrames.seen.filter((seen) => seen.asOf !== seen.fleetNow)
    expect(disagreements).toEqual([])
    // …and the clock they agree on is a real scrub position rather than
    // `undefined` on both sides, which would satisfy the line above while
    // meaning the replay branch never ran at all.
    expect(sceneFrames.seen.filter((seen) => seen.asOf === undefined)).toEqual([])
    expect(sceneFrames.seen.at(-1)?.asOf).toBe(range.end)
  })
})

// ── the beat (#158) ─────────────────────────────────────────────────────────

/**
 * Ruling 3: the fleet rebuilds on its tick and on the facts `buildFleet`
 * reads, never on `state.session`'s own reference — which `core`'s `reduce`
 * replaces on every event via `withEnvelope`, whatever the event was. Nothing
 * here mocks `buildFleet`: a rebuild IS a `fleet` identity change, the same
 * probe the seek-coalescing test above already proved out (`fleet !==
 * lastFleet` → `rebuilds++`).
 */
async function renderBeatChain(fetchLanes: FetchLike) {
  let source: EmittingEventSource | undefined
  let lastFleet: unknown = null
  let rebuilds = 0

  function BeatProbe() {
    const fleet = useFleet()
    if (fleet !== lastFleet) {
      lastFleet = fleet
      rebuilds++
    }
    return null
  }

  await act(async () => {
    render(
      <StreamProvider
        url="/api/stream"
        now={NOW}
        createSource={() => {
          source = new EmittingEventSource()
          return source
        }}
      >
        <FleetProvider now={NOW} fetchLanes={fetchLanes}>
          <BeatProbe />
        </FleetProvider>
      </StreamProvider>,
    )
  })

  return {
    getSource: () => source as EmittingEventSource,
    rebuilds: () => rebuilds,
    fleet: () => lastFleet,
  }
}

describe('the beat (#158)', () => {
  it('does not rebuild on an event buildFleet cannot read — the falsifier (success 4)', async () => {
    const chain = await renderBeatChain(noLaneManifest)
    const f = createEventFactory({ startTs: NOW, idPrefix: 'beat-1' })
    const rebuildsBefore = chain.rebuilds()
    const fleetBefore = chain.fleet()

    await act(async () => {
      chain.getSource().emit(f.judgeFinding())
    })

    expect(chain.rebuilds()).toBe(rebuildsBefore)
    // The stronger half: not just "the same count" but the exact same object,
    // which is what a silently-broken rebuild counter could not fake.
    expect(chain.fleet()).toBe(fleetBefore)
  })

  it('stays put across a run of events buildFleet cannot read (repetition)', async () => {
    const chain = await renderBeatChain(noLaneManifest)
    const f = createEventFactory({ startTs: NOW, idPrefix: 'beat-2' })
    const rebuildsBefore = chain.rebuilds()

    // `session.closed` is the purest case: `applyEvent` returns `state`
    // unchanged and only `withEnvelope` moved the reference.
    for (const event of [
      f.judgeFinding(),
      f.forkDispatched(),
      f.forkCheckpoint(),
      f.sessionClosed(),
      f.judgeFinding(),
    ]) {
      await act(async () => {
        chain.getSource().emit(event)
      })
      expect(chain.rebuilds()).toBe(rebuildsBefore)
    }
  })

  it('DOES rebuild on an event buildFleet reads — the positive control', async () => {
    // Without this, the falsifier and the repetition test above would pass on
    // a hook that never rebuilds anything at all.
    const chain = await renderBeatChain(noLaneManifest)
    const f = createEventFactory({ startTs: NOW, idPrefix: 'beat-3' })
    const rebuildsBefore = chain.rebuilds()

    await act(async () => {
      chain.getSource().emit(f.worktreeDirty({ path: '/repo-wt/beat-3' }))
    })
    expect(chain.rebuilds()).toBe(rebuildsBefore + 1)

    await act(async () => {
      chain.getSource().emit(f.llmUsage())
    })
    expect(chain.rebuilds()).toBe(rebuildsBefore + 2)

    await act(async () => {
      chain.getSource().emit(f.judgeFinding())
    })
    expect(chain.rebuilds()).toBe(rebuildsBefore + 2)
  })

  it('the manifest is still a key: its arrival still rebuilds the fleet', async () => {
    // countingLanes([null, laneManifestBody]): the boot fetch (no repo named
    // yet) answers with no manifest; `startedFor` names a repo, which
    // `useLaneManifest` re-asks on (`repoPath` in its dep array) and this
    // time gets one. Two things move in that one settle: `state.session`
    // itself (a fleet input on its own) and, one microtask later, the
    // manifest resolving — so a correctly-keyed fleet rebuilds twice, not
    // once. If `manifest` were ever dropped from the memo's key, the second
    // of those — the manifest's own arrival — could not produce a rebuild,
    // and this would read `rebuildsBefore + 1` instead: the regression this
    // guards against.
    const lanes = countingLanes([null, laneManifestBody])
    const chain = await renderBeatChain(lanes.impl)
    const rebuildsBefore = chain.rebuilds()

    await act(async () => {
      chain.getSource().emit(startedFor('alpha', 's-alpha-beat-4'))
    })

    expect(chain.rebuilds()).toBe(rebuildsBefore + 2)
  })

  it('keys on eleven slices plus the clock and the manifest (thirteen in total)', () => {
    // Do not re-prove the tick itself — the one clock rule describe above
    // already covers `FLEET_TICK_MS` end to end. This only guards against a
    // slice silently falling out of the constant the key is spread from.
    expect(FLEET_INPUT_SLICES).toHaveLength(11)
  })

  /** Slices `buildFleet` provably does not read, plus the envelope fields. */
  const SLICES_THE_FLEET_IGNORES = [
    'checkpoints',
    'forks',
    'judge',
    'refusals',
    'eventCount',
    'firstEventTs',
    'lastEventTs',
  ] as const

  it('every SessionState key is either a fleet input or a declared non-input', () => {
    // The anti-rot ratchet: this is the law that survives the file being
    // edited by someone who has never read this issue. A new slice on
    // `SessionState` fails here until a human decides which side it is on.
    expect([...FLEET_INPUT_SLICES, ...SLICES_THE_FLEET_IGNORES].sort()).toEqual(
      Object.keys(initialSessionState()).sort(),
    )
  })

  it('an event touching only an ignored slice changes nothing buildFleet returns but eventCount', () => {
    const f = createEventFactory({ startTs: NOW, idPrefix: 'beat-7' })
    f.sessionStarted()
    f.worktreeDiscovered({
      path: '/repo-wt/beat-7',
      branch: 'beat-7',
      head: 'sha-0',
      isMain: false,
    })
    const baseEvents = f.all()
    const before = reduceAll(baseEvents)
    const after = reduce(before, f.judgeFinding())
    const opts = { now: NOW, manifest: null }

    expect({ ...buildFleet(after, opts), eventCount: 0 }).toEqual({
      ...buildFleet(before, opts),
      eventCount: 0,
    })
    // Stated as a fact rather than left as a comment: this is the
    // `eventCount` decision from the plan, not an oversight.
    expect(buildFleet(after, opts).eventCount).toBe(before.eventCount + 1)
  })
})
