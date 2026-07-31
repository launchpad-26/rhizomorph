import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SelectionProvider, useSelection } from './selection.js'

afterEach(cleanup)

/**
 * Two surfaces, one slot. These tests are really about the invariant that makes
 * the strip, the table, the scene and the drawer able to point at the same
 * lane: there is only one selection, and Esc always drops it.
 */

/** Stands in for the attention strip: it selects. */
function Strip() {
  const { select } = useSelection()
  return (
    <button type="button" onClick={() => select('42-otel-receiver')}>
      jump to 42
    </button>
  )
}

/** Stands in for the fleet table: it toggles, and it reads. */
function Table() {
  const { selectedId, toggle } = useSelection()
  return (
    <div>
      <button type="button" onClick={() => toggle('42-otel-receiver')}>
        row 42
      </button>
      <span data-testid="selected">{selectedId ?? '(none)'}</span>
    </div>
  )
}

/** Stands in for the scene: it only ever reads. */
function Scene() {
  const { selectedId } = useSelection()
  return <span data-testid="spotlight">{selectedId ?? '(none)'}</span>
}

function renderSurfaces(initialSelectedId?: string | null) {
  return render(
    <SelectionProvider {...(initialSelectedId === undefined ? {} : { initialSelectedId })}>
      <Strip />
      <Table />
      <Scene />
    </SelectionProvider>,
  )
}

describe('lane selection', () => {
  it('is one slot: selecting on one surface moves every other one', () => {
    renderSurfaces()
    expect(screen.getByTestId('selected').textContent).toBe('(none)')

    fireEvent.click(screen.getByText('jump to 42'))

    expect(screen.getByTestId('selected').textContent).toBe('42-otel-receiver')
    expect(screen.getByTestId('spotlight').textContent).toBe('42-otel-receiver')
  })

  it('toggles a row off when it is already the selection', () => {
    renderSurfaces()

    fireEvent.click(screen.getByText('row 42'))
    expect(screen.getByTestId('selected').textContent).toBe('42-otel-receiver')

    fireEvent.click(screen.getByText('row 42'))
    expect(screen.getByTestId('selected').textContent).toBe('(none)')
  })

  it('clears on Esc, from anywhere on the page', () => {
    renderSurfaces('42-otel-receiver')
    expect(screen.getByTestId('spotlight').textContent).toBe('42-otel-receiver')

    // Not on a focused surface: Esc is a page-level way out of every narrowed
    // view (ruling 6), so it is bound to the window, not to a row.
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.getByTestId('selected').textContent).toBe('(none)')
    expect(screen.getByTestId('spotlight').textContent).toBe('(none)')
  })

  it('is inert outside a provider, so a panel can be rendered on its own', () => {
    render(<Scene />)
    expect(screen.getByTestId('spotlight').textContent).toBe('(none)')
  })
})
