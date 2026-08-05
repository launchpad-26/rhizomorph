import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { compareArms } from './compare.js'
import { ComparisonSurface } from './ComparisonSurface.js'
import type { Arm, Run } from './types.js'

afterEach(cleanup)

function complete(id: string, value: number): Run {
  return { id, status: 'complete', value }
}
function pending(id: string): Run {
  return { id, status: 'pending' }
}
function failed(id: string): Run {
  return { id, status: 'failed' }
}
function arm(id: string, model: string, brief: string, runs: Run[]): Arm {
  return { id, model, brief, runs }
}

describe('ComparisonSurface', () => {
  it('law 1 — every individual run renders, always, including pending and failed ones', () => {
    const comparison = compareArms({
      arms: [arm('a', 'opus', 'brief-x', [complete('r1', 1), pending('r2'), failed('r3')])],
    })
    render(<ComparisonSurface comparison={comparison} />)

    const panel = screen.getByTestId('arm-panel')
    expect(within(panel).getByTestId('run-dots').children).toHaveLength(3)
  })

  it('law 3 — below n=3 completed runs, the arm shows its runs and an explicit voice, never a summary number', () => {
    const comparison = compareArms({ arms: [arm('c', 'haiku', 'brief-x', [complete('r1', 3), complete('r2', 5)])] })
    render(<ComparisonSurface comparison={comparison} />)

    expect(screen.queryByTestId('arm-spread')).toBeNull()
    expect(screen.getByTestId('arm-insufficient').textContent).toBe('n=2 — too few runs to summarise')
  })

  it('n>=3 completed runs renders a spread as a range, never a single collapsed number', () => {
    const comparison = compareArms({
      arms: [arm('a', 'opus', 'brief-x', [complete('r1', 4), complete('r2', 9), complete('r3', 6)])],
    })
    render(<ComparisonSurface comparison={comparison} />)

    expect(screen.getByTestId('arm-spread').textContent).toBe('spread 4–9')
    expect(screen.queryByTestId('arm-insufficient')).toBeNull()
  })

  it('law 4 — renders no winner, leading marker, or ranking anywhere in the markup', () => {
    const comparison = compareArms({
      arms: [
        arm('lo', 'opus', 'brief-x', [complete('r1', 1), complete('r2', 1), complete('r3', 1)]),
        arm('hi', 'sonnet', 'brief-x', [complete('r1', 100), complete('r2', 100), complete('r3', 100)]),
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
        arm('a', 'opus', 'brief-x', [complete('r1', 1), complete('r2', 2), complete('r3', 3)]),
        arm('b', 'sonnet', 'brief-y', [complete('r1', 4), complete('r2', 5), complete('r3', 6)]),
      ],
    })
    render(<ComparisonSurface comparison={comparison} />)

    const claim = screen.getByTestId('comparison-claim')
    expect(claim.textContent).toContain('NO COMPARATIVE CLAIM')
    expect(claim.textContent).toContain(
      'these arms differ in model and brief, so a difference cannot be attributed to either.',
    )
    // both arms still render side by side, in full
    expect(screen.getAllByTestId('arm-panel')).toHaveLength(2)
  })

  it('a partial experiment reports what is missing rather than hiding the gap', () => {
    const comparison = compareArms({
      arms: [arm('a', 'opus', 'brief-x', [complete('r1', 1), complete('r2', 2), complete('r3', 3), pending('r4')])],
    })
    render(<ComparisonSurface comparison={comparison} />)

    expect(screen.getByTestId('arm-spread').textContent).toBe('spread 1–3')
    expect(screen.getByTestId('arm-incomplete-note').textContent).toBe('3 of 4 runs completed — 1 still pending')
  })
})
