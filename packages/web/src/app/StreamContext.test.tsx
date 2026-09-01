import {
  createEvent,
  createIdFactory,
  fixtureHistory,
  fleet20Spec,
  pathologySpec,
  type RhizomorphEvent,
} from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import type { FetchLike } from '../replay/api.js'
import { ModeProvider, useReplay } from './ModeContext.js'
import { StreamProvider, useStream } from './StreamContext.js'
import {
  NEWS_GRACE_MS,
  eventsWindowLabel,
  foldStreamEvent,
  foldStreamEvents,
  initialStreamState,
  isNews,
} from './streamState.js'

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
      { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
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
    // #183: a lone arrival folds eagerly (this one does, since nothing else
    // is in flight), but waiting rather than reading state back immediately
    // doesn't assume that leading-edge detail — it's still correct if a
    // second arrival ever lands here and has to wait its own turn.
    await waitFor(() => expect(screen.getByTestId('worktree-paths').textContent).toBe('/repo'))

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

  function commit(sha: string, ts: number): RhizomorphEvent {
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
    expect(Object.keys(state.session.commits.bySha).sort()).toEqual(['c1', 'c2', 'c3', 'c4'])
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
    // `bySha`, not the slice object (#342): keys of `CommitsState` itself are
    // its three static properties, which would make this equality vacuous.
    expect(Object.keys(single.session.commits.bySha).sort()).toEqual(
      Object.keys(batched.session.commits.bySha).sort(),
    )
  })

  /**
   * #166's own law, stated as a property of the two fold functions
   * themselves: batching a burst through `foldStreamEvents` in one pass must
   * not change the result by one field from folding it through the per-event
   * `foldStreamEvent` one at a time — proven bit-for-bit, over a burst that
   * arrives out of order and repeats an id (a duplicate SSE delivery, or two
   * collectors racing the same commit). #183 is what actually wires
   * `foldStreamEvents` into the live connection (`StreamContext.tsx`'s
   * `reduce`, via `useEventStream`'s leading-event-then-buffered-rest fold) —
   * this law is what made that safe to do without re-proving it there.
   */
  it('batched folding matches per-event folding exactly, including out-of-order arrival and a duplicate id (#166)', () => {
    const burst = [
      commit('c3', connectedAt - 30_000),
      commit('c1', connectedAt - 600_000),
      commit('c1', connectedAt - 600_000), // duplicate: same id, same payload, arrives twice
      commit('c4', connectedAt - 5_000),
      commit('c2', connectedAt - 120_000),
      commit('c4', connectedAt - 5_000), // duplicate of the most recent, not the first
    ]

    const batched = foldStreamEvents(initialStreamState(connectedAt), burst)
    const perEvent = burst.reduce(
      (state, event) => foldStreamEvent(state, event),
      initialStreamState(connectedAt),
    )

    expect(batched).toEqual(perEvent)
  })
})

/**
 * #166's OWN BEFORE/AFTER: `foldStreamEvent` does `events: [...state.events,
 * event]`, an O(n) copy per event — O(n²) over a burst, which is exactly the
 * shape a *fresh* page load has (`/api/stream` replays the whole session
 * before it live-tails when there's no `Last-Event-ID` yet to resume from).
 * `foldStreamEvents` folds the same burst in one O(n) pass. Sized for CI
 * (moderate N, generous timeout) rather than the live session's real ~46k-55k
 * events — `streamState.test.ts`'s `#183` bench reports the size-scaled
 * before/after (5k/15k/55k) this issue's DoD asks for, and
 * `useEventStream.ts`'s own docstring carries that table.
 *
 * Reported, not asserted (`scene/perf.test.ts`'s own discipline, restated
 * here): a wall clock under concurrent workers measures the machine, not the
 * code. The law beside the report is the identity above, not a threshold.
 */
