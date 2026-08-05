import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatClock } from './duration.js'
import { timeScale } from './scale.js'
import { windowForLevel } from './tideWindow.js'
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

describe('TideDock — neither mode renders per-lane rows without the explicit expand (prd13 ruling 12)', () => {
  it('defaults collapsed in live mode: one merged row for three lanes', () => {
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled={false} />,
    )
    const rows = screen.getAllByTestId('tide-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.dataset.rowKind).toBe('more')
  })

  it('defaults collapsed in replay too — the operator amendment this ruling exists for', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
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

  it('the same expand affordance switches replay to per-lane rows — one bit, both modes', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
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

describe('TideDock — the mark lane renders above the band (prd13 ruling 12)', () => {
  it('renders a chapter mark for each lane, in the same track width the Tide row uses', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    expect(screen.getAllByTestId('chapter-mark')).toHaveLength(3)
  })

  it('clicking a mark seeks to its exact ts, not the click position on the track', () => {
    const onSeek = vi.fn()
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={onSeek} seekEnabled />,
    )

    fireEvent.click(screen.getAllByTestId('chapter-mark')[0] as HTMLElement)
    expect(onSeek).toHaveBeenCalledWith(100)
  })
})

describe('TideDock — the window bracket and indicator (issue #186 defect 1, research note §4 R1)', () => {
  it('draws no bracket and no indicator at the default, fully-zoomed-out window', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
    )
    expect(screen.queryByTestId('tide-window-bracket')).not.toBeInTheDocument()
    expect(screen.queryByTestId('window-indicator')).not.toBeInTheDocument()
  })

  it('draws the bracket over the Scrubber in full-range coordinates, and the fraction label, once zoomed', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    const window_ = windowForLevel(1, 9_000, T0, T_END)
    const fullScale = timeScale(T0, T_END, TRACK_WIDTH)
    const expectedLeft = fullScale.xOf(window_.start)
    const expectedWidth = fullScale.xOf(window_.end) - expectedLeft

    const bracket = screen.getByTestId('tide-window-bracket')
    expect(bracket.style.left).toBe(`${expectedLeft}px`)
    expect(bracket.style.width).toBe(`${expectedWidth}px`)

    expect(screen.getByTestId('window-indicator').textContent).toBe(
      `window 1/2 · ${formatClock(window_.start)}–${formatClock(window_.end)}`,
    )
  })

  it('the bracket sits inside the Scrubber\'s own cell, never blocking pointer events on it', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const bracket = screen.getByTestId('tide-window-bracket')
    expect(bracket.className).toContain('pointer-events-none')
  })
})

describe('TideDock — Shift+wheel zooms about the cursor\'s own timestamp (issue #186 defect 3, research note §4 R4)', () => {
  it('zooms in, centred on the pointer\'s timestamp, only when Shift is held', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    const track = screen.getByTestId('tide-dock-track')

    fireEvent.wheel(track, { shiftKey: true, deltaY: -100, clientX: 90 })

    // cursorTs = timeScale(0, 10_000, 900).tsOf(90) = 1_000
    const expectedWindow = windowForLevel(1, 1_000, T0, T_END)
    const fullScale = timeScale(T0, T_END, TRACK_WIDTH)
    const bracket = screen.getByTestId('tide-window-bracket')
    expect(bracket.style.left).toBe(`${fullScale.xOf(expectedWindow.start)}px`)
    expect(bracket.style.width).toBe(`${fullScale.xOf(expectedWindow.end) - fullScale.xOf(expectedWindow.start)}px`)
  })

  it('an un-shifted wheel never zooms — page scroll is never hijacked', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    const track = screen.getByTestId('tide-dock-track')
    fireEvent.wheel(track, { shiftKey: false, deltaY: -100, clientX: 90 })
    expect(screen.queryByTestId('tide-window-bracket')).not.toBeInTheDocument()
  })

  it('Shift+wheel the other direction zooms back out', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    const track = screen.getByTestId('tide-dock-track')
    fireEvent.wheel(track, { shiftKey: true, deltaY: -100, clientX: 90 })
    expect(screen.getByTestId('tide-window-bracket')).toBeInTheDocument()

    fireEvent.wheel(track, { shiftKey: true, deltaY: 100, clientX: 90 })
    expect(screen.queryByTestId('tide-window-bracket')).not.toBeInTheDocument()
  })
})

