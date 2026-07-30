import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelGrid } from './PanelGrid.js'

// Same rationale as App.test.tsx: stub the lazily-imported panels so this
// test is about the grid's own collapse chrome, not the real panels'
// internals (which each have their own direct-import test file).
vi.mock('../panels/worktrees/index.js', () => ({ default: () => <h2>Worktrees</h2> }))
vi.mock('../panels/collisions/index.js', () => ({ default: () => <h2>Collisions</h2> }))
vi.mock('../panels/ticker/index.js', () => ({ default: () => <div>Commit ticker</div> }))

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
  await import('../panels/worktrees/index.js')
  await import('../panels/collisions/index.js')
  await import('../panels/ticker/index.js')

  const utils = render(<PanelGrid />)
  await act(async () => {})
  return utils
}

describe('PanelGrid', () => {
  it('renders every panel expanded by default, collisions included', async () => {
    await renderGrid()

    expect(screen.getByText('Worktrees')).toBeInTheDocument()
    expect(screen.getByText('Collisions')).toBeInTheDocument()
    expect(screen.getByText('Commit ticker')).toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'Collapse Worktrees' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse Collisions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse Commit ticker' })).toBeInTheDocument()
  })

  it('collapsing one panel does not affect the others', async () => {
    await renderGrid()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Worktrees' }))

    expect(screen.queryByText('Worktrees')).not.toBeInTheDocument()
    expect(screen.getByText('Collisions')).toBeInTheDocument()
    expect(screen.getByText('Commit ticker')).toBeInTheDocument()
  })
})
