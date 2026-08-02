import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SelectionProvider } from '../fleet/index.js'
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
    localStorage.setItem('rhizomorph.panelCollapsed.v1', JSON.stringify({ worktrees: true }))

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

  describe('focus (ruling 6)', () => {
    it('fills the view on Focus, and restores on the same control', () => {
      render(
        <PanelFrame id="fleet" title="Fleet">
          <p>fleet body</p>
        </PanelFrame>,
      )

      const focusToggle = screen.getByRole('button', { name: 'Focus Fleet' })
      expect(focusToggle).toHaveAttribute('aria-pressed', 'false')
      // While not focused, the collapse control still shares the row.
      expect(screen.getByRole('button', { name: 'Collapse Fleet' })).toBeInTheDocument()

      fireEvent.click(focusToggle)

      const restoreToggle = screen.getByRole('button', { name: 'Restore Fleet' })
      expect(restoreToggle).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByText('fleet body')).toBeInTheDocument()
      // Focused fills the view alone — collapse doesn't make sense mid-focus.
      expect(screen.queryByRole('button', { name: /collapse fleet/i })).not.toBeInTheDocument()

      fireEvent.click(restoreToggle)

      expect(screen.getByRole('button', { name: 'Focus Fleet' })).toHaveAttribute(
        'aria-pressed',
        'false',
      )
      expect(screen.getByText('fleet body')).toBeInTheDocument()
    })

    it('restores on Esc when nothing is selected', () => {
      render(
        <PanelFrame id="fleet" title="Fleet">
          <p>fleet body</p>
        </PanelFrame>,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Focus Fleet' }))
      expect(screen.getByRole('button', { name: 'Restore Fleet' })).toBeInTheDocument()

      fireEvent.keyDown(window, { key: 'Escape' })

      expect(screen.getByRole('button', { name: 'Focus Fleet' })).toBeInTheDocument()
    })

    it('Esc precedence: an open selection consumes the keystroke before focus exits', () => {
      render(
        <SelectionProvider initialSelectedId="42-otel-receiver">
          <PanelFrame id="fleet" title="Fleet">
            <p>fleet body</p>
          </PanelFrame>
        </SelectionProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Focus Fleet' }))
      expect(screen.getByRole('button', { name: 'Restore Fleet' })).toBeInTheDocument()

      // One selection still open: this Esc belongs to clearing it (the
      // drawer's own job, ruling 6), not to exiting focus.
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.getByRole('button', { name: 'Restore Fleet' })).toBeInTheDocument()

      // Selection now clear (as `SelectionProvider`'s own handler would have
      // just done) — the next Esc is free to exit focus.
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.getByRole('button', { name: 'Focus Fleet' })).toBeInTheDocument()
    })

    it('focusing a collapsed panel expands it for the duration, then restores to collapsed', () => {
      render(
        <PanelFrame id="fleet" title="Fleet">
          <p>fleet body</p>
        </PanelFrame>,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Collapse Fleet' }))
      expect(screen.queryByText('fleet body')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Focus Fleet' }))
      expect(screen.getByText('fleet body')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Restore Fleet' }))

      // Back to its prior collapsed state — never persisted as expanded just
      // because focus needed to show it for a while.
      expect(screen.queryByText('fleet body')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Expand Fleet' })).toBeInTheDocument()
    })

    it('a hidden panel (a sibling is focused elsewhere) renders nothing at all', () => {
      render(
        <PanelFrame id="fleet" title="Fleet" hidden>
          <p>fleet body</p>
        </PanelFrame>,
      )

      expect(screen.queryByText('fleet body')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /fleet/i })).not.toBeInTheDocument()
    })

    it('tells a coordinator when its own focus flips', () => {
      const changes: boolean[] = []
      render(
        <PanelFrame id="fleet" title="Fleet" onFocusChange={(focused) => changes.push(focused)}>
          <p>fleet body</p>
        </PanelFrame>,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Focus Fleet' }))
      fireEvent.click(screen.getByRole('button', { name: 'Restore Fleet' }))

      expect(changes).toEqual([true, false])
    })
  })
})
