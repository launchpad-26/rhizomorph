import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(row.querySelector('[data-basis="cost"]')?.textContent).toMatch(/over 1 measured run/)
    expect(screen.queryByTestId('frame-cost-fork-elsewhere')).toBeNull()
  })

  it('the scene position holds its place for wave 4 and cites the charter record, not a reversal', () => {
    render(<Frame position={3} onPosition={() => {}} seated={SEATED} experiments={[]} />)
    expect(screen.getByTestId('frame-gap-scene').textContent).toMatch(/wave 4 \(#329\)/)
    expect(screen.getByTestId('frame-gap-scene').textContent).toMatch(/coexist-by-surface/)
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
