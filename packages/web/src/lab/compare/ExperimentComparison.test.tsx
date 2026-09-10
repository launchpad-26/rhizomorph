import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { LabExperiment, LabRun, LabRunOutcome } from '../types.js'
import { ExperimentComparison } from './ExperimentComparison.js'

afterEach(cleanup)

const provenance = { source: 'measure-route' as const, verifyCommand: 'npm test', measuredAt: 2000 }
function outcome(overrides: Partial<LabRunOutcome> & { verified: LabRunOutcome['verified'] }): LabRunOutcome {
  return { verifiedDetail: null, costUsd: 2, durationMs: 100, commits: 1, provenance, ...overrides }
}
function run(id: string, n: number, measured?: LabRunOutcome): LabRun {
  return { eventId: id, dispatchedAt: 1000, run: n, laneHandle: `lane-${id}`, worktreePath: '/tmp/x', ...(measured === undefined ? {} : { outcome: measured }) }
}
function arm(n: number, model: string | null, runs: LabRun[], promptDigest: string | null = null) {
  return { arm: n, treatment: { model, promptDigest }, runs }
}
function experiment(arms: LabExperiment['arms']): LabExperiment {
  return { forkId: 'fork-1', parentLane: 'feature', checkpointId: 'ckpt-1', arms }
}

/** Three arms, three runs each, all passed: cost 5/1/3, duration 300/100/200, commits 1/2/3. */
const THREE = experiment([
  arm(1, 'opus', [1, 2, 3].map((i) => run(`a${i}`, i, outcome({ verified: 'pass', costUsd: 5, durationMs: 300, commits: 1 })))),
  arm(2, 'sonnet', [1, 2, 3].map((i) => run(`b${i}`, i, outcome({ verified: 'pass', costUsd: 1, durationMs: 100, commits: 2 })))),
  arm(3, 'haiku', [1, 2, 3].map((i) => run(`c${i}`, i, outcome({ verified: 'pass', costUsd: 3, durationMs: 200, commits: 3 })))),
])

