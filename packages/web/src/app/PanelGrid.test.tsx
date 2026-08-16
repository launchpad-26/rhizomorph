import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEventFactory } from '@rhizomorph/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FleetProvider } from '../fleet/FleetContext.js'
import type { FetchLike } from '../fleet/manifest.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { PANEL_IDS, PanelGrid } from './PanelGrid.js'
import { requestPanelFocus } from './panelPrefs.js'
import { StreamProvider } from './StreamContext.js'

// Stub the lazily-imported panels so this test is about the *registry* — which
// panels are mounted, in what order, and whether collapse stays per-panel —
// rather than about the real panels' internals, which each have their own
// direct-import test file.
vi.mock('../panels/fleet/index.js', () => ({ default: () => <h2>Fleet</h2> }))
vi.mock('../panels/ledger/index.js', () => ({ default: () => <h2>Ledger</h2> }))
vi.mock('../panels/collisions/index.js', () => ({ default: () => <h2>Collisions</h2> }))
vi.mock('../panels/feed/index.js', () => ({ default: () => <h2>Activity</h2> }))
vi.mock('../scene/index.js', () => ({ default: () => <div>Scene stub</div> }))
// prd9 B1a: the real content needs `StreamProvider`/`SelectionProvider`, which
// this file deliberately doesn't wire up (see the comment above) — the grid's
// own focus chrome (`FocusableTrace`) is what's under test here, not the
// gantt's real data.
vi.mock('../trace/FocusPanel.js', () => ({ default: () => <h2>Trace</h2> }))

// Mocking the lazy modules (above) makes their dynamic import() trivial, but
// it's still a real import() — React.lazy still suspends for at least one
// promise-resolution tick before the panels commit. `findByText`/`waitFor`
// race that tick against a fixed default deadline (1000ms), and under CPU
// contention (several suites' processes fighting for the same cores) that
// tick's wall-clock cost is whatever the scheduler feels like, which can
// occasionally outrun the deadline. Preloading resolves each mocked module's
// import() *before* mounting (an unbounded await with no deadline of its
// own — it simply waits as long as it takes), so by the time PanelGrid's
// `lazy()` calls the same import() specifier, the module record is already
// fulfilled and there is no delay left to race.
//
// That resolution is a one-time cost per file (module records are cached
// after the first import()), so it belongs in `beforeAll` rather than inside
// the first test's own body — a test's 5s timeout should cover its own
// assertions, not a cold import it happens to be first to trigger.
beforeAll(async () => {
  await import('../panels/fleet/index.js')
  await import('../panels/ledger/index.js')
  await import('../panels/collisions/index.js')
  await import('../panels/feed/index.js')
  await import('../scene/index.js')
  await import('../trace/FocusPanel.js')
})

beforeEach(() => {
  localStorage.clear()
})

afterEach(cleanup)

/** Pinned, so `FleetProvider`'s derived fleet never moves under a test. */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

