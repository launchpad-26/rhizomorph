import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REPRESENTATION_INSTANCES,
  TwoRepresentations,
  representationInstance,
  type RepresentationStore,
} from './TwoRepresentations.js'

/**
 * S3's contract, held here rather than at the fleet's call site: this is the
 * component prd-36 ruling 3 says is written ONCE, so trace and history inherit
 * whatever these tests pin. Every assertion below is about the guarantee, not
 * about the fleet.
 */

afterEach(cleanup)

/** The one registered instance renders under its own declared ids. */
function renderFleetLike(store?: RepresentationStore, organism = <p>organism arm</p>) {
  return render(
    <TwoRepresentations
      surface="fleet"
      heading={<h2>Fleet</h2>}
      store={store}
      views={[
        { id: 'organism', label: 'Organism', render: () => organism },
        { id: 'list', label: 'List', render: () => <p>list arm</p> },
      ]}
    />,
  )
}

describe('the toggle', () => {
  it('opens on the first declared representation and never the other', () => {
    renderFleetLike()

    expect(screen.getByText('organism arm')).toBeInTheDocument()
    expect(screen.queryByText('list arm')).not.toBeInTheDocument()
    expect(representationInstance('fleet').representations[0]).toBe('organism')
  })

  it('renders one representation at a time, never both', () => {
    renderFleetLike()

    fireEvent.click(screen.getByTestId('fleet-representation-list'))

    expect(screen.getByText('list arm')).toBeInTheDocument()
    expect(screen.queryByText('organism arm')).not.toBeInTheDocument()
  })

  it('announces which representation is active, on both buttons', () => {
    renderFleetLike()

    expect(screen.getByTestId('fleet-representation-organism')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('fleet-representation-list')).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByTestId('fleet-representation-list'))

    expect(screen.getByTestId('fleet-representation-organism')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('fleet-representation-list')).toHaveAttribute('aria-pressed', 'true')
  })

  it('is keyboard-operable as a control, not only as a keystroke', () => {
    renderFleetLike()

    // Real buttons in a labelled group: reachable by Tab, actioned by Enter or
    // Space with no handler of our own. A `<div onClick>` would pass every
    // other assertion in this file and be unreachable without a mouse.
    const group = screen.getByRole('group', { name: 'Fleet representation' })
    const buttons = [...group.querySelectorAll('button')]
    expect(buttons.map((button) => button.tagName)).toEqual(['BUTTON', 'BUTTON'])

    buttons[1]?.focus()
    expect(document.activeElement).toBe(buttons[1])
    fireEvent.click(document.activeElement as Element)
    expect(screen.getByText('list arm')).toBeInTheDocument()
  })
})

describe('the keystroke', () => {
  it('switches representation from anywhere on the page', () => {
    renderFleetLike()

    fireEvent.keyDown(window, { key: 'v' })
    expect(screen.getByText('list arm')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'v' })
    expect(screen.getByText('organism arm')).toBeInTheDocument()
  })

  it('is the key the instance declares, and nothing near it', () => {
    renderFleetLike()

    // A test that only ever presses the right key cannot fail for the reason it
    // claims — it would pass against a handler bound to every keystroke.
    for (const key of ['b', 'n', 'f', 'a', 'Escape']) {
      fireEvent.keyDown(window, { key })
      expect(screen.getByText('organism arm')).toBeInTheDocument()
    }

    fireEvent.keyDown(window, { key: representationInstance('fleet').keystroke })
    expect(screen.getByText('list arm')).toBeInTheDocument()
  })

  it('leaves the key alone while someone is typing, and while a modifier is held', () => {
    renderFleetLike()
    const field = document.createElement('input')
    document.body.append(field)

    try {
      fireEvent.keyDown(field, { key: 'v', bubbles: true })
      expect(screen.getByText('organism arm')).toBeInTheDocument()

      for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
        fireEvent.keyDown(window, { key: 'v', ...modifier })
        expect(screen.getByText('organism arm')).toBeInTheDocument()
      }
    } finally {
      field.remove()
    }
  })

  it('stops listening once the surface unmounts', () => {
    const { unmount } = renderFleetLike()
    unmount()

    // Nothing to assert on screen; the failure this pins is a leaked window
    // listener throwing on a setState after unmount.
    expect(() => fireEvent.keyDown(window, { key: 'v' })).not.toThrow()
  })
})

describe('state outside the representations survives the switch', () => {
  it('leaves a sibling’s state untouched across a toggle', () => {
    function Host() {
      const [count, setCount] = useState(0)
      return (
        <div>
          <button type="button" onClick={() => setCount((n) => n + 1)}>
            bump
          </button>
          <span data-testid="count">{count}</span>
          <TwoRepresentations
            surface="fleet"
            views={[
              { id: 'organism', label: 'Organism', render: () => <p>organism arm</p> },
              { id: 'list', label: 'List', render: () => <p>list arm</p> },
            ]}
          />
        </div>
      )
    }

    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'bump' }))
    fireEvent.click(screen.getByRole('button', { name: 'bump' }))
    expect(screen.getByTestId('count')).toHaveTextContent('2')

    fireEvent.keyDown(window, { key: 'v' })
    fireEvent.keyDown(window, { key: 'v' })

    expect(screen.getByText('organism arm')).toBeInTheDocument()
    expect(screen.getByTestId('count')).toHaveTextContent('2')
  })
})

