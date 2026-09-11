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

  /**
   * prd-14 ruling 5, #214 review rounds 2 and 3 — the reopened-artifact case:
   * a stored `Run.value` is a resolved number with no record of which
   * measure produced it, and `measure={null}` is how that gap reaches this
   * component.
   *
   * ROUND 2 caught a wrong LABEL: falling back to `cost` printed a false
   * unit on real numbers (a duration of 300 shown as `data-measure="cost"`).
   * The first fix kept the numeric spread and only dropped the label.
   *
   * ROUND 3 caught the fix's own defect — a wrong STATISTIC, worse than the
   * label it replaced because a reader cannot tell it is wrong. A `verified`
   * comparison's `Run.value` is `1`/`0` (fromExperiment's own encoding, never
   * a quantity), and the label-only fix still ran those numbers through the
   * ordinary min/median/max renderer: a real, formally-valid-looking spread
   * computed over pass/fail booleans, indistinguishable from a genuine cost
   * or duration spread. Measured before this fix: three runs pass/fail/pass
   * rendered `min 0 · median 1 · max 1` with no marker that anything was
   * wrong. Fixed by taking ruling 3's own "below the floor" vocabulary
   * unconditionally when the measure is unknown — no summary, an explicit
   * reason, every run still shown by verdict alone.
   */
  describe('measure={null} — the reopened-artifact case: no number this surface cannot name the unit of', () => {
    it('never claims a measure it does not have — no data-measure attribute, no measure switch, an explicit "not recorded" basis line', () => {
      const comparison = compareArms({ arms: [arm('a', 'opus', 'brief-x', [passed('r1', 300), passed('r2', 300), passed('r3', 300)])] })
      // `onMeasureChange` is passed DELIBERATELY, and it is the whole point of
      // this line: without it the switch is absent because no handler was
      // given, so the assertion below held for a reason that has nothing to do
      // with `measure` being null and stayed green when that guard was deleted
      // (found by mutation, review of #422). Offering the handler is what makes
      // `measure === null` the only thing suppressing the switch.
      render(<ComparisonSurface comparison={comparison} measure={null} onMeasureChange={() => {}} />)

      expect(screen.getByTestId('comparison-surface').hasAttribute('data-measure')).toBe(false)
      expect(screen.queryByTestId('measure-switch')).toBeNull()
      expect(screen.getByTestId('comparison-basis').textContent).toBe(
        'measure not recorded — this artifact does not carry which measure produced these values, so no summary is shown for any arm; each run below still shows its own verdict',
      )
    })

    /**
     * THE MUTATION THE REVIEWER ASKED FOR, NAMED EXACTLY: a saved `verified`
     * comparison, reopened, must not render a numeric spread. `passed('r1',
     * 1)`/`failed('r2', 0)`/`passed('r3', 1)` is precisely `fromExperiment`'s
     * own `verified` encoding — the shape that is REACHABLE in one operator
     * act (switch to verified, save, reopen), not a contrived input. Reverting
     * the `measure === null` branch in `ArmPanel` — falling back to the
     * `arm.spread !== null` branch the way round 2's fix did — reddens this:
     * `arm-spread` would exist and read `min 0 · median 1 · max 1`.
     */
    it('a saved "verified" comparison, reopened, renders no numeric spread and no verified counts — an explicit "no summary" reason instead', () => {
      const comparison = compareArms({ arms: [arm('a', 'opus', 'brief-x', [passed('r1', 1), failed('r2', 0), passed('r3', 1)])] })
      render(<ComparisonSurface comparison={comparison} measure={null} />)

      expect(screen.queryByTestId('arm-spread')).toBeNull()
      expect(screen.queryByTestId('arm-verified-counts')).toBeNull()
      expect(screen.queryByTestId('arm-unbooked')).toBeNull()
      const reason = screen.getByTestId('arm-basis-unknown')
      expect(reason.textContent).toBe(
        '3 completed — no summary: the measure this was saved under is not recorded, so a spread or a count here would claim a unit this artifact does not carry',
      )
    })

    it('every run still renders, by verdict alone — never the raw value a spread cannot be trusted to summarise', () => {
      const comparison = compareArms({ arms: [arm('a', 'opus', 'brief-x', [passed('r1', 300), failed('r2', 150, 'gate exited 1')])] })
      render(<ComparisonSurface comparison={comparison} measure={null} />)

      const dots = screen.getByTestId('run-dots')
      expect(dots.textContent).toContain('passed')
      expect(dots.textContent).toContain('failed — gate exited 1')
      expect(dots.textContent).not.toMatch(/300|150/)
    })

    it('a pending run still says why, unaffected by the unknown basis', () => {
      const comparison = compareArms({ arms: [arm('a', 'opus', 'brief-x', [passed('r1', 1), failed('r2', 0), pending('r3')])] })
      render(<ComparisonSurface comparison={comparison} measure={null} />)

      expect(screen.getByTestId('run-dots').textContent).toContain('pending')
    })
  })
})

/**
 * prd-55 ruling 8's two claims about this surface, executed. Both are laws
 * about PLACEMENT and REPETITION rather than about numbers: the numbers were
 * already right, and were already hard to read.
 */
