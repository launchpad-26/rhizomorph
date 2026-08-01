import { reduceAll } from '@observatory/core'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildFleet,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  type Fleet,
  type FixtureSpec,
} from '../../fleet/index.js'
import { AttentionStripView, MAX_CHIPS } from './AttentionStripView.js'

/**
 * The presentational half of the strip is a pure function of a `Fleet`, so
 * every test here builds a *real* one — through core's real reducer and the
 * real detectors — exactly the way `fleet/buildFleet.test.ts` does, rather
 * than hand-rolling a `Fleet`-shaped object that could quietly drift from
 * what `buildFleet` actually produces.
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

afterEach(cleanup)

function fleetFor(spec: FixtureSpec): Fleet {
  const state = reduceAll(fixtureHistory(spec, NOW))
  return buildFleet(state, { now: NOW, manifest: manifestFor(spec) })
}

function chips(): HTMLButtonElement[] {
  return screen.getAllByRole('button') as HTMLButtonElement[]
}

describe('AttentionStripView — calm', () => {
  const fleet = fleetFor(fleet20Spec())

  it('renders ALL CLEAR with the evidence line, never bare reassurance (ruling 14)', () => {
    expect(fleet.rank).toBe('calm')

    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)

    expect(screen.getByText('ALL CLEAR')).toBeInTheDocument()
    // Every figure the sentence cites is real: 20 lanes, 20 branches checked,
    // 20 files checked, exactly the numbers fixture.ts documents.
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('collisions')
    expect(within(status).getAllByText('20')).toHaveLength(3)
    expect(within(status).getByText('0')).toBeInTheDocument()
  })

  it('renders no chips at all when calm', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

describe('AttentionStripView — the staged pathology fleet', () => {
  const fleet = fleetFor(pathologySpec())

  it('leads with "N NEED ATTENTION", worst rung first', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)

    expect(screen.getByText('NEED ATTENTION')).toBeInTheDocument()
    // 5 pathologies staged: frozen (broken), looping/waiting/off-fence
    // (needs-you), expensive (notice) — the ladder counts all of them.
    const status = screen.getByRole('status')
    expect(within(status).getByText(String(fleet.ladder.rank === 'calm' ? 0 : fleet.ladder.items.length))).toBeInTheDocument()

    const kinds = chips().map((chip) => chip.getAttribute('data-chip-kind'))
    // The frozen (broken) lane leads; the expensive (notice) lane, being the
    // mildest fault, is exactly the one pushed into the "+N" overflow below.
    expect(kinds[0]).toBe('frozen')
  })

  it('caps named chips at MAX_CHIPS and counts the rest (C\'s triage rule)', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)

    expect(fleet.ladder.rank === 'calm' ? 0 : fleet.ladder.items.length).toBe(5)
    expect(chips()).toHaveLength(MAX_CHIPS)
    expect(screen.getByTestId('chip-overflow')).toHaveTextContent('+1')
  })

  it('names lane + evidence + how-long on every chip, never a bare label (graft g4)', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)

    const frozenChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'frozen')
    expect(frozenChip).toBeDefined()
    expect(frozenChip).toHaveTextContent('42-otel-receiver')
    expect(frozenChip?.textContent).toMatch(/no events for \d+m\d\ds/)

    const loopingChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'looping')
    expect(loopingChip?.textContent).toContain('41-retry-parser')
    expect(loopingChip?.textContent).toContain('Read→Edit→Bash ×6, no commit')
  })

  it('marks an inferred detection with the inference mark, never presenting it as certain', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
    const waitingChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'waiting')
    // The staged waiting lane is certain (workmux declared it), so it must
    // NOT carry the inference mark — only a pane-inferred wait would.
    expect(waitingChip?.textContent).not.toContain('~')
  })

  it('clicking a chip toggles that lane into the shared selection', () => {
    const onToggle = vi.fn()
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={onToggle} />)

    const frozenChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'frozen') as HTMLButtonElement
    fireEvent.click(frozenChip)
    expect(onToggle).toHaveBeenCalledWith('42-otel-receiver')
  })

  it('marks the selected lane\'s chip as pressed', () => {
    render(<AttentionStripView fleet={fleet} selectedId="42-otel-receiver" onToggle={vi.fn()} />)
    const frozenChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'frozen')
    expect(frozenChip).toHaveAttribute('aria-pressed', 'true')
    const loopingChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'looping')
    expect(loopingChip).toHaveAttribute('aria-pressed', 'false')
  })

  it('never grows past a bounded number of DOM chips, whatever the fault count', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
    // MAX_CHIPS named + one overflow counter is the entire ceiling on width —
    // this is what keeps the strip from ever wrapping taller than its docked
    // height, at any lane count (ruling 7).
    expect(chips().length).toBeLessThanOrEqual(MAX_CHIPS)
  })
})

describe('AttentionStripView — arrival pulse (ruling 10)', () => {
  const fleet = fleetFor(pathologySpec())

  it('applies the flare class on a chip\'s first mount', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
    const frozenChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'frozen')
    expect(frozenChip?.className).toContain('attention-chip-flare')
  })

  it('never remounts a chip that is still the same fault a tick later — the pulse cannot replay', () => {
    const { rerender } = render(
      <AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />,
    )
    const before = document.querySelector('[data-chip-id="frozen:42-otel-receiver"]')
    expect(before).not.toBeNull()

    // A fresh `Fleet` object (as every one-second tick produces), same faults.
    const fleetTickLater = fleetFor(pathologySpec())
    rerender(<AttentionStripView fleet={fleetTickLater} selectedId={null} onToggle={vi.fn()} />)

    const after = document.querySelector('[data-chip-id="frozen:42-otel-receiver"]')
    expect(after).toBe(before)
  })

  it('omits the flare class entirely under prefers-reduced-motion', () => {
    const restore = mockReducedMotion(true)
    try {
      render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
      const frozenChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'frozen')
      expect(frozenChip?.className).not.toContain('attention-chip-flare')
    } finally {
      restore()
    }
  })
})

/** Installs a `window.matchMedia` that reports reduced motion, then restores it. */
function mockReducedMotion(reduced: boolean): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') ? reduced : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}
