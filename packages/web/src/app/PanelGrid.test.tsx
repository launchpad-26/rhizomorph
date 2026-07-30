import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

describe('PanelGrid', () => {
  it('renders every panel expanded by default, collisions included', async () => {
    render(<PanelGrid />)

    expect(await screen.findByText('Worktrees')).toBeInTheDocument()
    expect(await screen.findByText('Collisions')).toBeInTheDocument()
    expect(await screen.findByText('Commit ticker')).toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'Collapse Worktrees' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse Collisions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse Commit ticker' })).toBeInTheDocument()
  })

  it('collapsing one panel does not affect the others', async () => {
    render(<PanelGrid />)

    await screen.findByText('Collisions')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Worktrees' }))

    expect(screen.queryByText('Worktrees')).not.toBeInTheDocument()
    expect(screen.getByText('Collisions')).toBeInTheDocument()
    expect(screen.getByText('Commit ticker')).toBeInTheDocument()
  })
})
