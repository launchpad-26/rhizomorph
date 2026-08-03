import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createEvent, createIdFactory } from '@rhizomorph/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import { laneUrl, navigate } from './app/router.js'
import { useSelection } from './fleet/index.js'
import type { EventSourceLike } from './hooks/useEventStream.js'

// App renders these behind React.lazy(() => import(...)). Mocking them (below)
// makes their dynamic import() trivial, but it's still a real import() —
// React.lazy still suspends for at least one promise-resolution tick before
// the shell commits. `findByText`/`waitFor` race that tick against a fixed
// default deadline (1000ms), and under CPU contention (several suites'
// processes fighting for the same cores) that tick's wall-clock cost is
// whatever the scheduler feels like, which can occasionally outrun the
// deadline — the same family of flake already fixed in PanelGrid.test.tsx
// (#28, #42). Preloading resolves each mocked module's import() *before*
// mounting (an unbounded await with no deadline of its own), so by the time
// App's `lazy()` calls the same import() specifier, the module record is
// already fulfilled and there is no delay left to race. The one remaining
// tick — React's mandatory suspend-then-resume on first render, now against
// already-resolved promises — is flushed deterministically with
// `act(async () => {})` instead of a timed poll, so the assertions that
// follow are plain synchronous queries with nothing left to race.
vi.mock('./panels/attention/index.js', () => ({ default: () => <div>Attention strip</div> }))
vi.mock('./panels/burn/index.js', () => ({ default: () => <div>Burn strip</div> }))
// A stub that can still drive the one real selection (ruling 6's Esc precedence
// test needs a way to open the drawer without a real fleet row to click).
vi.mock('./panels/fleet/index.js', () => ({
  default: function FleetStub() {
    const { select } = useSelection()
    return (
      <div>
        <h2>Fleet</h2>
        <button type="button" onClick={() => select('42-otel-receiver')}>
          select lane
        </button>
      </div>
    )
  },
}))
vi.mock('./panels/ledger/index.js', () => ({ default: () => <h2>Ledger</h2> }))
vi.mock('./panels/collisions/index.js', () => ({ default: () => <h2>Collisions</h2> }))
vi.mock('./panels/feed/index.js', () => ({ default: () => <h2>Activity</h2> }))
vi.mock('./replay/index.js', () => ({ default: () => <div>Replay stub</div> }))
vi.mock('./scene/index.js', () => ({ default: () => <div>Scene stub</div> }))

afterEach(cleanup)

/** Pinned so the fixtures and the derived fleet never re-derive on a timer. */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

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

/**
 * A server that has not shipped `/api/lanes` yet (#76) — the honest wave-1
 * state. Injected rather than left to the ambient `fetch` so nothing in this
 * suite depends on a network call that may or may not exist in the environment.
 */
const noLaneManifest = async () => ({ ok: false, json: async () => null })

/**
 * jsdom has no `EventSource` global, so every render needs a mock source
 * injected. Also preloads every mocked lazy module and flushes the one
 * remaining suspend-then-resume tick before returning — see the top-of-file
 * comment — so callers can assert with plain synchronous queries.
 */
async function renderApp() {
  await Promise.all([
    import('./panels/attention/index.js'),
    import('./panels/burn/index.js'),
    import('./panels/fleet/index.js'),
    import('./panels/ledger/index.js'),
    import('./panels/collisions/index.js'),
    import('./panels/feed/index.js'),
    import('./replay/index.js'),
    import('./scene/index.js'),
    // Real (unmocked) drawer and lane page — `Shell`/`App` mount their own
    // `Suspense` unconditionally, so both are on the same one-tick clock as
    // every mocked lazy module above.
    import('./drawer/index.js'),
    import('./lane-page/index.js'),
  ])

  let source: FakeEventSource | undefined
  const utils = render(
    <App
      now={NOW}
      fetchLanes={noLaneManifest}
      createSource={(url) => {
        expect(url).toBe('/api/stream')
        source = new FakeEventSource()
        return source
      }}
    />,
  )
  await act(async () => {})
  return { ...utils, source: () => source }
}

const nextId = createIdFactory('evt')

function fixtureEvents() {
  return [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
      { id: nextId(), ts: 1 },
    ),
    createEvent(
      'worktree.discovered',
      { path: '/repo', branch: 'main', head: 'sha-0', isMain: true },
      { id: nextId(), ts: 2 },
    ),
  ]
}

