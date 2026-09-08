import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LabCheckpoint } from '../types.js'
import { AXIS_EMPTY_COPY, SessionAxis } from './SessionAxis.js'

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
