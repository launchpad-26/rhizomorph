import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ComparisonSurface } from './ComparisonSurface.js'
import { compareArms } from './compare.js'
import type { Arm, Run } from './types.js'

afterEach(cleanup)

function passed(id: string, value: number | null): Run {
  return { id, status: 'complete', verdict: 'pass', value }
}
function failed(id: string, value: number | null, detail?: string): Run {
  return detail === undefined ? { id, status: 'complete', verdict: 'fail', value } : { id, status: 'complete', verdict: 'fail', value, detail }
}
function pending(id: string): Run {
  return { id, status: 'pending' }
}
function arm(id: string, model: string, brief: string, runs: Run[]): Arm {
  return { id, model, brief, runs }
}

describe('ComparisonSurface', () => {
  it('law 1 — every individual run renders, always, including pending and failed ones', () => {
    const comparison = compareArms({
      arms: [arm('a', 'opus', 'brief-x', [passed('r1', 1), pending('r2'), failed('r3', 2, 'gate exited 1')])],
    })
    render(<ComparisonSurface comparison={comparison} />)

    const panel = screen.getByTestId('arm-panel')
    const dots = within(panel).getByTestId('run-dots')
    expect(dots.children).toHaveLength(3)
    expect(dots.textContent).toContain('failed · 2 — gate exited 1')
  })

  it('law 3 — below n=3 completed runs, the arm shows its runs and an explicit voice, never a summary number', () => {
    const comparison = compareArms({ arms: [arm('c', 'haiku', 'brief-x', [passed('r1', 3), passed('r2', 5)])] })
    render(<ComparisonSurface comparison={comparison} />)

    expect(screen.queryByTestId('arm-spread')).toBeNull()
    expect(screen.getByTestId('arm-insufficient').textContent).toBe('n=2 — too few runs to summarise')
  })

  it('n>=3 completed runs renders a spread as a range, never a single collapsed number — with its n beside the completed count', () => {
    const comparison = compareArms({
      arms: [arm('a', 'opus', 'brief-x', [passed('r1', 4), passed('r2', 9), passed('r3', 6)])],
    })
    render(<ComparisonSurface comparison={comparison} />)

    expect(screen.getByTestId('arm-spread').textContent).toBe('min 4 · median 6 · max 9 (n=3 of 3 completed)')
    expect(screen.queryByTestId('arm-insufficient')).toBeNull()
  })

  it('the floor does not move with the measure — under "verified" a below-floor arm refuses like any other, and at the floor it counts pass and fail (ruling 2, amended)', () => {
    const below = compareArms({ arms: [arm('a', 'opus', 'brief-x', [passed('r1', 1), failed('r2', 0)])] })
    const { unmount } = render(<ComparisonSurface comparison={below} measure="verified" />)
    expect(screen.queryByTestId('arm-verified-counts')).toBeNull()
    expect(screen.getByTestId('arm-insufficient').textContent).toBe('n=2 — too few runs to summarise')
    unmount()

    const allFailed = compareArms({ arms: [arm('a', 'opus', 'brief-x', [failed('r1', 0), failed('r2', 0), failed('r3', 0)])] })
    render(<ComparisonSurface comparison={allFailed} measure="verified" />)
    expect(screen.getByTestId('arm-verified-counts').textContent).toBe('0 passed · 3 failed (n=3 completed)')
  })

  it('three judged runs with nothing booked under the measure: the floor is met, no number is invented, and the arm says so', () => {
    const comparison = compareArms({ arms: [arm('a', 'opus', 'brief-x', [passed('r1', null), passed('r2', null), passed('r3', null)])] })
    render(<ComparisonSurface comparison={comparison} measure="cost" />)

    expect(screen.queryByTestId('arm-spread')).toBeNull()
    expect(screen.queryByTestId('arm-insufficient')).toBeNull()
    expect(screen.getByTestId('arm-unbooked').textContent).toBe('3 completed — no value is booked under this measure for any of them yet')
  })

  it('law 4 — renders no winner, leading marker, or ranking anywhere in the markup', () => {
    const comparison = compareArms({
      arms: [
        arm('lo', 'opus', 'brief-x', [passed('r1', 1), passed('r2', 1), passed('r3', 1)]),
        arm('hi', 'sonnet', 'brief-x', [passed('r1', 100), passed('r2', 100), passed('r3', 100)]),
      ],
    })
    const { container } = render(<ComparisonSurface comparison={comparison} />)

    expect(container.textContent).not.toMatch(/winner|leading|best|rank/i)
    // arms stay in input order — no sort toward the higher value
    const panels = screen.getAllByTestId('arm-panel')
    expect(within(panels[0]!).getByText('opus')).toBeTruthy()
    expect(within(panels[1]!).getByText('sonnet')).toBeTruthy()
  })

  it('ruling 2 — arms differing in more than one dimension get an explicit no-comparative-claim voice, not merely a caveat beside a claim', () => {
    const comparison = compareArms({
      arms: [
        arm('a', 'opus', 'brief-x', [passed('r1', 1), passed('r2', 2), passed('r3', 3)]),
        arm('b', 'sonnet', 'brief-y', [passed('r1', 4), passed('r2', 5), passed('r3', 6)]),
      ],
    })
    render(<ComparisonSurface comparison={comparison} />)

    const claim = screen.getByTestId('comparison-claim')
    expect(claim.textContent).toContain('NO COMPARATIVE CLAIM')
    expect(claim.textContent).toContain(
      'these arms differ in model and brief — a difference cannot be attributed to either',
    )
    // both arms still render side by side, in full
    expect(screen.getAllByTestId('arm-panel')).toHaveLength(2)
  })

  it('a partial experiment reports what is missing rather than hiding the gap', () => {
    const comparison = compareArms({
      arms: [arm('a', 'opus', 'brief-x', [passed('r1', 1), passed('r2', 2), passed('r3', 3), pending('r4')])],
    })
    render(<ComparisonSurface comparison={comparison} />)

    expect(screen.getByTestId('arm-spread').textContent).toBe('min 1 · median 2 · max 3 (n=3 of 3 completed)')
    expect(screen.getByTestId('arm-incomplete-note').textContent).toBe('3 of 4 runs completed — 1 still pending')
  })
})
