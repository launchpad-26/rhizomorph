import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canvasHeightFor } from '../canvas/index.js'
import type { LabCheckpoint, LabExperiment } from '../types.js'
import { Frame } from './Frame.js'

afterEach(cleanup)

const SEATED: LabCheckpoint = {
  eventId: 'evt-1',
  lane: 'feature',
  checkpointId: 'ckpt-1',
  capturedAt: 1000,
  capturedBy: 'operator',
  snapshotRef: 'refs/rhizomorph/checkpoints/ckpt-1',
  snapshotSha: 'sha-1',
  headSha: 'sha-0',
  eventIndex: 12,
  sessionCutByte: 460,
  sessionByteLength: 1000,
}

const provenance = { source: 'measure-route' as const, verifyCommand: 'npm test', measuredAt: 2000 }
const HERE: LabExperiment = {
  forkId: 'fork-1',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    {
      arm: 1,
      treatment: { model: 'opus', promptDigest: null },
      runs: [
        { eventId: 'a', dispatchedAt: 1, run: 1, laneHandle: 'l-a', worktreePath: '/x', outcome: { verified: 'pass', verifiedDetail: null, costUsd: 2, durationMs: 1, commits: 1, provenance } },
        { eventId: 'b', dispatchedAt: 1, run: 2, laneHandle: 'l-b', worktreePath: '/x' },
      ],
    },
  ],
}

describe('Frame — one switch over five ways of looking (prd53 ruling 8, S1)', () => {
  it('keys 1–5 select the position, and each panel resolves the seated moment through the axis', () => {
    const onPosition = vi.fn()
    render(<Frame position={1} onPosition={onPosition} seated={SEATED} experiments={[]} />)
    for (const key of ['1', '2', '3', '4', '5']) {
      fireEvent.keyDown(screen.getByTestId('frame'), { key })
    }
    expect(onPosition.mock.calls.map((call) => call[0])).toEqual([1, 2, 3, 4, 5])
    expect(screen.getByTestId('frame-playhead').textContent).toContain('46 %')
  })

  it('a position without a lab route states its gap and its would-be source — never a series drawn from nothing', () => {
    render(<Frame position={1} onPosition={() => {}} seated={SEATED} experiments={[]} />)
    expect(screen.getByTestId('frame-gap-telemetry').textContent).toMatch(/states its gap/)
    expect(screen.getByTestId('frame-gap-telemetry').querySelector('[data-basis]')?.textContent).toMatch(/no lab route carries them yet/)
    expect(document.querySelectorAll('[data-figure]')).toHaveLength(0)
  })

  it('the cost position books what was spent from the seated checkpoint, with its basis, excluding unmeasured runs', () => {
    render(<Frame position={2} onPosition={() => {}} seated={SEATED} experiments={[HERE, { ...HERE, forkId: 'fork-elsewhere', checkpointId: 'ckpt-9' }]} />)
    const row = screen.getByTestId('frame-cost-fork-1')
    expect(row.querySelector('[data-figure="cost"]')?.textContent).toBe('$2.00')
    expect(row.querySelector('[data-basis="cost"]')?.textContent).toMatch(/over 1 completed run/)
    expect(screen.queryByTestId('frame-cost-fork-elsewhere')).toBeNull()
  })

  it('the scene position draws the lane canvas for the experiments forked here — one ribbon per dispatch record — and says so when there is none (ruling 5, ruling 11)', () => {
    const { rerender } = render(<Frame position={3} onPosition={() => {}} seated={SEATED} experiments={[]} />)
    expect(screen.getByTestId('frame-scene-empty')).toBeInTheDocument()
    rerender(<Frame position={3} onPosition={() => {}} seated={SEATED} experiments={[HERE]} failedArmsByFork={{ 'fork-1': [{ arm: 2, error: 'restore failed' }] }} />)
    const canvas = screen.getByTestId('lane-canvas-fork-1')
    expect(canvas.dataset.ribbons).toBe('2')
    expect(canvas.dataset.stubs).toBe('1')
    expect(screen.getByTestId('frame-scene').querySelector('[data-basis="scene"]')?.textContent).toMatch(/charter §8/)
  })

  it('mounts the canvas at the height its ribbons need — the picture\'s own function, never the frame\'s guess (prd-55 ruling 11)', () => {
    // Two runs and one stub: the height the canvas asks for, not a constant
    // and not an SVG-era stroke pitch. A frame that hands its own number back
    // reddens here, because the two numbers are only equal by construction.
    render(<Frame position={3} onPosition={() => {}} seated={SEATED} experiments={[HERE]} failedArmsByFork={{ 'fork-1': [{ arm: 2, error: 'restore failed' }] }} />)
    const canvas = screen.getByTestId('lane-canvas-fork-1')
    expect(canvas.dataset.height).toBe(String(canvasHeightFor(2, 1)))
    // …and it is a height a fan actually fits into: taller than the band's own margins.
    expect(Number(canvas.dataset.height)).toBeGreaterThan(canvasHeightFor(0, 0) - 1)
  })

  it('the divergence position reads what Trace read, or says how to make it', () => {
    const { rerender } = render(<Frame position={4} onPosition={() => {}} seated={SEATED} experiments={[]} />)
    expect(screen.getByTestId('frame-gap-divergence')).toBeInTheDocument()
    rerender(<Frame position={4} onPosition={() => {}} seated={SEATED} experiments={[]} divergence={{ armLabel: 'arm 1 · run 1', rows: 5, diverged: 2, added: 1, absent: 0 }} />)
    expect(screen.getByTestId('frame-divergence').textContent).toMatch(/2 of 5 steps diverged/)
    expect(screen.getByTestId('frame-divergence').querySelector('[data-basis]')).not.toBeNull()
  })

  it('with nothing seated, every position says to seat the playhead first', () => {
    render(<Frame position={2} onPosition={() => {}} seated={null} experiments={[HERE]} />)
    expect(screen.getByTestId('frame-panel-2').textContent).toMatch(/seat the playhead/)
    expect(screen.queryByTestId('frame-playhead')).toBeNull()
  })
})
