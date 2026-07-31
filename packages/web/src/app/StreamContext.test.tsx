import { createEvent, createIdFactory, type ObservatoryEvent } from '@observatory/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import type { FetchLike } from '../replay/api.js'
import { ModeProvider, useReplay } from './ModeContext.js'
import { StreamProvider, useStream } from './StreamContext.js'
import { NEWS_GRACE_MS, foldStreamEvents, initialStreamState, isNews } from './streamState.js'

afterEach(cleanup)

const nextId = createIdFactory('evt')

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null

  open() {
    this.onopen?.(new Event('open'))
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
  }

  close() {}
}

/** The live SSE stream discovers only the main worktree. */
function liveWorktreeEvent() {
  return createEvent(
    'worktree.discovered',
    { path: '/repo', branch: 'main', head: 'sha-live', isMain: true },
    { id: nextId(), ts: 9000 },
  )
}

/** A recorded session whose worktree lands after `session.started`, at ts 2000. */
function replaySessionEvents() {
  return [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'observatory', mainBranch: 'main' },
      { id: nextId(), ts: 1000 },
    ),
    createEvent(
      'worktree.discovered',
      { path: '/repo-wt/replay', branch: 'replay', head: 'sha-replay', isMain: false },
      { id: nextId(), ts: 2000 },
    ),
  ]
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function makeFetch(events: ReturnType<typeof replaySessionEvents>): FetchLike {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return jsonResponse({
        sessions: [{ id: 's1', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 100 }],
      })
    }
    if (href === '/api/sessions/s1/events') {
      return jsonResponse({ events })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

/** Stands in for a real panel: reads only `useStream`, never the mode/replay hooks. */
function PanelLikeConsumer() {
  const { state } = useStream()
  return (
    <div data-testid="worktree-paths">{Object.keys(state.session.worktrees).sort().join(',')}</div>
  )
}

/** Stands in for the replay controls: the only thing that drives session/scrub selection. */
function ReplayDriver() {
  const { sessions, selectSession, playback } = useReplay()
  return (
    <div>
      <button onClick={() => selectSession(sessions[0]?.id ?? null)}>select session</button>
      <button onClick={() => playback.seek(2000)}>seek</button>
      <button onClick={() => selectSession(null)}>return to live</button>
      {/* Exposes the scrubber clock so the test can wait for the "jump to
          session start" reset (usePlayback's `[start, end]` effect, which
          fires once the fetched log lands) to actually settle before it
          drives a seek — otherwise the seek can race that reset and be
          silently clobbered by it. */}
      <span data-testid="scrub-ts">{playback.currentTs}</span>
    </div>
  )
}

/**
 * Mounting kicks off the session-list fetch immediately; awaiting an async
 * `act` around `render` flushes that chain's microtasks before the test's
 * first interaction, rather than leaving it to race a later waitFor's
 * default timeout under scheduler load (see #28/#31).
 */
async function renderApp() {
  let source: FakeEventSource | undefined
  let utils!: ReturnType<typeof render>
  await act(async () => {
    utils = render(
      <ModeProvider fetchImpl={makeFetch(replaySessionEvents())}>
        <StreamProvider
          url="/api/stream"
          createSource={() => {
            source = new FakeEventSource()
            return source
          }}
        >
          <PanelLikeConsumer />
          <ReplayDriver />
        </StreamProvider>
      </ModeProvider>,
    )
  })
  return { ...utils, getSource: () => source }
}

describe('StreamContext driven by mode', () => {
  it('serves live state while live, the replay fold while replaying, and live again after returning', async () => {
    const { getSource } = await renderApp()

    act(() => getSource()?.open())
    act(() => getSource()?.emit(liveWorktreeEvent()))
    expect(screen.getByTestId('worktree-paths').textContent).toBe('/repo')

    // Selecting a session chains through two mocked fetches (session list,
    // then that session's events) plus the scrubber's reset-to-start effect
    // before `currentTs` reads back the session's first event (ts 1000).
    // Awaiting an async `act` around the click flushes that whole chain's
    // microtasks deterministically, rather than racing it against waitFor's
    // default 1000ms timeout under scheduler load (see #28/#31).
    await act(async () => {
      fireEvent.click(screen.getByText('select session'))
    })
    expect(screen.getByTestId('scrub-ts').textContent).toBe('1000')
    // Scrub time starts at the session's first event (ts 1000): the worktree
    // (ts 2000) has not "happened" yet — panels must show that, not the
    // live `/repo` worktree, and not a preview of the whole replay log.
    expect(screen.getByTestId('worktree-paths').textContent).toBe('')

    fireEvent.click(screen.getByText('seek'))
    await waitFor(() =>
      expect(screen.getByTestId('worktree-paths').textContent).toBe('/repo-wt/replay'),
    )

    fireEvent.click(screen.getByText('return to live'))
    await waitFor(() => expect(screen.getByTestId('worktree-paths').textContent).toBe('/repo'))
  })
})

// ── news vs history (C's first motion-law rule) ─────────────────────────────

/**
 * The rule the scene depends on: **history builds state and lights nothing.**
 * `/api/stream` replays the whole session before it live-tails, so every
 * connection opens with a burst of facts that already happened — and a burst
 * has no guaranteed order. The tag therefore has to come from each event's own
 * `ts`, never from the order the socket handed them over in.
 */
describe('news vs history', () => {
  const connectedAt = Date.UTC(2026, 6, 31, 12, 0, 0)

  function commit(sha: string, ts: number): ObservatoryEvent {
    return createEvent(
      'commit.landed',
      {
        sha,
        branch: 'a',
        message: `feat: ${sha}`,
        author: { name: 'agent' },
        files: [{ path: `src/${sha}.ts`, status: 'added' }],
      },
      { id: nextId(), ts },
    )
  }

  it('tags an out-of-order replay burst as history, whatever order it lands in', () => {
    const burst = [
      commit('c3', connectedAt - 30_000),
      commit('c1', connectedAt - 600_000),
      commit('c4', connectedAt - 5_000),
      commit('c2', connectedAt - 120_000),
    ]

    const state = foldStreamEvents(initialStreamState(connectedAt), burst)

    // Every fact landed in the fold…
    expect(Object.keys(state.session.commits).sort()).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(state.events).toHaveLength(4)
    // …and not one of them is news, so nothing lights up.
    expect(state.news).toEqual([])
    expect(state.newsCount).toBe(0)
    for (const event of burst) expect(isNews(state, event)).toBe(false)
  })

  it('tags what actually just happened as news, including the connect seam', () => {
    const state = foldStreamEvents(initialStreamState(connectedAt), [
      commit('old', connectedAt - 600_000),
      // Emitted a moment before we connected: genuinely news by arrival.
      commit('seam', connectedAt - NEWS_GRACE_MS + 1_000),
      commit('new', connectedAt + 2_000),
    ])

    expect(state.news.map((event) => event.id)).toHaveLength(2)
    expect(state.newsCount).toBe(2)
    expect(state.news.every((event) => isNews(state, event))).toBe(true)
  })

  it('folds a burst identically whether it arrives at once or one at a time', () => {
    const burst = [commit('x1', connectedAt - 10_000), commit('x2', connectedAt + 1_000)]

    const batched = foldStreamEvents(initialStreamState(connectedAt), burst)
    const single = burst.reduce(
      (state, event) => foldStreamEvents(state, [event]),
      initialStreamState(connectedAt),
    )

    expect(single.newsCount).toBe(batched.newsCount)
    expect(Object.keys(single.session.commits).sort()).toEqual(
      Object.keys(batched.session.commits).sort(),
    )
  })
})

// ── fixture switching (ruling 24's three sources, one reducer) ──────────────

/** Exposes which log is driving and how much of it folded. */
function SourceProbe() {
  const { source, state, provenance } = useStream()
  return (
    <div>
      <span data-testid="source">{source}</span>
      <span data-testid="worktrees">{Object.keys(state.session.worktrees).length}</span>
      <span data-testid="news">{state.newsCount}</span>
      <span data-testid="provenance">{provenance}</span>
    </div>
  )
}

describe('fixture switching', () => {
  /** Pinned: the fixtures generate from this instant and never tick. */
  const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

  async function renderSources() {
    let utils!: ReturnType<typeof render>
    await act(async () => {
      utils = render(
        <StreamProvider url="/api/stream" now={NOW} createSource={() => new FakeEventSource()}>
          <SourceProbe />
        </StreamProvider>,
      )
    })
    return utils
  }

  it('starts on the live stream', async () => {
    await renderSources()

    expect(screen.getByTestId('source').textContent).toBe('live')
    expect(screen.getByTestId('provenance').textContent).toBe('live · /api/stream')
  })

  it('keys 2 and 3 swap the driving log, folded by the same reducer', async () => {
    await renderSources()

    await act(async () => {
      fireEvent.keyDown(window, { key: '2' })
    })
    expect(screen.getByTestId('source').textContent).toBe('fleet20')
    // Twenty lanes plus main, folded from real schema events by core's reducer.
    expect(screen.getByTestId('worktrees').textContent).toBe('21')
    expect(screen.getByTestId('provenance').textContent).toContain('20 lanes')

    await act(async () => {
      fireEvent.keyDown(window, { key: '3' })
    })
    expect(screen.getByTestId('source').textContent).toBe('pathology')
    expect(screen.getByTestId('worktrees').textContent).toBe('10')

    await act(async () => {
      fireEvent.keyDown(window, { key: '1' })
    })
    expect(screen.getByTestId('source').textContent).toBe('live')
    // The live connection kept folding the whole time, so returning to it is
    // exactly where it left off — nothing was torn down and rebuilt.
    expect(screen.getByTestId('worktrees').textContent).toBe('0')
  })

  it('a fixture builds state without lighting anything up', async () => {
    await renderSources()

    await act(async () => {
      fireEvent.keyDown(window, { key: '3' })
    })

    // The fixture's history is history: it is all older than the moment the
    // fixture "connected", so the state is fully built and the scene has
    // nothing whatsoever to flare about.
    expect(screen.getByTestId('worktrees').textContent).toBe('10')
    expect(screen.getByTestId('news').textContent).toBe('0')
  })

  it('ignores the fixture keys while the operator is typing', async () => {
    await renderSources()
    const input = document.createElement('input')
    document.body.append(input)

    await act(async () => {
      fireEvent.keyDown(input, { key: '2' })
    })
    expect(screen.getByTestId('source').textContent).toBe('live')

    input.remove()
  })
})