describe('the persistence seam', () => {
  it('opens on what the store remembers', () => {
    renderFleetLike({ read: () => 'list', write: () => {} })

    expect(screen.getByText('list arm')).toBeInTheDocument()
  })

  it('writes through on a click and on the keystroke alike', () => {
    const write = vi.fn()
    renderFleetLike({ read: () => null, write })

    fireEvent.click(screen.getByTestId('fleet-representation-list'))
    expect(write).toHaveBeenLastCalledWith('list')

    fireEvent.keyDown(window, { key: 'v' })
    expect(write).toHaveBeenLastCalledWith('organism')
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('treats a stored id this instance does not declare as unset, rather than crashing on load', () => {
    // The registry's own `accept` posture: a retired option reads as nothing
    // stored. A surface that threw here would be unopenable after a rename.
    renderFleetLike({ read: () => 'gantt', write: () => {} })

    expect(screen.getByText('organism arm')).toBeInTheDocument()
  })

  it('follows a change made elsewhere, when the store offers a signal', () => {
    const held: { value: string | null; listener: (() => void) | null } = { value: null, listener: null }
    renderFleetLike({
      read: () => held.value,
      write: (id) => {
        held.value = id
      },
      subscribe: (fn) => {
        held.listener = fn
        return () => {
          held.listener = null
        }
      },
    })

    expect(screen.getByText('organism arm')).toBeInTheDocument()
    expect(held.listener).not.toBeNull()

    // What "restore defaults" on the settings page looks like from here — a
    // store change arriving from outside React, so it needs its own flush.
    held.value = 'list'
    act(() => held.listener?.())

    expect(screen.getByText('list arm')).toBeInTheDocument()
  })

  it('declares the gap while nothing remembers the choice (law 12)', () => {
    // The fleet instance persists nothing in this wave, and says so in the
    // registry rather than in a comment nobody greps. This assertion is what
    // makes the claim removable: it fails the day `persistence` is wired,
    // which is exactly when the gap prose must go.
    const fleet = representationInstance('fleet')
    if (fleet.persistence === null) {
      expect(fleet.gap).toMatch(/not remembered/)
      expect(fleet.gap).toMatch(/settings\/registry\.ts/)
    } else {
      expect(fleet.gap).toBeNull()
    }
  })
})

describe('no representation may be selected automatically by application state', () => {
  it('holds the representation a person chose while the other one is failing', () => {
    // The case ruling 1 actually names: an instrument that switched to the list
    // because the scene broke would hide its own scene at the moment a person
    // most wants to look at it. The arm reports its own failure; the surface
    // does not move.
    function Host() {
      const [broken, setBroken] = useState(false)
      return (
        <div>
          <button type="button" onClick={() => setBroken(true)}>
            break the organism
          </button>
          <TwoRepresentations
            surface="fleet"
            views={[
              {
                id: 'organism',
                label: 'Organism',
                render: () => <p>{broken ? 'organism unavailable' : 'organism arm'}</p>,
              },
              { id: 'list', label: 'List', render: () => <p>list arm</p> },
            ]}
          />
        </div>
      )
    }

    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'break the organism' }))

    expect(screen.getByText('organism unavailable')).toBeInTheDocument()
    expect(screen.queryByText('list arm')).not.toBeInTheDocument()
    expect(screen.getByTestId('fleet-representation-organism')).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the person’s choice when the surface re-renders around it', () => {
    function Host() {
      const [tick, setTick] = useState(0)
      return (
        <div>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            tick
          </button>
          <span data-testid="tick">{tick}</span>
          <TwoRepresentations
            surface="fleet"
            views={[
              { id: 'organism', label: 'Organism', render: () => <p>organism arm</p> },
              { id: 'list', label: 'List', render: () => <p>list arm {tick}</p> },
            ]}
          />
        </div>
      )
    }

    render(<Host />)
    fireEvent.click(screen.getByTestId('fleet-representation-list'))
    fireEvent.click(screen.getByRole('button', { name: 'tick' }))

    // A fleet rebuild (the real version of this tick) must not walk the
    // representation back to the declared default.
    expect(screen.getByTestId('tick')).toHaveTextContent('1')
    expect(screen.getByText('list arm 1')).toBeInTheDocument()
  })
})

describe('the registry is not optional', () => {
  it('refuses a surface nobody declared', () => {
    const noisy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        render(
          <TwoRepresentations
            surface="trace"
            views={[
              { id: 'tree', label: 'Tree', render: () => null },
              { id: 'gantt', label: 'Gantt', render: () => null },
            ]}
          />,
        ),
      ).toThrow(/no two-representation surface is declared under trace/)
    } finally {
      noisy.mockRestore()
    }
  })

  it('refuses views that do not match what the surface declared', () => {
    const noisy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        render(
          <TwoRepresentations
            surface="fleet"
            views={[
              { id: 'list', label: 'List', render: () => null },
              { id: 'organism', label: 'Organism', render: () => null },
            ]}
          />,
        ),
      ).toThrow(/renders \[list, organism\] but declares \[organism, list\]/)
    } finally {
      noisy.mockRestore()
    }
  })

  it('declares exactly the instances that exist, each with two representations', () => {
    expect(REPRESENTATION_INSTANCES.map((instance) => instance.surface)).toEqual(['fleet'])
    for (const instance of REPRESENTATION_INSTANCES) {
      expect(instance.representations).toHaveLength(2)
      expect(instance.keystroke).toMatch(/^[a-z]$/)
    }
  })
})
