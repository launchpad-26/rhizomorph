import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TIDE_START_TS, generateEventLog } from './fixtures.js'
import { Tide } from './Tide.js'

afterEach(cleanup)

const T0 = TIDE_START_TS
const MINUTE = 60_000

function log(build: (fx: ReturnType<typeof createEventFactory>) => void): RhizomorphEvent[] {
  const fx = createEventFactory({ startTs: T0, stepMs: 0 })
  build(fx)
  return fx.all()
}

describe('Tide — the hatch and every state fill are distinguishable without colour', () => {
  it('a gap band carries a pattern class a state band never does', () => {
    const events = log((fx) => {
      fx.at(T0).toolActivity({ lane: 'ke5' })
      // A gap this long survives any hover-pixel coalescing threshold.
      fx.at(T0 + 30 * MINUTE).toolActivity({ lane: 'ke5' })
    })

    render(<Tide events={events} start={T0} end={T0 + 30 * MINUTE} width={900} mode="expanded" />)

    const bands = screen.getAllByTestId('tide-band')
    const gapBands = bands.filter((el) => el.dataset.bandKind === 'gap')
    const stateBands = bands.filter((el) => el.dataset.bandKind === 'state')
    expect(gapBands.length).toBeGreaterThan(0)
    expect(stateBands.length).toBeGreaterThan(0)

    for (const el of gapBands) {
      expect(el.className).toContain('tide-band-gap')
      expect(el.style.backgroundImage).not.toBe('')
    }
    for (const el of stateBands) {
      expect(el.className).not.toContain('tide-band-gap')
      expect(el.style.backgroundImage).toBe('')
    }
  })
})

describe('Tide — label-fits: never clipped text', () => {
  it('a band below the text threshold renders no text at all', () => {
    // Six lanes packed into a narrow bar and a short window force sub-threshold widths.
    const events = generateEventLog(7, 40)
    render(<Tide events={events} start={T0} end={T0 + 5_000} width={40} mode="expanded" topN={10} />)

    const bands = screen.getAllByTestId('tide-band')
    for (const el of bands) {
      const width = Number.parseFloat(el.style.width || '0')
      if (width < 20) {
        expect(el.textContent).toBe('')
      }
    }
  })

  it('a wide state band does carry its state as text (labels when they fit)', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
    })
    render(<Tide events={events} start={T0} end={T0 + 60 * MINUTE} width={1200} mode="expanded" />)

    const band = screen.getAllByTestId('tide-band').find((el) => el.dataset.bandKind === 'state')
    expect(band).toBeDefined()
    expect(band?.textContent).toBe('WORKING')
  })
})

describe('Tide — the duration hover (ruling 6)', () => {
  it('reads start – end · lane · STATE · Duration, never inferred from pixel width', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
      fx.at(T0 + 80 * MINUTE).agentStatus({ handle: 'ke5', status: 'done' })
      // A second `done` a few minutes later gives the trailing band real
      // observed duration, well past the hover-pixel coalescing threshold —
      // without it, a zero-duration trailing band is exactly the sliver
      // `coalesce` is supposed to fold away, which would reopen the
      // `working` band this test means to check instead.
      fx.at(T0 + 85 * MINUTE).agentStatus({ handle: 'ke5', status: 'done' })
    })
    render(<Tide events={events} start={T0} end={T0 + 90 * MINUTE} width={900} mode="expanded" />)

    const band = screen
      .getAllByTestId('tide-band')
      .find((el) => el.dataset.bandKind === 'state' && el.dataset.state === 'working')
    expect(band?.title).toBe('14:00 – 15:20 · ke5 · WORKING · Duration 1h 20m')
  })

  it('an open band names its right edge "now", and duration is the observed length, not the window', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'waiting' })
    })
    render(<Tide events={events} start={T0} end={T0 + 90 * MINUTE} width={900} mode="expanded" />)

    const band = screen.getAllByTestId('tide-band').find((el) => el.dataset.bandKind === 'state')
    expect(band?.title).toBe('14:00 – now · ke5 · WAITING · Duration 0s')
  })
})

describe('Tide — rows (ruling 3–4)', () => {
  it('expanded mode gives every lane its own row, in first-seen order', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
      fx.at(T0 + MINUTE).agentStatus({ handle: 'm2', status: 'working' })
    })
    render(<Tide events={events} start={T0} end={T0 + 10 * MINUTE} width={600} mode="expanded" />)

    const rows = screen.getAllByTestId('tide-row')
    expect(rows.map((r) => r.dataset.lane)).toEqual(['ke5', 'm2'])
  })

  it('collapsed mode folds more than one lane into exactly one row', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
      fx.at(T0 + MINUTE).agentStatus({ handle: 'm2', status: 'working' })
      fx.at(T0 + 2 * MINUTE).agentStatus({ handle: 'q9', status: 'working' })
    })
    render(<Tide events={events} start={T0} end={T0 + 10 * MINUTE} width={600} mode="collapsed" />)

    const rows = screen.getAllByTestId('tide-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.dataset.rowKind).toBe('more')
  })

  it('collapsed mode with a single lane still just shows that lane — "+1" is never a row', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
    })
    render(<Tide events={events} start={T0} end={T0 + 10 * MINUTE} width={600} mode="collapsed" />)

    const rows = screen.getAllByTestId('tide-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.dataset.rowKind).toBe('lane')
    expect(rows[0]?.dataset.lane).toBe('ke5')
  })

  it('expanded mode past the row budget folds the remainder into one "+N" row', () => {
    const events = log((fx) => {
      for (const lane of ['a', 'b', 'c', 'd', 'e']) {
        fx.at(T0).agentStatus({ handle: lane, status: 'working' })
      }
    })
    render(<Tide events={events} start={T0} end={T0 + 10 * MINUTE} width={600} mode="expanded" topN={2} />)

    const rows = screen.getAllByTestId('tide-row')
    expect(rows.map((r) => r.dataset.rowKind)).toEqual(['lane', 'lane', 'more'])
  })
})

describe('Tide — no legend, ever (ruling 7)', () => {
  it('renders no element naming a legend or a colour key', () => {
    render(<Tide events={generateEventLog(1, 40)} start={T0} end={T0 + 60 * MINUTE} width={900} mode="expanded" />)
    expect(screen.queryByText(/legend/i)).toBeNull()
  })
})