describe('a run’s identical notes collapse to one line per arm (prd-55 ruling 8)', () => {
  it('three runs that say the same thing say it once, with the count that says how many', () => {
    const comparison = compareArms({ arms: [arm('a', 'opus', 'brief-x', [passed('r1', null), passed('r2', null), passed('r3', null)])] })
    render(<ComparisonSurface comparison={comparison} />)

    const dots = within(screen.getByTestId('arm-panel')).getByTestId('run-dots')
    expect(dots.children).toHaveLength(1)
    expect(dots.textContent).toContain('3 runs · all passed · no value booked under this measure')
    expect(dots.children[0]?.getAttribute('data-run-count')).toBe('3')
  })

  it('NO RUN NOTE APPEARS MORE THAN ONCE PER ARM — the criterion itself, over an arm of six runs of four kinds', () => {
    const comparison = compareArms({
      arms: [
        arm('a', 'opus', 'brief-x', [
          passed('r1', 2),
          passed('r2', 2),
          pending('r3'),
          pending('r4'),
          failed('r5', 1, 'gate exited 1'),
          failed('r6', 1, 'gate exited 1'),
        ]),
      ],
    })
    render(<ComparisonSurface comparison={comparison} />)

    const notes = [...within(screen.getByTestId('arm-panel')).getByTestId('run-dots').children].map((line) => line.textContent)
    expect(new Set(notes).size, `a note was printed twice: ${notes.join(' | ')}`).toBe(notes.length)
    expect(notes).toHaveLength(3)
  })

  it('a pass and a fail never share a line however alike their values, and the groups keep the order the runs arrived in', () => {
    const comparison = compareArms({ arms: [arm('a', 'opus', 'brief-x', [failed('r1', 2), passed('r2', 2), passed('r3', 2)])] })
    render(<ComparisonSurface comparison={comparison} />)

    const notes = [...within(screen.getByTestId('arm-panel')).getByTestId('run-dots').children].map((line) => line.textContent)
    expect(notes[0]).toContain('failed · 2')
    expect(notes[1]).toContain('2 runs · all passed · 2')
  })

  it('one run is still one run — a single note is never dressed up as a count', () => {
    const comparison = compareArms({ arms: [arm('a', 'opus', 'brief-x', [passed('r1', 2)])] })
    render(<ComparisonSurface comparison={comparison} />)

    const dots = within(screen.getByTestId('arm-panel')).getByTestId('run-dots')
    expect(dots.textContent).toBe('●r1: passed · 2')
  })
})

describe('the refusal is drawn ON the shared scale, not beside it (prd-55 ruling 8, the Design calls)', () => {
  const belowAndAbove = compareArms({
    arms: [
      arm('a', 'opus', 'brief-x', [passed('r1', 4), passed('r2', 9), passed('r3', 6)]),
      arm('b', 'sonnet', 'brief-x', [passed('r4', 5), passed('r5', 5)]),
    ],
  })

  it('every arm occupies a lane on the scale — the one that refuses as much as the one that summarises', () => {
    render(<ComparisonSurface comparison={belowAndAbove} />)

    expect(screen.getAllByTestId(/^arm-scale-/)).toHaveLength(2)
    expect(screen.getByTestId('arm-scale-a').dataset.scaleState).toBe('spread')
    expect(screen.getByTestId('arm-scale-b').dataset.scaleState).toBe('refused')
  })

  it('and the refusal sentence is INSIDE that lane, where the range would have been — not lifted out beside it', () => {
    render(<ComparisonSurface comparison={belowAndAbove} />)

    // The TRACK, not merely the arm's block: a refusal set above or beside the
    // track is exactly the drawing this criterion rejects, and a law that only
    // checked the block would pass on it.
    const track = screen.getByTestId('arm-track-b')
    const refusal = screen.getByTestId('arm-insufficient')
    expect(track.contains(refusal), 'the refusal was drawn beside its arm’s track, not on it').toBe(true)
    expect(refusal.textContent).toBe('n=2 — too few runs to summarise')
    // And where a range IS summarisable, the track carries the range instead.
    expect(screen.getByTestId('arm-track-a').querySelectorAll('span')).toHaveLength(2)
  })

  it('the scale is SHARED: one pair of ticks for every arm, reading to the widest value any of them booked', () => {
    render(<ComparisonSurface comparison={belowAndAbove} />)

    const ticks = screen.getByTestId('comparison-scale-ticks')
    expect(ticks.textContent).toContain('9')
    expect(ticks.textContent).toContain('one shared cost scale')
    expect(screen.getAllByTestId('comparison-scale-ticks')).toHaveLength(1)
  })

  it('an arm judged with nothing booked under the measure refuses on the scale too — no $0 is invented in the lane', () => {
    const nothingBooked = compareArms({ arms: [arm('a', 'opus', 'brief-x', [passed('r1', null), passed('r2', null), passed('r3', null)])] })
    render(<ComparisonSurface comparison={nothingBooked} />)

    const lane = screen.getByTestId('arm-scale-a')
    expect(lane.dataset.scaleState).toBe('refused')
    expect(screen.getByTestId('arm-track-a').contains(screen.getByTestId('arm-unbooked'))).toBe(true)
    expect(screen.queryByTestId('comparison-scale-ticks'), 'no scale is drawn when nothing was booked to draw one from').toBeNull()
  })
})