describe('App', () => {
  it('renders the instrument shell in the curated order (ruling 6)', async () => {
    const { container } = await renderApp()

    expect(screen.getByText('THE OBSERVATORY')).toBeInTheDocument()
    expect(screen.getByText('connecting…')).toBeInTheDocument()

    // attention + burn docked top → scene → fleet → the rest → provenance bar
    // (prd4 ruling 2: the scene is the centerpiece, the table is its legend).
    const marks = [...container.querySelectorAll('h1, h2')].map((node) => node.textContent)
    expect(marks).toEqual([
      'THE OBSERVATORY',
      'Scene',
      'Fleet',
      'Ledger',
      'Collisions',
      'Activity',
    ])
    expect(screen.getByText('Attention strip')).toBeInTheDocument()
    expect(screen.getByText('Burn strip')).toBeInTheDocument()
    // The provenance bar stays docked at the bottom (ruling 15).
    expect(screen.getByText('Sources')).toBeInTheDocument()
  })

  it('surfaces connection state and folds fixture events from a mock stream', async () => {
    const { source } = await renderApp()

    act(() => source()?.open())
    await waitFor(() => expect(screen.getByText('live')).toBeInTheDocument())

    for (const event of fixtureEvents()) {
      act(() => source()?.emit(event))
    }

    // The panels here are stubs — this proves the shell folded the events
    // without crashing or losing the connection badge.
    await waitFor(() => expect(screen.getByText('live')).toBeInTheDocument())
  })

  it('can collapse and re-expand the scene slot', async () => {
    await renderApp()
    const toggle = screen.getByRole('button', { name: /collapse scene/i })

    act(() => toggle.click())
    expect(await screen.findByRole('button', { name: /expand scene/i })).toBeInTheDocument()
  })

  describe('panel focus (ruling 6)', () => {
    it('a focused panel fills the view and its siblings drop out', async () => {
      await renderApp()

      fireEvent.click(screen.getByRole('button', { name: 'Focus Fleet' }))

      expect(screen.getByRole('button', { name: 'Restore Fleet' })).toBeInTheDocument()
      expect(screen.queryByText('Ledger')).not.toBeInTheDocument()
      expect(screen.queryByText('Collisions')).not.toBeInTheDocument()
      expect(screen.queryByText('Activity')).not.toBeInTheDocument()
    })

    it('Esc precedence: an open drawer/selection closes first, then a second Esc exits focus', async () => {
      await renderApp()

      fireEvent.click(screen.getByRole('button', { name: 'Focus Fleet' }))
      expect(screen.getByRole('button', { name: 'Restore Fleet' })).toBeInTheDocument()

      fireEvent.click(screen.getByText('select lane'))
      await act(async () => {})
      expect(screen.getByTestId('lane-drawer')).toBeInTheDocument()

      // First Esc belongs to the open drawer/selection (#84's own handler) —
      // focus is untouched by the same keystroke.
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByTestId('lane-drawer')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Restore Fleet' })).toBeInTheDocument()

      // Nothing selected any more — the next Esc is free to exit focus, and
      // the curated order returns.
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.getByRole('button', { name: 'Focus Fleet' })).toBeInTheDocument()
      expect(screen.getByText('Ledger')).toBeInTheDocument()
    })
  })

  describe('the deep-linkable lane page (prd9 B1b, #135)', () => {
    const LANE_HANDLE = '42-otel-receiver'

    function laneFixtureEvents() {
      return [
        ...fixtureEvents(),
        createEvent(
          'worktree.discovered',
          { path: `/repo-wt/${LANE_HANDLE}`, branch: LANE_HANDLE, head: 'sha-1', isMain: false },
          { id: nextId(), ts: 3 },
        ),
      ]
    }

    afterEach(() => {
      window.history.replaceState(null, '', '/')
    })

    it('deep-links cold (fresh load) to a working lane page, and Esc returns to the balcony', async () => {
      window.history.replaceState(null, '', laneUrl(LANE_HANDLE))
      const { source } = await renderApp()

      act(() => source()?.open())
      for (const event of laneFixtureEvents()) act(() => source()?.emit(event))
      await waitFor(() => expect(screen.getByTestId('lane-page-header')).toBeInTheDocument())

      // The balcony never mounted at all — this is a route switch, not an overlay.
      expect(screen.queryByText('THE OBSERVATORY')).not.toBeInTheDocument()
      expect(screen.getByTestId('lane-page-branch').textContent).toBe(LANE_HANDLE)

      await act(async () => {
        fireEvent.keyDown(window, { key: 'Escape' })
      })

      expect(window.location.pathname).toBe('/')
      expect(screen.getByText('THE OBSERVATORY')).toBeInTheDocument()
    })

    it('the browser back button returns from the lane page to the balcony', async () => {
      const { source } = await renderApp()
      expect(screen.getByText('THE OBSERVATORY')).toBeInTheDocument()

      act(() => source()?.open())
      for (const event of laneFixtureEvents()) act(() => source()?.emit(event))

      // The same navigation the drawer's "open page ↗" affordance performs.
      act(() => navigate(laneUrl(LANE_HANDLE)))
      await waitFor(() => expect(screen.getByTestId('lane-page-header')).toBeInTheDocument())

      await act(async () => {
        const popped = new Promise<void>((resolve) =>
          window.addEventListener('popstate', () => resolve(), { once: true }),
        )
        window.history.back()
        await popped
      })

      expect(window.location.pathname).toBe('/')
      expect(screen.getByText('THE OBSERVATORY')).toBeInTheDocument()
    })

    it('says the honest gap for a handle no lane in this session carries — never a crash or a blank', async () => {
      window.history.replaceState(null, '', laneUrl('never-existed'))
      const { source } = await renderApp()

      act(() => source()?.open())
      for (const event of fixtureEvents()) act(() => source()?.emit(event))

      const gap = await screen.findByTestId('lane-page-unknown')
      expect(gap.textContent).toContain('never-existed')
      expect(gap.textContent).toContain('this session')
    })
  })
})