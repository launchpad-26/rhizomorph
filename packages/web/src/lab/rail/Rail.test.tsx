import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RAIL_STATES } from './fixtures.js'
import { Rail, type RailProps } from './Rail.js'

afterEach(cleanup)

function draw(state: keyof typeof RAIL_STATES, overrides: Partial<RailProps> = {}) {
  return render(<Rail {...(RAIL_STATES[state] as RailProps)} {...overrides} />)
}

/**
 * THE STATES FIRST (prd-55 ruling 9). Each of these draws a state from
 * `fixtures.ts` and reads what the rail says in it; the live state is the last
 * one, not the first.
 */
describe('the rail draws every state before its live one (ruling 9)', () => {
  it('no checkpoints: a successful read of nothing says how to capture one, and never that the lab cannot see', () => {
    draw('no-checkpoints')
    expect(screen.getByTestId('lab-checkpoints-empty')).toHaveTextContent('there are no checkpoints yet — capture one with')
    expect(screen.queryByTestId('lab-checkpoints-error')).toBeNull()
    expect(screen.getByTestId('lab-experiments-empty')).toHaveTextContent('there are no experiments yet — fork a checkpoint with')
  })

  it('checkpoints but no experiments: the checkpoints list, and only the experiments region says it is empty', () => {
    draw('checkpoints-no-experiments')
    expect(screen.getAllByTestId(/^lab-checkpoint-row-/)).toHaveLength(2)
    expect(screen.getByTestId('lab-experiments-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('lab-checkpoints-empty')).toBeNull()
  })

  it('degraded: a checkpoint whose session file moved is a row WITH ITS REASON, never a row that is missing', () => {
    draw('degraded')
    expect(screen.getByTestId('lab-checkpoint-row-ckpt-3')).toHaveTextContent('session file moved — position unknown')
  })

  it('loading: each region says it is reading, and neither says it is empty', () => {
    draw('loading')
    expect(screen.getByTestId('lab-rail-checkpoints-loading')).toBeInTheDocument()
    expect(screen.getByTestId('lab-rail-experiments-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('lab-checkpoints-empty')).toBeNull()
    expect(screen.queryByTestId('lab-experiments-empty')).toBeNull()
  })

  it('error: a failed read says the lab CANNOT SEE — never the empty sentence, in either region (S1′: per region, never conflated)', () => {
    draw('error')
    expect(screen.getByTestId('lab-checkpoints-error')).toHaveTextContent('the lab cannot see its checkpoints — HTTP 500')
    expect(screen.getByTestId('lab-rail-experiments-error')).toHaveTextContent('the lab cannot see its experiments')
    expect(screen.queryByTestId('lab-checkpoints-empty')).toBeNull()
    expect(screen.queryByTestId('lab-experiments-empty')).toBeNull()
  })

  it('partial: the row carries *2 of 3 arms* — the arms the launch asked for, beside the arms that ran', () => {
    draw('partial')
    expect(screen.getByTestId('lab-rail-partial-fork-7be2')).toHaveTextContent('2 of 3 arms')
  })

  it('live: one row per checkpoint and one per experiment, the experiment row carrying arms · runs · verdict counts', () => {
    draw('experiment-selected')
    expect(screen.getByTestId('lab-checkpoint-row-ckpt-1')).toHaveTextContent('46 % of session · operator')
    const row = screen.getByTestId('lab-experiment-row-fork-a1d1')
    expect(row).toHaveTextContent('2 arms · 6 runs')
    expect(row).toHaveTextContent('3 passed · 1 failed · 2 unmeasured')
    expect(screen.queryByTestId('lab-rail-partial-fork-a1d1')).toBeNull()
  })
})

describe('the rail selects', () => {
  it('the seated checkpoint and the open experiment are the pressed rows — one raised surface, not two', () => {
    draw('experiment-selected')
    expect(screen.getByTestId('lab-checkpoint-row-ckpt-1').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('lab-experiment-row-fork-a1d1').getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking a row seats a checkpoint or opens an experiment, and tells the workspace which', () => {
    const onSeat = vi.fn()
    const onSelectExperiment = vi.fn()
    draw('experiment-selected', { onSeat, onSelectExperiment })

    fireEvent.click(screen.getByTestId('lab-checkpoint-row-ckpt-1'))
    fireEvent.click(screen.getByTestId('lab-experiment-row-fork-a1d1'))

    expect(onSeat).toHaveBeenCalledWith('ckpt-1')
    expect(onSelectExperiment).toHaveBeenCalledWith('fork-a1d1')
  })

  it('↓ and ↑ move within one list and wrap, so the rail is walkable without a mouse', () => {
    draw('checkpoints-no-experiments')
    const list = screen.getByRole('list', { name: 'checkpoints' })
    const rows = screen.getAllByTestId(/^lab-checkpoint-row-/)

    rows[0]?.focus()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1])
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows[1])
  })

  it('no native title anywhere — what a row means is written in it (#220, prd-30 w1)', () => {
    const { container } = draw('partial')
    expect(container.querySelectorAll('[title]')).toHaveLength(0)
  })
})