describe('TideDock — drag-vs-click on the Tide track (issue #186 defect 1/3, ~4px threshold)', () => {
  it('a plain click still seeks exactly, unaffected by the drag machinery', () => {
    const onSeek = vi.fn()
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={onSeek} seekEnabled />,
    )
    fireEvent.click(screen.getByTestId('tide-dock-track'), { clientX: 450 })
    expect(onSeek).toHaveBeenCalledWith(5_000)
  })

  it('a drag past the threshold pans the window and suppresses the trailing click-seek', () => {
    const onSeek = vi.fn()
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={5_000} onSeek={onSeek} seekEnabled />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const track = screen.getByTestId('tide-dock-track')

    const before = windowForLevel(1, 5_000, T0, T_END)
    const pxPerMs = TRACK_WIDTH / (before.end - before.start)
    const dx = -50

    fireEvent.mouseDown(track, { clientX: 450 })
    fireEvent.mouseMove(document, { clientX: 450 + dx })
    fireEvent.mouseUp(document)

    const expectedCenter = 5_000 - dx / pxPerMs
    const expectedWindow = windowForLevel(1, expectedCenter, T0, T_END)
    const fullScale = timeScale(T0, T_END, TRACK_WIDTH)
    const bracket = screen.getByTestId('tide-window-bracket')
    expect(bracket.style.left).toBe(`${fullScale.xOf(expectedWindow.start)}px`)

    // The click that follows a real pointer drag in a browser must not also seek.
    fireEvent.click(track, { clientX: 450 + dx })
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('a sub-threshold jitter is still treated as a click, not a pan', () => {
    const onSeek = vi.fn()
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={onSeek} seekEnabled />,
    )
    const track = screen.getByTestId('tide-dock-track')

    fireEvent.mouseDown(track, { clientX: 450 })
    fireEvent.mouseMove(document, { clientX: 452 }) // 2px, under the 4px threshold
    fireEvent.mouseUp(document)
    fireEvent.click(track, { clientX: 450 })

    expect(onSeek).toHaveBeenCalledWith(5_000)
  })
})

describe('TideDock — zoom depth capped by the log\'s own grain (issue #186 defect 3)', () => {
  function denseEvents(): RhizomorphEvent[] {
    return log((fx) => {
      for (let i = 0; i < 10; i += 1) fx.at(i).agentStatus({ handle: `lane${i}`, status: 'working' })
    })
  }

  it('extends zoom past the #169 floor (level 3) for a log dense enough to warrant it', () => {
    render(
      <TideDock mode="replay" events={denseEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
    for (let i = 0; i < 3; i += 1) fireEvent.click(zoomIn)
    expect(zoomIn).toBeEnabled()
  })

  it('never disables zoom entirely for a sparse log — the floor stays reachable', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
    fireEvent.click(zoomIn)
    fireEvent.click(zoomIn)
    fireEvent.click(zoomIn)
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled()
  })
})

describe('TideDock — [ and ] step between chapters at the dock level (issue #186 defect 2, research note §4 R3)', () => {
  it(']  seeks to the next chapter after the playhead, exactly', () => {
    const onSeek = vi.fn()
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={150} onSeek={onSeek} seekEnabled />,
    )
    fireEvent.keyDown(document, { key: ']' })
    expect(onSeek).toHaveBeenCalledWith(200)
  })

  it('[ seeks to the previous chapter before the playhead, exactly', () => {
    const onSeek = vi.fn()
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={150} onSeek={onSeek} seekEnabled />,
    )
    fireEvent.keyDown(document, { key: '[' })
    expect(onSeek).toHaveBeenCalledWith(100)
  })

  it('does nothing past the last/first chapter', () => {
    const onSeek = vi.fn()
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={300} onSeek={onSeek} seekEnabled />,
    )
    fireEvent.keyDown(document, { key: ']' })
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('does nothing when seeking is disabled (live)', () => {
    const onSeek = vi.fn()
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={150} onSeek={onSeek} seekEnabled={false} />,
    )
    fireEvent.keyDown(document, { key: ']' })
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('still steps even while the native scrubber has focus — it owns no meaning for these keys', () => {
    const onSeek = vi.fn()
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={150} onSeek={onSeek} seekEnabled />,
    )
    const input = screen.getByLabelText('Replay scrubber')
    fireEvent.keyDown(input, { key: ']' })
    expect(onSeek).toHaveBeenCalledWith(200)
  })
})

describe('TideDock — mode-dependent height, replay breathes, live stays compact (issue #186 defect 4)', () => {
  it('live keeps the original, compact mark-lane and row heights', () => {
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled={false} />,
    )
    expect(screen.getByTestId('chapter-marks').style.height).toBe('10px')
    expect(screen.getByTestId('tide-row').style.height).toBe('14px')
  })

  it('replay gets taller mark-lane and row heights', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    expect(screen.getByTestId('chapter-marks').style.height).not.toBe('10px')
    expect(screen.getByTestId('tide-row').style.height).not.toBe('14px')
  })

  it('the axis only appears in replay, and only once zoomed', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
    )
    expect(screen.queryByTestId('tide-axis')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const window_ = windowForLevel(1, 9_000, T0, T_END)
    const axis = screen.getByTestId('tide-axis')
    expect(axis.textContent).toBe(`${formatClock(window_.start)}${formatClock(window_.end)}`)
  })

  it('live never shows the axis, even if zoom were somehow engaged', () => {
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled={false} />,
    )
    expect(screen.queryByTestId('tide-axis')).not.toBeInTheDocument()
  })
})
