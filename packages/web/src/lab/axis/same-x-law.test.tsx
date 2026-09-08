import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Frame } from '../frame/Frame.js'
import type { LabCheckpoint } from '../types.js'
import { markerX } from './position.js'
import { SessionAxis } from './SessionAxis.js'

afterEach(cleanup)

const checkpoint = (id: string, cut: number, length: number | null, eventIndex = 1): LabCheckpoint => ({
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
  sessionByteLength: length,
})

describe('the playhead at byte b renders at the same x in track and frame (prd53 S1 — toStrictEqual on the computed x)', () => {
  it('track and frame agree, for every width, because both call markerX', () => {
    for (const width of [600, 1000, 1440]) {
      const seated = checkpoint('c', 460, 1000)
      render(
        <>
          <SessionAxis checkpoints={[checkpoint('a', 100, 1000), seated]} seated="c" onSeat={() => {}} width={width} />
          <Frame position={1} onPosition={() => {}} seated={seated} experiments={[]} width={width} />
        </>,
      )
      const trackX = screen.getByTestId('axis-playhead').dataset.x
      const frameX = screen.getByTestId('frame-playhead').dataset.x
      expect(trackX).toStrictEqual(frameX)
      expect(Number(trackX)).toStrictEqual(markerX(seated, width))
      cleanup()
    }
  })

  it('a marker is placed by byte offset, never by wall-clock: two checkpoints captured a day apart at the same byte sit at the same x', () => {
    const early = { ...checkpoint('a', 500, 1000, 1), capturedAt: 1_000 }
    const late = { ...checkpoint('b', 500, 1000, 2), capturedAt: 86_400_000 }
    render(<SessionAxis checkpoints={[early, late]} seated={null} onSeat={() => {}} />)
    expect(screen.getByTestId('axis-marker-a').dataset.x).toStrictEqual(screen.getByTestId('axis-marker-b').dataset.x)
  })

  it('a degraded checkpoint is a marker with its reason, not an absent one', () => {
    render(<SessionAxis checkpoints={[checkpoint('moved', 500, null)]} seated={null} onSeat={() => {}} />)
    const marker = screen.getByTestId('axis-marker-moved')
    expect(marker.dataset.degraded).toBe('true')
    expect(marker.dataset.x).toBe('unknown')
    expect(marker.textContent).toMatch(/session file moved/)
  })
})