/** A server that has not shipped `.swarm/lanes.json` — not this file's concern. */
const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

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
 * The one remaining tick — React's mandatory suspend-then-resume on a lazy
 * component's first render, now against an already-resolved promise — is
 * flushed deterministically with `act(async () => {})` instead of a timed
 * poll, so the assertions that follow are plain synchronous queries with
 * nothing left to race.
 *
 * `PanelGrid` reads `useStream`/`useFleet` now (the balcony pointer, #257),
 * so every render needs both providers underneath it. By default a worktree
 * is discovered before the first assertion runs — the curated-order and
 * focus tests below are about the panels, not about the empty-fold pointer,
 * and a stray "nothing is flowing yet" line would otherwise sit in every one
 * of them. Pass `emitWorktree: false` for the pointer's own tests.
 */
async function renderGrid({ emitWorktree = true }: { emitWorktree?: boolean } = {}) {
  let source: FakeEventSource | undefined
  const utils = render(
    <StreamProvider
      url="/api/stream"
      now={NOW}
      createSource={() => {
        source = new FakeEventSource()
        return source
      }}
    >
      <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
        <PanelGrid />
      </FleetProvider>
    </StreamProvider>,
  )
  await act(async () => {})
  if (emitWorktree) {
    await act(async () => {
      source?.open()
      source?.emit(createEventFactory().worktreeDiscovered())
    })
  }
  return { ...utils, source: () => source }
}

/**
 * The fleet surface opens on the organism (prd-36 ruling 1), so a test that
 * wants the roster asks for it with the surface's own keystroke — awaited,
 * because the list arm is behind `lazy()` and React insists on one
 * suspend-then-resume tick the first time it mounts, exactly as the mocked
 * panels above do.
 */
async function showFleetList() {
  await act(async () => {
    fireEvent.keyDown(window, { key: 'v' })
  })
}

describe('PanelGrid', () => {
  it('renders every registered panel expanded by default, collisions included', async () => {
    await renderGrid()

    for (const title of ['Fleet', 'Ledger', 'Collisions']) {
      expect(screen.getByText(title)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: `Collapse ${title}` })).toBeInTheDocument()
    }
  })

  it('starts Activity collapsed to a header-and-latest-line peek (prd9 legibility)', async () => {
    await renderGrid()

    expect(screen.getByRole('button', { name: 'Expand Activity' })).toBeInTheDocument()
    // The peek still says something rather than vanishing — same title, no filter row.
    expect(screen.getByText('Activity')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Filter by kind' })).not.toBeInTheDocument()
  })

  it('mounts the panels in the conductor-curated order, the fleet surface first', async () => {
    const { container } = await renderGrid()

    // prd-36 ruling 1: the scene and the roster are one surface now, so the
    // hero is a single `Fleet` row rather than a scene above its legend. The
    // strips are docked in the Shell above this grid, and the provenance bar
    // below it.
    const headings = [...container.querySelectorAll('h2')].map((node) => node.textContent)
    expect(headings).toEqual(['Fleet', 'Ledger', 'Collisions', 'Activity'])
    // …and the organism is what it opens on, inside that one frame.
    expect(screen.getByText('Scene stub')).toBeInTheDocument()
  })

  it('registers the fleet surface once, with no scene panel beside it', async () => {
    await renderGrid()

    // The merge, read off the registry rather than off the screen: `scene` was
    // a row here (its own collapse key, its own focus affordance) and is not
    // one any more — it is a representation of `fleet`.
    expect(PANEL_IDS as readonly string[]).not.toContain('scene')
    expect(PANEL_IDS as readonly string[]).toContain('fleet')
    expect(screen.queryByRole('button', { name: /focus scene/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /collapse scene/i })).not.toBeInTheDocument()
  })

  it('switches the hero’s representation on one keystroke, inside the same panel', async () => {
    const { container } = await renderGrid()

    await showFleetList()

    // The stubbed fleet table brings an `<h2>Fleet</h2>` of its own until wave
    // 2 drops it (see `FleetSurface.tsx`), so the heading list gains one — what
    // matters here is that no row was added or removed from the curated order.
    expect(screen.queryByText('Scene stub')).not.toBeInTheDocument()
    const headings = [...container.querySelectorAll('h2')].map((node) => node.textContent)
    expect(headings).toEqual(['Fleet', 'Fleet', 'Ledger', 'Collisions', 'Activity'])
  })

  it('no longer mounts the panels prd3 dissolved', async () => {
    await renderGrid()

    // worktrees → the fleet table (#78), ticker → the feed (#79), spend → the
    // burn strip plus the ledger (#80). Their directories still exist; the
    // shell just does not register them any more.
    expect(screen.queryByText('Worktrees')).not.toBeInTheDocument()
    expect(screen.queryByText('Commit ticker')).not.toBeInTheDocument()
    expect(screen.queryByText('Spend ticker')).not.toBeInTheDocument()
    for (const dissolved of ['worktrees', 'ticker', 'spend']) {
      expect(PANEL_IDS as readonly string[]).not.toContain(dissolved)
    }
  })

  it('collapsing one panel does not affect the others', async () => {
    await renderGrid()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Fleet' }))

    expect(screen.queryByText('Fleet')).not.toBeInTheDocument()
    expect(screen.getByText('Ledger')).toBeInTheDocument()
    expect(screen.getByText('Collisions')).toBeInTheDocument()
    expect(screen.getByText('Activity')).toBeInTheDocument()
  })

  describe('focus (ruling 6 — one panel at a time)', () => {
    it('focusing the fleet surface fills the view, carrying whichever representation is up', async () => {
      await renderGrid()

      fireEvent.click(screen.getByRole('button', { name: 'Focus Fleet' }))

      expect(screen.getByText('Fleet')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Restore Fleet' })).toBeInTheDocument()
      expect(screen.queryByText('Ledger')).not.toBeInTheDocument()
      expect(screen.queryByText('Collisions')).not.toBeInTheDocument()
      expect(screen.queryByText('Activity')).not.toBeInTheDocument()
      // The scene comes WITH the focused surface now rather than being one of
      // the siblings it displaces — one panel at a time, and the scene is not
      // a panel any more.
      expect(screen.getByText('Scene stub')).toBeInTheDocument()
      // …and the toggle is still reachable while focused.
      await showFleetList()
      expect(screen.queryByText('Scene stub')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Restore Fleet' })).toBeInTheDocument()
    })

    it('restoring (the explicit control) returns the curated order', async () => {
      await renderGrid()

      fireEvent.click(screen.getByRole('button', { name: 'Focus Ledger' }))
      fireEvent.click(screen.getByRole('button', { name: 'Restore Ledger' }))

      for (const title of ['Fleet', 'Ledger', 'Collisions', 'Activity']) {
        expect(screen.getByText(title)).toBeInTheDocument()
      }
      expect(screen.getByText('Scene stub')).toBeInTheDocument()
    })

    it('Esc restores the curated order when nothing is selected', async () => {
      await renderGrid()

      fireEvent.click(screen.getByRole('button', { name: 'Focus Collisions' }))
      fireEvent.keyDown(window, { key: 'Escape' })

      for (const title of ['Fleet', 'Ledger', 'Collisions', 'Activity']) {
        expect(screen.getByText(title)).toBeInTheDocument()
      }
    })

    it('restores the curated order from a focused fleet surface, scene and all', async () => {
      await renderGrid()

      fireEvent.click(screen.getByRole('button', { name: 'Focus Fleet' }))
      expect(screen.queryByText('Ledger')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Restore Fleet' }))

      expect(screen.getByText('Scene stub')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Focus Fleet' })).toBeInTheDocument()
      for (const title of ['Fleet', 'Ledger', 'Collisions', 'Activity']) {
        expect(screen.getByText(title)).toBeInTheDocument()
      }
    })

    it('FOCUS TRACE (prd9 B1a): drawn nowhere in the curated order, requested externally, and behaves exactly like every other focus', async () => {
      await renderGrid()

      // No inline slot at all — unlike every other panel, trace has nothing to
      // show until it is focused (the compact tree already lives in the
      // drawer).
      expect(screen.queryByText('Trace')).not.toBeInTheDocument()

      // The drawer's own `FOCUS ↗` button is what calls this in the real app —
      // this test drives the same request without mounting the drawer.
      act(() => requestPanelFocus('trace'))
      await act(async () => {})

      // Both the focus chrome's own header and the (mocked) gantt content say
      // "Trace" — two elements, not zero, is the thing under test.
      expect(screen.getAllByText('Trace')).toHaveLength(2)
      expect(screen.getByRole('button', { name: 'Restore Trace' })).toBeInTheDocument()
      expect(screen.queryByText('Fleet')).not.toBeInTheDocument()
      expect(screen.queryByText('Ledger')).not.toBeInTheDocument()
      expect(screen.queryByText('Scene stub')).not.toBeInTheDocument()

      fireEvent.keyDown(window, { key: 'Escape' })

      expect(screen.queryByText('Trace')).not.toBeInTheDocument()
      expect(screen.getByText('Fleet')).toBeInTheDocument()
      expect(screen.getByText('Scene stub')).toBeInTheDocument()
    })
  })

  describe('the balcony pointer (prd19 ruling 1 — "one quiet pointer from the empty balcony")', () => {
    it('points at Connect when the fold has no lanes and no worktrees', async () => {
      await renderGrid({ emitWorktree: false })

      expect(screen.getByText(/nothing is flowing yet/i)).toBeInTheDocument()
      const link = screen.getByRole('link', { name: 'Connect' })
      expect(link).toHaveAttribute('href', '/connect')

      // Every panel's own existing empty state is still drawn underneath it —
      // this is a pointer, not an interstitial replacing the grid (ruling 1).
      expect(screen.getByText('Fleet')).toBeInTheDocument()
      expect(screen.getByText('Scene stub')).toBeInTheDocument()
    })

    it('is absent once any worktree is discovered', async () => {
      await renderGrid()

      expect(screen.queryByText(/nothing is flowing yet/i)).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Connect' })).not.toBeInTheDocument()
    })

    it('disappears the moment the first worktree is discovered, without a remount', async () => {
      const { source } = await renderGrid({ emitWorktree: false })
      expect(screen.getByText(/nothing is flowing yet/i)).toBeInTheDocument()

      await act(async () => {
        source()?.emit(createEventFactory().worktreeDiscovered())
      })

      expect(screen.queryByText(/nothing is flowing yet/i)).not.toBeInTheDocument()
    })
  })
})