describe('#166: batching cost, per-event vs batched', () => {
  const BENCH_TIMEOUT_MS = 120_000
  const ROUNDS = 3
  const connectedAt = Date.UTC(2026, 6, 31, 12, 0, 0)
  const paths = ['/repo/wt-a', '/repo/wt-b', '/repo/wt-c']

  /**
   * `worktree.dirty`, not `commit.landed`: `@rhizomorph/core`'s reducer keeps
   * an ever-growing `commits` map (one key per landed commit, `O(n)` to copy
   * per event, `O(n²)` over a run of commits), which would swamp the number
   * this benchmark exists to isolate — `foldStreamEvent`'s own
   * `events: [...state.events, event]` copy. Cycling three worktree paths
   * keeps `@rhizomorph/core`'s own state `O(1)` per event so what's left is
   * exactly `streamState.ts`'s contribution, the one #166 fixed.
   */
  function dirty(i: number, ts: number): RhizomorphEvent {
    const path = paths[i % paths.length]!
    return createEvent(
      'worktree.dirty',
      { path, branch: path.split('/').pop()!, files: [{ path: `file-${i}.ts`, status: 'modified' }] },
      { id: nextId(), ts },
    )
  }

  function median(samples: readonly number[]): number {
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? 0
  }

  function burst(n: number): RhizomorphEvent[] {
    return Array.from({ length: n }, (_unused, i) => dirty(i, connectedAt - n * 1000 + i * 1000))
  }

  it('folds a multi-thousand-event burst identically both ways, and reports the cost of each', () => {
    const events = burst(16000)

    const perEventFold = () =>
      events.reduce((state, event) => foldStreamEvent(state, event), initialStreamState(connectedAt))
    const batchedFold = () => foldStreamEvents(initialStreamState(connectedAt), events)

    // Warm the JIT: the steady state a real reconnect sees, not the first call.
    perEventFold()
    batchedFold()

    // INTERLEAVED: one of each per round, so both see the same machine load
    // at the same instant — #157's lesson, restated by #161's benchmark.
    const perEventSamples: number[] = []
    const batchedSamples: number[] = []
    for (let i = 0; i < ROUNDS; i += 1) {
      let started = performance.now()
      perEventFold()
      perEventSamples.push(performance.now() - started)

      started = performance.now()
      batchedFold()
      batchedSamples.push(performance.now() - started)
    }

    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log(
      `${events.length} events: per-event fold ${median(perEventSamples).toFixed(2)} ms · ` +
        `batched fold ${median(batchedSamples).toFixed(2)} ms median ` +
        `(${ROUNDS} interleaved rounds)`,
    )

    expect(perEventFold()).toEqual(batchedFold())
  }, BENCH_TIMEOUT_MS)
})

// ── fixture switching (ruling 24's three sources, one reducer) ──────────────

/** Exposes which log is driving and how much of it folded. */
function SourceProbe() {
  const { source, state, provenance, eventsWindowLabel } = useStream()
  return (
    <div>
      <span data-testid="source">{source}</span>
      <span data-testid="worktrees">{Object.keys(state.session.worktrees).length}</span>
      <span data-testid="news">{state.newsCount}</span>
      <span data-testid="provenance">{provenance}</span>
      <span data-testid="events-window-label">{eventsWindowLabel ?? ''}</span>
    </div>
  )
}

describe('fixture switching', () => {
  /** Pinned: the fixtures generate from this instant and never tick. */
  const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

  /**
   * `StreamProvider` builds a fixture's ~2,900–8,000-event history the first
   * time a test presses its key, inside that test's own timeout window.
   * Warming `fixtures.ts`'s memo here — same spec singleton, same `now`, same
   * default seed the provider uses — moves the one-time build for each
   * fixture into setup, so the key-press tests below only pay for the fold.
   */
  beforeAll(() => {
    fixtureHistory(fleet20Spec(), NOW)
    fixtureHistory(pathologySpec(), NOW)
  })

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

  /**
   * #221's boundary voice, wired through the context: every source
   * (`eventsWindowLabel(replayState|fixture.state|live.state)`,
   * `StreamContext.tsx`) reads null here because none of these ordinary,
   * small event logs ever approach `streamState.ts`'s `MAX_EVENTS` ceiling —
   * `streamState.test.ts` proves the label's actual wording once eviction
   * does happen, at the scale that requires; this only proves the context
   * doesn't invent a truncation warning where none exists.
   */
  it('reports no truncation for any of the three ordinary-sized sources', async () => {
    await renderSources()
    expect(screen.getByTestId('events-window-label').textContent).toBe('')

    await act(async () => {
      fireEvent.keyDown(window, { key: '2' })
    })
    expect(screen.getByTestId('events-window-label').textContent).toBe('')

    await act(async () => {
      fireEvent.keyDown(window, { key: '3' })
    })
    expect(screen.getByTestId('events-window-label').textContent).toBe('')
  })
})

