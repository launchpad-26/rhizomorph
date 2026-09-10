import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LabCheckpoint } from '../types.js'
import { AXIS_INSET } from './position.js'
import { AXIS_EMPTY_COPY, playheadLabelPlacement, SessionAxis } from './SessionAxis.js'

afterEach(cleanup)

const checkpoint = (id: string, cut: number, eventIndex = 1): LabCheckpoint => ({
  eventId: `evt-${id}`,
  lane: 'feature',
  checkpointId: id,
  capturedAt: 1000,
  capturedBy: 'operator',
  snapshotRef: `refs/rhizomorph/checkpoints/${id}`,
  snapshotSha: 'sha',
  headSha: 'sha0',
  eventIndex,
  sessionCutByte: cut,
  sessionByteLength: 1000,
})

const THREE = [checkpoint('b', 500), checkpoint('a', 170), checkpoint('c', 820)]

describe('SessionAxis — stand in time (prd53 S1, #325)', () => {
  it('with no checkpoints, says how to make one — never a bare track', () => {
    render(<SessionAxis checkpoints={[]} seated={null} onSeat={() => {}} />)
    expect(screen.getByTestId('axis-empty').textContent).toBe(AXIS_EMPTY_COPY)
  })

  it('click seats the playhead; ←/→ step markers IN BYTE ORDER; Home/End go to the ends; Esc clears', () => {
    const onSeat = vi.fn()
    const { rerender } = render(<SessionAxis checkpoints={THREE} seated={null} onSeat={onSeat} />)
    fireEvent.click(screen.getByTestId('axis-marker-b'))
    expect(onSeat).toHaveBeenLastCalledWith('b')
    rerender(<SessionAxis checkpoints={THREE} seated="b" onSeat={onSeat} />)
    const box = screen.getByRole('listbox')
    fireEvent.keyDown(box, { key: 'ArrowRight' })
    expect(onSeat).toHaveBeenLastCalledWith('c')
    fireEvent.keyDown(box, { key: 'ArrowLeft' })
    expect(onSeat).toHaveBeenLastCalledWith('a')
    fireEvent.keyDown(box, { key: 'Home' })
    expect(onSeat).toHaveBeenLastCalledWith('a')
    fireEvent.keyDown(box, { key: 'End' })
    expect(onSeat).toHaveBeenLastCalledWith('c')
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onSeat).toHaveBeenLastCalledWith(null)
  })

  it('the fork-from-here action exists on the seated marker and nowhere else', () => {
    const fork = vi.fn()
    const { rerender } = render(<SessionAxis checkpoints={THREE} seated={null} onSeat={() => {}} onForkFromHere={fork} />)
    expect(screen.queryByTestId('axis-fork-from-here')).toBeNull()
    rerender(<SessionAxis checkpoints={THREE} seated="a" onSeat={() => {}} onForkFromHere={fork} />)
    fireEvent.click(screen.getByTestId('axis-fork-from-here'))
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ checkpointId: 'a' }))
    expect(screen.getAllByTestId('axis-fork-from-here')).toHaveLength(1)
  })

  it('a partial fork names its failed arm count at the marker (ruling 7)', () => {
    render(<SessionAxis checkpoints={THREE} seated={null} onSeat={() => {}} failedArmsByCheckpoint={{ c: 2 }} />)
    expect(screen.getByTestId('axis-marker-c').dataset.failedArms).toBe('2')
    expect(screen.getByTestId('axis-marker-c').textContent).toMatch(/fork: 2 arms failed/)
    expect(screen.getByTestId('axis-marker-a').dataset.failedArms).toBeUndefined()
  })

  it('the playhead wears its percent, and the seated line says byte of length', () => {
    render(<SessionAxis checkpoints={THREE} seated="b" onSeat={() => {}} />)
    expect(screen.getByTestId('axis-playhead').textContent).toContain('50 %')
    expect(screen.getByTestId('session-axis').textContent).toMatch(/byte 500 of 1000/)
  })
})

/**
 * S1′'s acceptance criterion, executed at a FORCED WIDTH rather than observed
 * in a screenshot: the playhead label's right edge is inside the drawing at
 * 100 % of the session. The viewBox is what the SVG scales to the viewport, so
 * a bound in viewBox units is a bound in viewport units at any zoom.
 */
describe('the playhead label stays inside the viewport (prd-55 ruling 8, S1′)', () => {
  const WIDTH = 400
  const AT_THE_END = [checkpoint('end', 1000)]

  it('at 100 % the label flips to the LEFT of the line, and its right edge is ≤ the width', () => {
    render(<SessionAxis checkpoints={AT_THE_END} seated="end" onSeat={() => {}} width={WIDTH} />)

    const label = screen.getByTestId('axis-playhead-label')
    expect(label.dataset.flipped, 'a label that would leave the drawing flips').toBe('true')
    expect(Number(label.dataset.labelRight), "the criterion itself: right edge ≤ the viewport's width").toBeLessThanOrEqual(WIDTH)
    expect(label.getAttribute('text-anchor'), 'and it is anchored at its right edge, so it grows leftward').toBe('end')
    expect(Number(label.getAttribute('x')), 'drawn on the left of its own line').toBeLessThan(Number(screen.getByTestId('axis-playhead').dataset.x))
  })

  it('and stays on the RIGHT wherever there is room — the flip is a rescue, not a rule', () => {
    render(<SessionAxis checkpoints={[checkpoint('start', 1)]} seated="start" onSeat={() => {}} width={WIDTH} />)

    const label = screen.getByTestId('axis-playhead-label')
    expect(label.dataset.flipped).toBe('false')
    expect(Number(label.dataset.labelRight)).toBeLessThanOrEqual(WIDTH)
    expect(Number(label.getAttribute('x'))).toBeGreaterThan(Number(screen.getByTestId('axis-playhead').dataset.x))
  })

  it('the placement itself: an unflipped label at the end of any width would overflow — which is why it flips', () => {
    const text = 'playhead · 100 %'
    const atTheEnd = WIDTH - AXIS_INSET
    expect(playheadLabelPlacement(atTheEnd, text, WIDTH).flipped).toBe(true)
    expect(playheadLabelPlacement(atTheEnd, text, WIDTH).right).toBeLessThanOrEqual(WIDTH)
    // Unflipped, the same label would have run past the edge by more than its gap.
    expect(atTheEnd + 8 + text.length * 6.2).toBeGreaterThan(WIDTH)
  })

  it('a flipped label never escapes the other edge either — its right edge is the line, and the line is inside the inset', () => {
    const placement = playheadLabelPlacement(AXIS_INSET, 'playhead · 0 %', 60)
    expect(placement.flipped).toBe(true)
    expect(placement.right).toBeLessThanOrEqual(60)
    expect(placement.right).toBeGreaterThan(0)
  })
})
