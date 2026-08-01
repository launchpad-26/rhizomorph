import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttentionItem, Fleet } from './buildFleet.js'
import { needsYouLaneIds, nextJumpTarget, SelectionProvider, useSelection } from './selection.js'

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

/**
 * The idle-worker jump (SC2 steal #1, prd5 ruling 1+6). `needsYouLaneIds` and
 * `nextJumpTarget` are pure, so the ordering and wrap rules are pinned here
 * without a fleet, a stream or a clock — a minimal `AttentionItem` list
 * stands in for the ladder.
 */

function attentionItem(overrides: Partial<AttentionItem> & { id: string }): AttentionItem {
  return {
    laneId: null,
    label: overrides.id,
    kind: 'looping',
    rank: 'needs-you',
    forMs: null,
    evidence: 'evidence',
    inferred: false,
    ...overrides,
  }
}

function fleetOf(items: AttentionItem[]): Fleet {
  return { ladder: { rank: 'needs-you', items } } as unknown as Fleet
}

describe('needsYouLaneIds', () => {
  it('reads the ladder\'s own worst-first order, one id per lane', () => {
    const fleet = fleetOf([
      attentionItem({ id: 'broken-lane', laneId: 'lane-broken', rank: 'broken' }),
      // Two pathologies on the same lane: one id, not two.
      attentionItem({ id: 'needs-you-a', laneId: 'lane-needs-you', rank: 'needs-you' }),
      attentionItem({ id: 'needs-you-b', laneId: 'lane-needs-you', rank: 'needs-you' }),
      attentionItem({ id: 'notice-lane', laneId: 'lane-notice', rank: 'notice' }),
    ])

    expect(needsYouLaneIds(fleet)).toEqual(['lane-broken', 'lane-needs-you', 'lane-notice'])
  })

  it('skips items with no lane to jump to — a collision, a broken collector', () => {
    const fleet = fleetOf([
      attentionItem({ id: 'collision', laneId: null, kind: 'collision', rank: 'needs-you' }),
      attentionItem({ id: 'real-lane', laneId: 'lane-1', rank: 'needs-you' }),
    ])

    expect(needsYouLaneIds(fleet)).toEqual(['lane-1'])
  })

  it('is the empty list when the ladder itself is empty (ALL CLEAR)', () => {
    expect(needsYouLaneIds(fleetOf([]))).toEqual([])
  })
})

describe('nextJumpTarget', () => {
  const ids = ['a', 'b', 'c']

  it('cycles forward and wraps back to the first (worst) id', () => {
    expect(nextJumpTarget(ids, null, 1)).toBe('a')
    expect(nextJumpTarget(ids, 'a', 1)).toBe('b')
    expect(nextJumpTarget(ids, 'b', 1)).toBe('c')
    expect(nextJumpTarget(ids, 'c', 1)).toBe('a')
  })

  it('cycles backward and wraps back to the last id', () => {
    expect(nextJumpTarget(ids, null, -1)).toBe('c')
    expect(nextJumpTarget(ids, 'c', -1)).toBe('b')
    expect(nextJumpTarget(ids, 'b', -1)).toBe('a')
    expect(nextJumpTarget(ids, 'a', -1)).toBe('c')
  })

  it('treats a selection the list no longer names as "start of the list"', () => {
    expect(nextJumpTarget(ids, 'gone-lane', 1)).toBe('a')
    expect(nextJumpTarget(ids, 'gone-lane', -1)).toBe('c')
  })

  it('is null when there is nowhere to jump', () => {
    expect(nextJumpTarget([], null, 1)).toBeNull()
    expect(nextJumpTarget([], 'a', -1)).toBeNull()
  })
})

/** Stands in for the keyboard layer: it jumps, and reports whether it moved. */
function Jumper({ ids }: { ids: readonly string[] }) {
  const { selectedId, jump } = useSelection()
  return (
    <div>
      <button type="button" onClick={() => jump(ids, 1)}>
        jump forward
      </button>
      <button type="button" onClick={() => jump(ids, -1)}>
        jump backward
      </button>
      <span data-testid="jumped-to">{selectedId ?? '(none)'}</span>
    </div>
  )
}

describe('lane selection — the idle-worker jump', () => {
  it('cycles the shared selection worst-first, and wraps', () => {
    render(
      <SelectionProvider>
        <Jumper ids={['lane-1', 'lane-2', 'lane-3']} />
      </SelectionProvider>,
    )

    fireEvent.click(screen.getByText('jump forward'))
    expect(screen.getByTestId('jumped-to').textContent).toBe('lane-1')
    fireEvent.click(screen.getByText('jump forward'))
    expect(screen.getByTestId('jumped-to').textContent).toBe('lane-2')
    fireEvent.click(screen.getByText('jump forward'))
    expect(screen.getByTestId('jumped-to').textContent).toBe('lane-3')
    fireEvent.click(screen.getByText('jump forward'))
    expect(screen.getByTestId('jumped-to').textContent).toBe('lane-1')
  })

  it('walks backward on the reverse jump', () => {
    render(
      <SelectionProvider>
        <Jumper ids={['lane-1', 'lane-2', 'lane-3']} />
      </SelectionProvider>,
    )

    fireEvent.click(screen.getByText('jump backward'))
    expect(screen.getByTestId('jumped-to').textContent).toBe('lane-3')
    fireEvent.click(screen.getByText('jump backward'))
    expect(screen.getByTestId('jumped-to').textContent).toBe('lane-2')
  })

  it('behaves exactly like clicking the lane — same selection, same effects everywhere', () => {
    render(
      <SelectionProvider>
        <Jumper ids={['lane-1']} />
        <Table />
        <Scene />
      </SelectionProvider>,
    )

    fireEvent.click(screen.getByText('jump forward'))

    // The click-idiom surfaces (table highlight, scene spotlight) read the
    // jump exactly as they would a click: one shared selection, no jump-only
    // state for either to fall out of sync with.
    expect(screen.getByTestId('selected').textContent).toBe('lane-1')
    expect(screen.getByTestId('spotlight').textContent).toBe('lane-1')
  })

  it('returns false and leaves the selection untouched when nothing needs you', () => {
    function Reporter() {
      const { selectedId, jump } = useSelection()
      const [moved, setMoved] = useState<boolean | null>(null)
      return (
        <div>
          <button type="button" onClick={() => setMoved(jump([], 1))}>
            jump forward
          </button>
          <span data-testid="moved">{moved === null ? '(untried)' : String(moved)}</span>
          <span data-testid="selected-after">{selectedId ?? '(none)'}</span>
        </div>
      )
    }

    render(
      <SelectionProvider initialSelectedId="lane-already-selected">
        <Reporter />
      </SelectionProvider>,
    )

    fireEvent.click(screen.getByText('jump forward'))

    expect(screen.getByTestId('moved').textContent).toBe('false')
    expect(screen.getByTestId('selected-after').textContent).toBe('lane-already-selected')
  })
})
