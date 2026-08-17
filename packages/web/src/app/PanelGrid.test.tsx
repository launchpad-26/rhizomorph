import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEventFactory } from '@rhizomorph/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FleetProvider } from '../fleet/FleetContext.js'
import type { FetchLike } from '../fleet/manifest.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { adoptRepoScope } from '../settings/registry.js'
import { DOCK_TABS, PANEL_IDS, PanelGrid } from './PanelGrid.js'
import { requestPanelFocus } from './panelPrefs.js'
import { StreamProvider } from './StreamContext.js'

// Stub the lazily-imported panels so this test is about the *registry* — which
// panels are mounted, in what order, and whether collapse stays per-panel —
// rather than about the real panels' internals, which each have their own
// direct-import test file.
vi.mock('../panels/fleet/index.js', () => ({ default: () => <div>Fleet rows</div> }))
vi.mock('../panels/ledger/index.js', () => ({ default: () => <div>Ledger body</div> }))
vi.mock('../panels/collisions/index.js', () => ({ default: () => <div>Collisions body</div> }))
vi.mock('../panels/feed/index.js', () => ({ default: () => <div>Activity body</div> }))
// The trace tab doubles as the *error* state's subject: S3 asks that a
// throwing tab render its honest line while the dock stays usable, and a tab
// that cannot be made to throw cannot prove it.
const traceThrows = { now: false }
vi.mock('../panels/trace/index.js', () => ({
  default: () => {
    if (traceThrows.now) throw new Error('trace tab exploded')
    return <div>Trace body</div>
  },
}))
vi.mock('../scene/index.js', () => ({ default: () => <div>Scene stub</div> }))

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
  await import('../panels/trace/index.js')
  await import('../scene/index.js')
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
  it('registers exactly two rows, both expanded by default (#552)', async () => {
    await renderGrid()

    expect(PANEL_IDS as readonly string[]).toEqual(['fleet', 'dock'])
    for (const title of ['Fleet', 'Dock']) {
      expect(screen.getByRole('button', { name: `Collapse ${title}` })).toBeInTheDocument()
    }
    // No panel starts hidden any more: the feed's collapsed-by-default peek was
    // the one exception (prd9), and prd-32 ruling 5 made the feed a TAB — S3
    // forbids a hidden tab outright, so the exception has no subject.
    expect(screen.queryByRole('button', { name: /^Expand / })).not.toBeInTheDocument()
  })

  it('mounts the panels in the conductor-curated order — the fleet, then the dock', async () => {
    const { container } = await renderGrid()

    // prd-36 ruling 1: the scene and the roster are one surface. prd-32 ruling
    // 5: the ledger, collisions and the feed are one dock. Two rows, and the
    // one heading is the fleet's own — the dock's four surfaces are named by
    // its tab strip rather than by four headings competing with it.
    const headings = [...container.querySelectorAll('h2')].map((node) => node.textContent)
    expect(headings).toEqual(['Fleet'])
    const rows = [...container.querySelectorAll('[data-surface="fleet"], [data-panel="dock"]')].map(
      (node) => node.getAttribute('data-surface') ?? node.getAttribute('data-panel'),
    )
    expect(rows).toEqual(['fleet', 'dock'])
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

    // The list is the same panel, not a second one: #562 dropped the table's
    // own duplicate `<h2>Fleet</h2>` and its duplicate border now that the
    // surface carries both, so the curated order reads identically in either
    // representation — which is what "one surface, two representations" has to
    // mean structurally rather than by description.
    expect(screen.queryByText('Scene stub')).not.toBeInTheDocument()
    expect(screen.getByText('Fleet rows')).toBeInTheDocument()
    const headings = [...container.querySelectorAll('h2')].map((node) => node.textContent)
    expect(headings).toEqual(['Fleet'])
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

  it('collapsing one panel does not affect the other', async () => {
    await renderGrid()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Fleet' }))

    expect(screen.queryByText('Fleet')).not.toBeInTheDocument()
    expect(screen.getByTestId('dock-tabs')).toBeInTheDocument()
    expect(screen.getByText('Ledger body')).toBeInTheDocument()
  })

  describe('focus (ruling 6 — one panel at a time)', () => {
    it('focusing the fleet surface fills the view, carrying whichever representation is up', async () => {
      await renderGrid()

      fireEvent.click(screen.getByRole('button', { name: 'Focus Fleet' }))

      expect(screen.getByText('Fleet')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Restore Fleet' })).toBeInTheDocument()
      expect(screen.queryByTestId('dock-tabs')).not.toBeInTheDocument()
      // The scene comes WITH the focused surface now rather than being one of
      // the siblings it displaces — one panel at a time, and the scene is not
      // a panel any more.
      expect(screen.getByText('Scene stub')).toBeInTheDocument()
      expect(screen.queryByTestId('dock-tabs')).not.toBeInTheDocument()
      // …and the toggle is still reachable while focused.
      await showFleetList()
      expect(screen.queryByText('Scene stub')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Restore Fleet' })).toBeInTheDocument()
    })

    it('restoring (the explicit control) returns the curated order', async () => {
      await renderGrid()

      fireEvent.click(screen.getByRole('button', { name: 'Focus Dock' }))
      expect(screen.queryByText('Fleet')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Restore Dock' }))

      expect(screen.getByText('Fleet')).toBeInTheDocument()
      expect(screen.getByTestId('dock-tabs')).toBeInTheDocument()
      expect(screen.getByText('Scene stub')).toBeInTheDocument()
    })

    it('Esc restores the curated order when nothing is selected', async () => {
      await renderGrid()

      fireEvent.click(screen.getByRole('button', { name: 'Focus Dock' }))
      fireEvent.keyDown(window, { key: 'Escape' })

      expect(screen.getByText('Fleet')).toBeInTheDocument()
      expect(screen.getByTestId('dock-tabs')).toBeInTheDocument()
    })

    it('restores the curated order from a focused fleet surface, scene and all', async () => {
      await renderGrid()

      fireEvent.click(screen.getByRole('button', { name: 'Focus Fleet' }))
      expect(screen.queryByTestId('dock-tabs')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Restore Fleet' }))

      expect(screen.getByText('Scene stub')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Focus Fleet' })).toBeInTheDocument()
      expect(screen.getByText('Fleet')).toBeInTheDocument()
      expect(screen.getByTestId('dock-tabs')).toBeInTheDocument()
    })

    it('FOCUS TRACE is gone from the grid entirely (prd-36 ruling 2, #562)', async () => {
      await renderGrid()

      // It was a panel with no address: no inline slot, reachable only from the
      // drawer's own `FOCUS ↗`, rendering a subset of what the run view shows.
      // prd-36 ruling 2 cut it, so there is no `Trace` heading here in any
      // state — focused or not — and no `Restore Trace` control to reach.
      // (`Trace` is a dock TAB now — a tab, not a panel with a focus frame of
      // its own, which is precisely the distinction ruling 2 drew.)
      expect(screen.queryByRole('button', { name: 'Restore Trace' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Focus Trace' })).not.toBeInTheDocument()

      // The mutation, run rather than argued: the grid's focus machinery still
      // works for a panel that has one, so the absence above is the trace
      // panel's own and not a broken renderer.
      fireEvent.click(screen.getByRole('button', { name: 'Focus Dock' }))
      expect(screen.getByRole('button', { name: 'Restore Dock' })).toBeInTheDocument()
    })

    it('a panel’s own surface can ask its frame to focus, by id', async () => {
      // The channel FOCUS TRACE used, with the id that has no home removed and
      // the one that does kept: the fleet table's `f` verb calls
      // `requestPanelFocus('fleet')` rather than drawing a second full-view of
      // its own inside a frame that does not know it is focused.
      await renderGrid()

      act(() => requestPanelFocus('fleet'))
      await act(async () => {})

      expect(screen.getByRole('button', { name: 'Restore Fleet' })).toBeInTheDocument()
      expect(screen.queryByTestId('dock-tabs')).not.toBeInTheDocument()
    })
  })


  /**
   * THE DOCK (prd-32 ruling 5 / S3, #552). Its acceptance is four claims and
   * this block is those four claims: `PanelGrid`'s curated-order tests rewritten
   * for the dock (above), **the TIDE is not a tab**, each tab reaches its own
   * surface, and the selection persists per repo.
   */
  describe('the tabbable dock (prd-32 ruling 5 / S3)', () => {
    function tabIds(): string[] {
      return screen.getAllByRole('tab').map((node) => node.getAttribute('data-testid') ?? '')
    }

    it('carries exactly four tabs, in S3’s order: spend · collisions · feed · trace', async () => {
      await renderGrid()

      expect(tabIds()).toEqual([
        'dock-tab-spend',
        'dock-tab-collisions',
        'dock-tab-feed',
        'dock-tab-trace',
      ])
      expect(screen.getAllByRole('tab').map((node) => node.textContent)).toEqual([
        'Spend',
        'Collisions',
        'Activity',
        'Trace',
      ])
    })

    it('THE TIDE IS NOT A TAB — prd-13 ruling 1, restated and held', async () => {
      await renderGrid()

      // Ruling 1: "the TIDE is the replay bar's body, never a panel", and
      // prd-32 ruling 5 carries it forward word for word — "never a tab". The
      // moment it became one it would compete with the scene for the same
      // reading, which is the exact thing ruling 1 exists to refuse.
      expect(tabIds()).not.toContain('dock-tab-tide')
      for (const label of screen.getAllByRole('tab').map((node) => node.textContent ?? '')) {
        expect(label.toLowerCase()).not.toContain('tide')
        expect(label.toLowerCase()).not.toContain('time')
      }
      // …and no TIDE dock is inside this grid in any form. It is mounted by
      // `replay/index.tsx` under `Shell`, one row below — a sibling of the
      // grid, never a child of it.
      expect(screen.queryByTestId('tide-dock')).not.toBeInTheDocument()

      // The fleet is not a tab either, for the opposite reason: it merged into
      // the scene (prd-36's own non-goals), so it is the hero ABOVE the dock.
      expect(tabIds()).not.toContain('dock-tab-fleet')
      expect(DOCK_TABS.map((tab) => tab.id)).toEqual(['spend', 'collisions', 'feed', 'trace'])
    })

    it('shows one tab body at a time, and clicking swaps it', async () => {
      await renderGrid()

      expect(screen.getByText('Ledger body')).toBeInTheDocument()
      expect(screen.queryByText('Collisions body')).not.toBeInTheDocument()

      await act(async () => {
        fireEvent.click(screen.getByTestId('dock-tab-collisions'))
      })

      expect(screen.getByText('Collisions body')).toBeInTheDocument()
      expect(screen.queryByText('Ledger body')).not.toBeInTheDocument()
    })

    it('rovers the tabindex and moves on Left/Right and Home/End', async () => {
      await renderGrid()

      const selectedTab = () => screen.getAllByRole('tab').find((n) => n.getAttribute('aria-selected') === 'true')
      // Exactly one tab in the page's Tab order at a time.
      expect(screen.getAllByRole('tab').filter((n) => n.getAttribute('tabindex') === '0')).toHaveLength(1)
      expect(selectedTab()?.getAttribute('data-testid')).toBe('dock-tab-spend')

      const tablist = screen.getByTestId('dock-tabs')
      await act(async () => {
        fireEvent.keyDown(tablist, { key: 'ArrowRight' })
      })
      expect(selectedTab()?.getAttribute('data-testid')).toBe('dock-tab-collisions')

      await act(async () => {
        fireEvent.keyDown(tablist, { key: 'End' })
      })
      expect(selectedTab()?.getAttribute('data-testid')).toBe('dock-tab-trace')
      expect(screen.getByText('Trace body')).toBeInTheDocument()

      // Wraps, rather than stopping dead at the end.
      await act(async () => {
        fireEvent.keyDown(tablist, { key: 'ArrowRight' })
      })
      expect(selectedTab()?.getAttribute('data-testid')).toBe('dock-tab-spend')

      await act(async () => {
        fireEvent.keyDown(tablist, { key: 'ArrowLeft' })
      })
      expect(selectedTab()?.getAttribute('data-testid')).toBe('dock-tab-trace')

      await act(async () => {
        fireEvent.keyDown(tablist, { key: 'Home' })
      })
      expect(selectedTab()?.getAttribute('data-testid')).toBe('dock-tab-spend')
    })

    it('ESCAPE DOES NOT CLOSE IT — it is not a dialog (S3)', async () => {
      await renderGrid()

      await act(async () => {
        fireEvent.click(screen.getByTestId('dock-tab-feed'))
      })
      expect(screen.getByText('Activity body')).toBeInTheDocument()

      await act(async () => {
        fireEvent.keyDown(screen.getByTestId('dock-tabs'), { key: 'Escape' })
        fireEvent.keyDown(window, { key: 'Escape' })
      })

      // Same tab, still open. A dock that swallowed Escape would put a third
      // meaning on a key that already clears the selection and then leaves
      // panel focus (prd3 ruling 6's one way out).
      expect(screen.getByTestId('dock-tabs')).toBeInTheDocument()
      expect(screen.getByText('Activity body')).toBeInTheDocument()
    })

    it('remembers the tab per repo, and gives each repo back its own (S3)', async () => {
      adoptRepoScope('/repos/a')
      await renderGrid()
      await act(async () => {
        fireEvent.click(screen.getByTestId('dock-tab-trace'))
      })
      expect(screen.getByText('Trace body')).toBeInTheDocument()

      // A different repo does not inherit it…
      cleanup()
      adoptRepoScope('/repos/b')
      await renderGrid()
      expect(screen.getByText('Ledger body')).toBeInTheDocument()
      await act(async () => {
        fireEvent.click(screen.getByTestId('dock-tab-collisions'))
      })

      // …and A gets its own back, which is the half a "survives a reload"
      // test alone would pass without.
      cleanup()
      adoptRepoScope('/repos/a')
      await renderGrid()
      expect(screen.getByText('Trace body')).toBeInTheDocument()
    })

    it('survives a remount — the choice is stored, not held in a component', async () => {
      adoptRepoScope('/repos/reload')
      await renderGrid()
      await act(async () => {
        fireEvent.click(screen.getByTestId('dock-tab-feed'))
      })

      cleanup()
      await renderGrid()
      expect(screen.getByText('Activity body')).toBeInTheDocument()
    })

    it('a throwing tab says so and the dock stays usable (S3’s *error* state)', async () => {
      // The one state none of the four panels could have on its own: what the
      // dock adds is that the OTHER THREE keep working while one is broken.
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
      traceThrows.now = true
      try {
        await renderGrid()
        await act(async () => {
          fireEvent.click(screen.getByTestId('dock-tab-trace'))
        })

        const line = screen.getByTestId('dock-tab-error').textContent ?? ''
        expect(line).toContain('TRACE FAILED TO RENDER')
        // Law 12: what is missing, what is unaffected, what to do next.
        expect(line).toContain('other three tabs are unaffected')

        // Usable, not merely present: the strip is still there and arrowing
        // away lands on a working surface.
        await act(async () => {
          fireEvent.keyDown(screen.getByTestId('dock-tabs'), { key: 'Home' })
        })
        expect(screen.getByText('Ledger body')).toBeInTheDocument()
        expect(screen.queryByTestId('dock-tab-error')).not.toBeInTheDocument()

        // …and going back re-mounts rather than staying tripped, so a
        // transient failure is not permanent. (Still broken here, so it says
        // so again rather than silently blanking.)
        await act(async () => {
          fireEvent.keyDown(screen.getByTestId('dock-tabs'), { key: 'End' })
        })
        expect(screen.getByTestId('dock-tab-error')).toBeInTheDocument()
      } finally {
        traceThrows.now = false
        quiet.mockRestore()
      }
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
      expect(screen.getByTestId('dock-tabs')).toBeInTheDocument()
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
