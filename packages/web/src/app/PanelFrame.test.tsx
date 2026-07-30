import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PanelFrame } from './PanelFrame.js'

beforeEach(() => {
  localStorage.clear()
})

afterEach(cleanup)

describe('PanelFrame', () => {
  it('renders expanded by default, with the wrapped panel visible', () => {
    render(
      <PanelFrame id="worktrees" title="Worktrees">
        <p>panel body</p>
      </PanelFrame>,
    )

    expect(screen.getByText('panel body')).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Collapse Worktrees' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('collapses on click, hiding the wrapped panel, and is keyboard-operable', async () => {
    render(
      <PanelFrame id="worktrees" title="Worktrees">
        <p>panel body</p>
      </PanelFrame>,
    )

    const toggle = screen.getByRole('button', { name: 'Collapse Worktrees' })
    toggle.focus()
    expect(toggle).toHaveFocus()

    fireEvent.click(toggle)

    expect(screen.queryByText('panel body')).not.toBeInTheDocument()
    const expandToggle = screen.getByRole('button', { name: 'Expand Worktrees' })
    expect(expandToggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(expandToggle)
    expect(screen.getByText('panel body')).toBeInTheDocument()
  })

  it('persists collapsed state across remounts (localStorage round-trip)', () => {
    const first = render(
      <PanelFrame id="ticker" title="Commit ticker">
        <p>ticker body</p>
      </PanelFrame>,
    )
    fireEvent.click(first.getByRole('button', { name: 'Collapse Commit ticker' }))
    expect(first.queryByText('ticker body')).not.toBeInTheDocument()
    first.unmount()

    const second = render(
      <PanelFrame id="ticker" title="Commit ticker">
        <p>ticker body</p>
      </PanelFrame>,
    )
    expect(second.queryByText('ticker body')).not.toBeInTheDocument()
    expect(second.getByRole('button', { name: 'Expand Commit ticker' })).toBeInTheDocument()
  })

  it('defaults the collisions panel to expanded even with unrelated stored prefs', () => {
    localStorage.setItem('observatory.panelCollapsed.v1', JSON.stringify({ worktrees: true }))

    render(
      <PanelFrame id="collisions" title="Collisions">
        <p>collision body</p>
      </PanelFrame>,
    )

    expect(screen.getByText('collision body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse Collisions' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })
})
