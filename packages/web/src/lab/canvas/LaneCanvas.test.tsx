import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { LabExperiment, LabRun } from '../types.js'
import { LaneCanvas } from './LaneCanvas.js'

afterEach(cleanup)

function run(id: string, n: number): LabRun {
  return { eventId: id, dispatchedAt: 1000, run: n, laneHandle: `lane-${id}`, worktreePath: '/tmp/x' }
}
const TWO_BY_TWO: LabExperiment = {
  forkId: 'fork-1',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    { arm: 1, treatment: { model: 'opus', promptDigest: null }, runs: [run('a1', 1), run('a2', 2)] },
    { arm: 2, treatment: { model: 'sonnet', promptDigest: null }, runs: [run('b1', 1), run('b2', 2)] },
  ],
}

describe('LaneCanvas (prd53 ruling 5, #329)', () => {
  it('draws one organism per run and says so — the count in the picture is the count in the record', () => {
    render(<LaneCanvas experiment={TWO_BY_TWO} />)
    const svg = screen.getByTestId('lane-canvas-fork-1')
    expect(svg.dataset.organisms).toBe('4')
    expect(svg.getAttribute('aria-label')).toBe('4 organisms from 4 runs of experiment fork-1')
    expect(svg.querySelectorAll('[data-testid^="canvas-organism-"]')).toHaveLength(4)
    expect(screen.getByTestId('canvas-organism-lane-b2').dataset.state).toBe('unmeasured')
  })

  it('a failed arm is a stub, drawn and named, outside the organism count', () => {
    render(<LaneCanvas experiment={TWO_BY_TWO} failedArms={[{ arm: 3, error: 'tmux server not running' }]} />)
    const svg = screen.getByTestId('lane-canvas-fork-1')
    expect(svg.dataset.organisms).toBe('4')
    expect(svg.dataset.stubs).toBe('1')
    expect(svg.getAttribute('aria-label')).toMatch(/and 1 arm that never dispatched/)
    expect(screen.getByTestId('canvas-stub-3').querySelector('title')?.textContent).toMatch(/arm 3 never dispatched — tmux server not running/)
  })

  it('every organism wears the synthetic dash — a forked reality, never live fleet history', () => {
    render(<LaneCanvas experiment={TWO_BY_TWO} />)
    for (const path of screen.getByTestId('lane-canvas-fork-1').querySelectorAll('[data-testid^="canvas-organism-"] path')) {
      expect(path.getAttribute('stroke-dasharray')).not.toBeNull()
    }
  })
})