describe('ExperimentComparison — the measure switch (prd53 S2, #326)', () => {
  it('reads cost by default, and every spread is recomputed when the measure changes', () => {
    render(<ExperimentComparison experiment={THREE} />)
    expect(screen.getByTestId('comparison-surface').dataset.measure).toBe('cost')
    expect(screen.getAllByTestId('arm-spread')[0]?.textContent).toMatch(/min 5 · median 5 · max 5/)
    fireEvent.click(screen.getByTestId('measure-duration'))
    expect(screen.getByTestId('comparison-surface').dataset.measure).toBe('duration')
    expect(screen.getAllByTestId('arm-spread')[0]?.textContent).toMatch(/min 300 · median 300 · max 300/)
    expect(screen.getByTestId('comparison-basis').textContent).toMatch(/dispatch to the newest event/)
  })

  it('is one tab stop: Tab reaches the selected position, ↑/↓ move it, and Scoring is a disabled position nothing can select', () => {
    render(<ExperimentComparison experiment={THREE} />)
    const cost = screen.getByTestId('measure-cost')
    expect(cost.getAttribute('tabindex')).toBe('0')
    expect(screen.getByTestId('measure-duration').getAttribute('tabindex')).toBe('-1')
    fireEvent.keyDown(screen.getByTestId('measure-switch'), { key: 'ArrowDown' })
    expect(screen.getByTestId('comparison-surface').dataset.measure).toBe('duration')
    fireEvent.keyDown(screen.getByTestId('measure-switch'), { key: 'ArrowUp' })
    expect(screen.getByTestId('comparison-surface').dataset.measure).toBe('cost')
    const scoring = screen.getByTestId('measure-scoring')
    expect(scoring.getAttribute('aria-disabled')).toBe('true')
    expect(scoring.textContent).toBe('Scoring — no source yet')
  })

  it('under "verified" the arm reports counts once the floor is met, never a spread — and below the floor it refuses like every other measure (ruling 2, amended)', () => {
    const judged = experiment([
      arm(1, 'opus', [
        run('a1', 1, outcome({ verified: 'pass' })),
        run('a2', 2, outcome({ verified: 'fail', verifiedDetail: '1 failed' })),
        run('a3', 3, outcome({ verified: 'pass' })),
        run('a4', 4),
      ]),
    ])
    const { unmount } = render(<ExperimentComparison experiment={judged} initialMeasure="verified" />)
    expect(screen.getByTestId('arm-verified-counts').textContent).toBe('2 passed · 1 failed (n=3 completed)')
    expect(screen.getByTestId('arm-incomplete-note').textContent).toBe('3 of 4 runs completed — 1 still pending')
    expect(screen.queryByTestId('arm-spread')).toBeNull()
    unmount()

    const below = experiment([arm(1, 'opus', [run('a1', 1, outcome({ verified: 'pass' })), run('a2', 2, outcome({ verified: 'fail' })), run('a3', 3)])])
    render(<ExperimentComparison experiment={below} initialMeasure="verified" />)
    expect(screen.queryByTestId('arm-verified-counts')).toBeNull()
    expect(screen.getByTestId('arm-insufficient').textContent).toBe('2 of 3 runs completed so far — too few completed to summarise yet')
  })

  it('rows are in ARM order regardless of value, under every measure — a sorted table is a ranking', () => {
    render(<ExperimentComparison experiment={THREE} />)
    const order = () => screen.getAllByTestId('arm-panel').map((panel) => panel.dataset.armId)
    expect(order()).toEqual(['arm-1', 'arm-2', 'arm-3'])
    fireEvent.click(screen.getByTestId('measure-commits'))
    expect(order()).toEqual(['arm-1', 'arm-2', 'arm-3'])
  })

  it('an unmeasured run says "not measured yet — no outcome is invented in its place" ONCE for the two that say it (prd-55 ruling 8), and the arm below the floor refuses a summary', () => {
    const partial = experiment([arm(1, 'opus', [run('a1', 1, outcome({ verified: 'pass' })), run('a2', 2), run('a3', 3)])])
    render(<ExperimentComparison experiment={partial} />)
    // The sentence is unchanged; it is printed once, carrying the count that
    // says how many runs it speaks for, rather than twice for two runs.
    expect(screen.getByText('2 runs · not measured yet — no outcome is invented in its place')).toBeInTheDocument()
    expect(screen.queryAllByText('not measured yet — no outcome is invented in its place')).toHaveLength(0)
    expect(screen.getByTestId('arm-insufficient').textContent).toMatch(/too few completed to summarise yet/)
  })

  it('Enter on an arm expands it to its runs, Esc collapses — and every run is still there individually, whatever the summary line collapsed (prd53 ruling 1)', () => {
    render(<ExperimentComparison experiment={THREE} />)
    // Three runs that say the same thing now say it once, with their count.
    expect(screen.getAllByTestId('run-dots')[0]?.querySelectorAll('li')).toHaveLength(1)
    expect(screen.getAllByTestId('run-dots')[0]?.textContent).toContain('3 runs · all passed · 5')
    // And "n runs of one arm, shown individually, never collapsed" is unmoved:
    // each run is its own row, by its own id, in the list the toggle expands.
    const toggle = screen.getByTestId('arm-toggle-arm-1')
    fireEvent.click(toggle)
    expect(screen.getByTestId('arm-runs-arm-1').querySelectorAll('li')).toHaveLength(3)
    fireEvent.keyDown(screen.getByTestId('arm-runs-arm-1'), { key: 'Escape' })
    expect(screen.queryByTestId('arm-runs-arm-1')).toBeNull()
  })

  it('a failed arm (ruling 7) is present with its failure, excluded from every spread, and that is stated', () => {
    render(<ExperimentComparison experiment={THREE} failedArms={[{ arm: 4, error: 'workmux: tmux server not running' }]} />)
    expect(screen.getByTestId('arm-failed-4').textContent).toMatch(/failed to dispatch — workmux: tmux server not running/)
    expect(screen.getByTestId('comparison-partial').textContent).toMatch(/1 arm failed to dispatch and is excluded/)
    expect(screen.getAllByTestId('arm-spread')).toHaveLength(3)
  })

  it('carries no native title attribute anywhere — what a mark means is written beside it (#220)', () => {
    render(<ExperimentComparison experiment={THREE} />)
    expect(document.querySelectorAll('[title]')).toHaveLength(0)
  })
})
