import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timeScale } from './scale.js'
import { TideDock } from './TideDock.js'

afterEach(cleanup)

const T0 = 0
const T_END = 10_000
const TRACK_WIDTH = 900

const RECT = {
  width: TRACK_WIDTH,
  height: 14,
  top: 0,
  left: 0,
  right: TRACK_WIDTH,
  bottom: 14,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect

beforeEach(() => {
  vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(RECT)
})

function log(build: (fx: ReturnType<typeof createEventFactory>) => void): RhizomorphEvent[] {
  const fx = createEventFactory({ startTs: T0, stepMs: 0 })
  build(fx)
  return fx.all()
}

/** Three lanes, so "collapsed" (one merged row) is distinguishable from "expanded" (three rows). */
function threeLaneEvents(): RhizomorphEvent[] {
  return log((fx) => {
    fx.at(100).agentStatus({ handle: 'ke5', status: 'working' })
    fx.at(200).agentStatus({ handle: 'm2', status: 'working' })
    fx.at(300).agentStatus({ handle: 'q9', status: 'working' })
  })
}

describe('TideDock — live never renders per-lane rows without the explicit expand (ruling 2)', () => {
  it('defaults collapsed in live mode: one merged row for three lanes', () => {
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled={false} />,
    )
    const rows = screen.getAllByTestId('tide-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.dataset.rowKind).toBe('more')
  })

  it('the explicit expand affordance switches live to per-lane rows', () => {
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled={false} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand lane rows' }))

    const rows = screen.getAllByTestId('tide-row')
    expect(rows.map((r) => r.dataset.lane)).toEqual(['ke5', 'm2', 'q9'])
  })

  it('collapsing again returns to one merged row', () => {
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled={false} />,
    )
    const toggle = screen.getByRole('button', { name: 'Expand lane rows' })
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse lane rows' }))

    const rows = screen.getAllByTestId('tide-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.dataset.rowKind).toBe('more')
  })
})

describe('TideDock — replay is expanded by default (ruling 3), no toggle', () => {
  it('shows every lane its own row without any click', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    const rows = screen.getAllByTestId('tide-row')
    expect(rows.map((r) => r.dataset.lane)).toEqual(['ke5', 'm2', 'q9'])
  })

  it('has no expand/collapse control — replay never needs it', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    expect(screen.queryByRole('button', { name: /expand|collapse/i })).not.toBeInTheDocument()
  })
})

describe('TideDock — one shared scale (ruling 1: no second scale, not eyeballed)', () => {
  it('click-to-seek converts the click position with the exact same timeScale the Tide row renders with', () => {
    const onSeek = vi.fn()
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={onSeek} seekEnabled />,
    )

    fireEvent.click(screen.getByTestId('tide-dock-track'), { clientX: 450 })

    const expected = timeScale(T0, T_END, TRACK_WIDTH).tsOf(450)
    expect(onSeek).toHaveBeenCalledWith(expected)
    expect(onSeek).toHaveBeenCalledWith(5_000)
  })

  it('click-to-seek does nothing when seeking is disabled (live)', () => {
    const onSeek = vi.fn()
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={onSeek} seekEnabled={false} />,
    )
    fireEvent.click(screen.getByTestId('tide-dock-track'), { clientX: 450 })
    expect(onSeek).not.toHaveBeenCalled()
  })

  it("the playhead's x position is exactly timeScale(...).xOf(value) at the default (fully zoomed-out) window", () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={3_000} onSeek={() => {}} seekEnabled />,
    )
    const expectedX = timeScale(T0, T_END, TRACK_WIDTH).xOf(3_000)
    expect(screen.getByTestId('tide-playhead').style.left).toBe(`${expectedX}px`)
  })

  it('in live mode the playhead sits at the band\'s own right edge ("now"), not at `value`', () => {
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={3_000} onSeek={() => {}} seekEnabled={false} />,
    )
    const expectedX = timeScale(T0, T_END, TRACK_WIDTH).xOf(T_END)
    expect(screen.getByTestId('tide-playhead').style.left).toBe(`${expectedX}px`)
  })
})

describe('TideDock — zoom-out and window-shift affordances (ruling 10)', () => {
  it('zoom-out and shift start disabled — there is nothing to zoom out of or pan yet', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={3_000} onSeek={() => {}} seekEnabled />,
    )
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Shift window earlier' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Shift window later' })).toBeDisabled()
  })

  it('zooming in enables zoom-out and (when off-centre) a shift direction', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled()
    // Centred near the right edge, clamped — nothing further right to shift to.
    expect(screen.getByRole('button', { name: 'Shift window later' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Shift window earlier' })).toBeEnabled()
  })

  it('zooming all the way back out returns to the exact full-range window', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))

    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled()
    const expectedX = timeScale(T0, T_END, TRACK_WIDTH).xOf(9_000)
    expect(screen.getByTestId('tide-playhead').style.left).toBe(`${expectedX}px`)
  })

  it('the transport keeps scrubbing the full range regardless of zoom — min/max never narrow', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
    )
    const input = screen.getByLabelText('Replay scrubber') as HTMLInputElement
    expect(input.min).toBe('0')
    expect(input.max).toBe('10000')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    expect(input.min).toBe('0')
    expect(input.max).toBe('10000')
  })
})