// ── the repo boundary (#390) ────────────────────────────────────────────────

/**
 * #390 (prd20 wave 3, from the retarget spike's Q5, #265). The unit laws live
 * in `streamState.test.ts`; this is the same rule through the real provider,
 * because the lie is a *surface* fact: a panel reading `useStream` must never
 * be able to render the new repo's name over the old repo's fleet.
 */
function RepoConsumer() {
  const { state } = useStream()
  return (
    <div>
      <span data-testid="repo-path">{state.session.session?.repoPath ?? ''}</span>
      <span data-testid="repo-worktrees">
        {Object.keys(state.session.worktrees).sort().join(',')}
      </span>
      <span data-testid="repo-events">{state.events.length}</span>
      {/* The two facts every "elapsed" figure on the page is measured from,
          and the session the panels believe they are showing (#592). */}
      <span data-testid="repo-session">{state.session.session?.sessionId ?? ''}</span>
      <span data-testid="repo-first-ts">{state.session.firstEventTs ?? ''}</span>
      <span data-testid="repo-fold-count">{state.session.eventCount}</span>
    </div>
  )
}

async function renderRepoApp() {
  let source: FakeEventSource | undefined
  await act(async () => {
    render(
      <ModeProvider fetchImpl={makeFetch(replaySessionEvents())}>
        <StreamProvider
          url="/api/stream"
          createSource={() => {
            source = new FakeEventSource()
            return source
          }}
        >
          <RepoConsumer />
        </StreamProvider>
      </ModeProvider>,
    )
  })
  return { getSource: () => source as FakeEventSource }
}

/** `session.started` plus one worktree, for a named repo. */
function repoEvents(repo: string) {
  return [
    createEvent(
      'session.started',
      {
        sessionId: `s-${repo}`,
        repoPath: `/repos/${repo}`,
        repoName: repo,
        mainBranch: 'main',
      },
      { id: nextId(), ts: 10_000 },
    ),
    createEvent(
      'worktree.discovered',
      { path: `/repos/${repo}/lane`, branch: 'lane', head: `sha-${repo}`, isMain: true },
      { id: nextId(), ts: 10_001 },
    ),
  ]
}

describe('the repo boundary through the provider (#390)', () => {
  it('shows only the new repo after a retarget, never its name over the old fleet', async () => {
    const { getSource } = await renderRepoApp()
    act(() => getSource().open())

    for (const event of repoEvents('alpha')) act(() => getSource().emit(event))
    await waitFor(() =>
      expect(screen.getByTestId('repo-worktrees').textContent).toBe('/repos/alpha/lane'),
    )

    // The retarget: the concierge points the dashboard at another repo, and
    // the stream announces it the only way it can today — a `session.started`
    // naming a different `repoPath`. No `'retargeted'` close reason involved
    // (#384 is a separate lane and this must not wait on it).
    for (const event of repoEvents('beta')) act(() => getSource().emit(event))

    await waitFor(() =>
      expect(screen.getByTestId('repo-path').textContent).toBe('/repos/beta'),
    )
    // The whole point: alpha's worktree is gone, not merged underneath beta's
    // heading. `StatusBar` re-reads `/api/meta` on the session-id change, so
    // the heading was already right — an untouched fleet under it is the
    // instrument lying about what it watches.
    expect(screen.getByTestId('repo-worktrees').textContent).toBe('/repos/beta/lane')
    expect(screen.getByTestId('repo-events').textContent).toBe('2')
  })

  it('survives a reconnect that replays the same repo from the top', async () => {
    const { getSource } = await renderRepoApp()
    act(() => getSource().open())

    const alpha = repoEvents('alpha')
    for (const event of alpha) act(() => getSource().emit(event))
    await waitFor(() =>
      expect(screen.getByTestId('repo-worktrees').textContent).toBe('/repos/alpha/lane'),
    )

    // `EventSource` reconnects on its own with `Last-Event-ID`; when the new
    // process's buffer never held that id, `resumeBacklog` falls back to
    // replaying the whole session (`server/src/api/stream.ts`). Same repo,
    // same events, from the top — and the fold must absorb that rather than
    // be wiped by it.
    for (const event of alpha) act(() => getSource().emit(event))

    await waitFor(() => expect(screen.getByTestId('repo-events').textContent).toBe('4'))
    expect(screen.getByTestId('repo-path').textContent).toBe('/repos/alpha')
    expect(screen.getByTestId('repo-worktrees').textContent).toBe('/repos/alpha/lane')
  })
})

