import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_IDS, PanelGrid } from './PanelGrid.js'

// Stub the lazily-imported panels so this test is about the *registry* — which
// panels are mounted, in what order, and whether collapse stays per-panel —
// rather than about the real panels' internals, which each have their own
// direct-import test file.
vi.mock('../panels/fleet/index.js', () => ({ default: () => <h2>Fleet</h2> }))
vi.mock('../panels/ledger/index.js', () => ({ default: () => <h2>Ledger</h2> }))
vi.mock('../panels/collisions/index.js', () => ({ default: () => <h2>Collisions</h2> }))
vi.mock('../panels/feed/index.js', () => ({ default: () => <h2>Activity</h2> }))
vi.mock('../scene/index.js', () => ({ default: () => <div>Scene stub</div> }))

beforeEach(() => {
  localStorage.clear()
})

afterEach(cleanup)

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
// fulfilled and there is no delay left to race. The one remaining tick —
// React's mandatory suspend-then-resume on a lazy component's first render,
// now against an already-resolved promise — is flushed deterministically
// with `act(async () => {})` instead of a timed poll, so the assertions
// that follow are plain synchronous queries with nothing left to race.
async function renderGrid() {
  await import('../panels/fleet/index.js')
  await import('../panels/ledger/index.js')
  await import('../panels/collisions/index.js')
  await import('../panels/feed/index.js')
  await import('../scene/index.js')

  const utils = render(<PanelGrid />)
  await act(async () => {})
  return utils
}

describe('PanelGrid', () => {
  it('renders every registered panel expanded by default, collisions included', async () => {
    await renderGrid()

    for (const title of ['Fleet', 'Ledger', 'Collisions', 'Activity']) {
      expect(screen.getByText(title)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: `Collapse ${title}` })).toBeInTheDocument()
    }
  })

  it('mounts the panels in the conductor-curated order, scene beneath the fleet table', async () => {
    const { container } = await renderGrid()

    // Ruling 6: fleet table → scene → the rest. The strips are docked in the
    // Shell above this grid, and the provenance bar below it.
    const headings = [...container.querySelectorAll('h2')].map((node) => node.textContent)
    expect(headings).toEqual(['Fleet', 'Scene', 'Ledger', 'Collisions', 'Activity'])
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
})