/**
 * #592 — THE ROTATION, THROUGH THE PROVIDER.
 *
 * The unit laws live in `core/src/reduce.test.ts` (the fold) and
 * `streamState.test.ts` (the raw window). This is the operator's own claim,
 * through the real provider a panel reads: they pressed **end session · start
 * fresh**, the server opened a new recording and began delivering it down the
 * same connection, and the live view has to visibly become that recording
 * instead of quietly folding it on top of the one they just ended.
 *
 * Same repo throughout — that is the whole difference from the retarget above,
 * and the case #390's own reading explicitly excluded.
 */
function rotationEvents(sessionId: string, atTs: number) {
  return [
    createEvent(
      'session.started',
      { sessionId, repoPath: '/repos/alpha', repoName: 'alpha', mainBranch: 'main' },
      { id: nextId(), ts: atTs },
    ),
    createEvent(
      'worktree.discovered',
      { path: `/repos/alpha/${sessionId}-lane`, branch: 'lane', head: 'sha-after', isMain: true },
      { id: nextId(), ts: atTs + 1 },
    ),
  ]
}

describe('the rotation through the provider (#592)', () => {
  it('visibly resets the live view, and restarts the elapsed figures from the new recording', async () => {
    const { getSource } = await renderRepoApp()
    act(() => getSource().open())

    for (const event of repoEvents('alpha')) act(() => getSource().emit(event))
    await waitFor(() =>
      expect(screen.getByTestId('repo-worktrees').textContent).toBe('/repos/alpha/lane'),
    )
    // The recording the operator is about to end really did accumulate a past.
    expect(screen.getByTestId('repo-fold-count').textContent).toBe('2')
    expect(screen.getByTestId('repo-first-ts').textContent).toBe('10000')

    // The rotation. Same repo, new session id — exactly what `/api/stream`
    // delivers down the still-open connection after the button is pressed.
    for (const event of rotationEvents('s-rotated', 20_000)) act(() => getSource().emit(event))

    await waitFor(() =>
      expect(screen.getByTestId('repo-session').textContent).toBe('s-rotated'),
    )
    // The scene changed: the ended recording's worktree is gone, not sitting
    // underneath the new session's name.
    expect(screen.getByTestId('repo-worktrees').textContent).toBe('/repos/alpha/s-rotated-lane')
    // The elapsed figures restart — this is the half a rotation-blind fold got
    // wrong even when the panels happened to look plausible.
    expect(screen.getByTestId('repo-first-ts').textContent).toBe('20000')
    expect(screen.getByTestId('repo-fold-count').textContent).toBe('2')
    // …and the raw window travels with the fold, so `events.length` and
    // `session.eventCount` still describe one recording.
    expect(screen.getByTestId('repo-events').textContent).toBe('2')
    // The repo did NOT change, so this is genuinely the rotation case and not
    // the retarget one wearing its clothes.
    expect(screen.getByTestId('repo-path').textContent).toBe('/repos/alpha')
  })

  it('is not fooled by the stream re-stating the session it is already folding', async () => {
    const { getSource } = await renderRepoApp()
    act(() => getSource().open())

    const alpha = repoEvents('alpha')
    for (const event of alpha) act(() => getSource().emit(event))
    await waitFor(() =>
      expect(screen.getByTestId('repo-worktrees').textContent).toBe('/repos/alpha/lane'),
    )

    // Not a rotation: the SAME session id. A reconnect's replay, or a server
    // re-announcing itself, must not wipe a live fold.
    act(() => getSource().emit(alpha[0]))

    await waitFor(() => expect(screen.getByTestId('repo-events').textContent).toBe('3'))
    expect(screen.getByTestId('repo-worktrees').textContent).toBe('/repos/alpha/lane')
    expect(screen.getByTestId('repo-first-ts').textContent).toBe('10000')
  })
})

// ── the live window's honesty (#132, prd-44 ruling 4's cost) ────────────────

/**
 * The server bounds what it replays (`MAX_BUFFERED_EVENTS`, prd-44 ruling 4),
 * and that truncation is invisible to a fold built from the truncated stream:
 * every event the client received is in its own `session.eventCount`, so the
 * pair `eventsWindowLabel` reads agrees and the window passes as whole. The
 * live branch therefore asks `/api/meta` for the session's true recorded total.
 *
 * **Scale is not the point, the relation is.** The real case is a server
 * sending the last 75,000 of a 200,000-event session; these laws send 2 of 900.
 * Both are "the client received fewer than the session recorded", which is the
 * only thing the label's rule looks at — and 2-of-900 drives it without a
 * 200,000-event fixture. `streamState.test.ts` already proves the wording at
 * the scale eviction requires.
 *
 * Every assertion is a rendered string or a call count, never a wall clock.
 */
describe('the live window says so when the server had room to send less than the session', () => {
  const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

  /** A live session that has started, so the provider has an identity to key its fetch on. */
  function liveSessionStarted(sessionId = 's-live') {
    return createEvent(
      'session.started',
      { sessionId, repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
      { id: nextId(), ts: 8000 },
    )
  }

  /**
   * Counts the calls, so a law can prove a request was never made at all, and
   * answers per call: `metaFetch(a, b)` gives `a` to the first request and `b`
   * to the second, which is how the rotation law tells "forgot the old total"
   * from "asked again and got the same number".
   */
  function metaFetch(...bodies: unknown[]) {
    const calls: string[] = []
    const impl = (input: string) => {
      const body = bodies[Math.min(calls.length, bodies.length - 1)]
      calls.push(input)
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return { impl, calls }
  }

  /** The failure shapes, each of which must read exactly as today. */
  function failingMetaFetch(kind: 'not-ok' | 'throws', body: unknown = { eventCount: 900 }) {
    const calls: string[] = []
    const impl = (input: string) => {
      calls.push(input)
      if (kind === 'throws') return Promise.reject(new Error('ECONNREFUSED'))
      return Promise.resolve({ ok: false, json: () => Promise.resolve(body) })
    }
    return { impl, calls }
  }

  async function renderLive(fetchMeta?: (input: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) {
    let source!: FakeEventSource
    await act(async () => {
      render(
        <StreamProvider
          url="/api/stream"
          now={NOW}
          createSource={() => {
            source = new FakeEventSource()
            return source
          }}
          {...(fetchMeta ? { fetchMeta } : {})}
        >
          <SourceProbe />
        </StreamProvider>,
      )
    })
    return { getSource: () => source }
  }

  /** Emits the events and lets the `/api/meta` promise settle into state. */
  async function emit(source: FakeEventSource, events: readonly RhizomorphEvent[]) {
    await act(async () => {
      for (const event of events) source.emit(event)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  function label(): string {
    return screen.getByTestId('events-window-label').textContent ?? ''
  }

  it('says the window is partial when the session recorded more than this client received', async () => {
    const meta = metaFetch({ eventCount: 900 })
    const { getSource } = await renderLive(meta.impl)

    await emit(getSource(), [liveSessionStarted(), liveWorktreeEvent()])

    // THE law. On the code before #132 this reads '' — the client's own fold
    // says 2 of 2, and the 898 events the server had no room to replay are
    // invisible to it.
    await waitFor(() => expect(label()).toBe('showing the last 2 events'))
    expect(meta.calls).toEqual(['/api/meta'])
  })

  it('leaves the wording to eventsWindowLabel rather than composing a second sentence', async () => {
    const meta = metaFetch({ eventCount: 900 })
    const { getSource } = await renderLive(meta.impl)
    const events = [liveSessionStarted(), liveWorktreeEvent()]

    await emit(getSource(), events)

    // Byte-identical to what the label itself produces for the corrected pair,
    // so this context can never drift into a voice of its own — the failure
    // #384's boot-reason seam is about, one layer over.
    const expected = eventsWindowLabel({
      events: [...events],
      session: { ...initialStreamState(NOW).session, eventCount: 900 },
    })
    await waitFor(() => expect(label()).toBe(expected))
  })

  it('reports nothing when the session recorded exactly what arrived', async () => {
    const meta = metaFetch({ eventCount: 2 })
    const { getSource } = await renderLive(meta.impl)

    await emit(getSource(), [liveSessionStarted(), liveWorktreeEvent()])

    await waitFor(() => expect(meta.calls).toHaveLength(1))
    expect(label()).toBe('')
  })

  it('degrades to the fold, never to an invented total, for every way the route can fail', async () => {
    for (const meta of [
      failingMetaFetch('not-ok'), // a non-ok response
      failingMetaFetch('throws'), // the fetch itself throws
      metaFetch({ resumedCount: 3 }), // a server that predates the field
      metaFetch({ eventCount: -1 }), // a count no session can have
      metaFetch({ eventCount: 12.5 }), // not an integer
      metaFetch({ eventCount: 1 }), // SMALLER than arrived — a stale answer is discarded, never adopted
      metaFetch('not an object'),
      metaFetch(null),
    ]) {
      cleanup()
      const { getSource } = await renderLive(meta.impl)
      await emit(getSource(), [liveSessionStarted(), liveWorktreeEvent()])
      await waitFor(() => expect(meta.calls).toHaveLength(1))
      // Exactly today's answer. An unavailable total must never become a
      // label — "showing the last 2 events" here would be the instrument
      // inventing a truncation that did not happen.
      expect(label()).toBe('')
    }
  })

  it('asks nothing of /api/meta while a fixture is driving', async () => {
    const meta = metaFetch({ eventCount: 900 })
    const { getSource } = await renderLive(meta.impl)

    // The fixture takes over BEFORE the live session's identity arrives, which
    // is what makes the gate observable at all: the fetch is keyed on that
    // identity, so a law that switches sources afterwards proves only that the
    // effect did not re-run.
    await act(async () => {
      fireEvent.keyDown(window, { key: '2' })
    })
    expect(screen.getByTestId('source').textContent).toBe('fleet20')

    await emit(getSource(), [liveSessionStarted(), liveWorktreeEvent()])

    // A fixture folds a whole log, so its own `session.eventCount` IS the true
    // total and the route has nothing to add — the same reason `StatusBar.tsx`
    // does not ask while replaying. Not one request.
    expect(meta.calls).toEqual([])
    expect(label()).toBe('')
  })

  it('asks nothing of /api/meta while replaying', async () => {
    const meta = metaFetch({ eventCount: 900 })
    let source!: FakeEventSource
    await act(async () => {
      render(
        <ModeProvider fetchImpl={makeFetch(replaySessionEvents())}>
          <StreamProvider
            url="/api/stream"
            now={NOW}
            fetchMeta={meta.impl}
            createSource={() => {
              source = new FakeEventSource()
              return source
            }}
          >
            <SourceProbe />
            <ReplayDriver />
          </StreamProvider>
        </ModeProvider>,
      )
    })

    // Replay first, again so the gate is observable rather than merely
    // unexercised: entering replay before the live identity exists means a
    // gated fetch never fires at all.
    await act(async () => {
      fireEvent.click(screen.getByText('select session'))
    })
    await emit(source, [liveSessionStarted(), liveWorktreeEvent()])

    // `/api/meta` only ever describes the live recorder, so asking it while
    // replaying is a request whose answer must be discarded — `StatusBar.tsx`'s
    // own reason for the same gate on the same route.
    expect(meta.calls).toEqual([])
    expect(label()).toBe('')
  })

  it('forgets the previous session total the moment the identity changes', async () => {
    // 900 for the session that had been running a while, then 1 for the fresh
    // one — which is what `/api/meta` actually answers across a rotation.
    const meta = metaFetch({ eventCount: 900 }, { eventCount: 1 })
    const { getSource } = await renderLive(meta.impl)
    await emit(getSource(), [liveSessionStarted('s-one'), liveWorktreeEvent()])
    await waitFor(() => expect(label()).toBe('showing the last 2 events'))

    // A rotation: the operator ended that session and opened another. The fold
    // resets to the new session and the total must reset with it — carrying 900
    // across would report a brand-new 1-event session as partial, which is the
    // false positive this whole change must not introduce.
    // A SYNCHRONOUS act, deliberately: it emits without draining the microtask
    // queue, so this reads the instant the identity changed and not the state
    // after the second answer has landed. That distinction is the whole law —
    // an implementation that re-fetches but does not clear passes every
    // end-state assertion while showing the new session as partial for as long
    // as the request is in flight.
    act(() => {
      getSource().emit(liveSessionStarted('s-two'))
    })
    expect(label()).toBe('')

    await waitFor(() => expect(meta.calls).toHaveLength(2))
    expect(label()).toBe('')
  })
})
