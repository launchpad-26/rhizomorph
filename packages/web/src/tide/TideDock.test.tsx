import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatClock, formatClockSeconds } from './duration.js'
import { medianEventSpacingMs } from './eventSpacing.js'
import { timeScale } from './scale.js'
import { usefulMaxZoomLevel, windowForLevel } from './tideWindow.js'
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

/**
 * A coalesced pair sitting next to the playhead — the fixture the mark-lane
 * guard below needs, and the one it did not have (verify pass, PR #430).
 *
 * At the cap the lane's hover threshold is wide enough to draw 5000 and 5006 as
 * one glyph; one level further in it is halved and they split. That split IS
 * the breach #273's Done-when forbids, and no fixture whose marks all clamp to
 * x=0 can see it — which is precisely why the first version of the guard
 * compared three zeros to three zeros and stayed green through the defect.
 */
function coalescingNearPlayhead(): RhizomorphEvent[] {
  return log((fx) => {
    fx.at(4_800).agentStatus({ handle: 'ke5', status: 'working' })
    fx.at(5_000).agentStatus({ handle: 'm2', status: 'working' })
    fx.at(5_006).agentStatus({ handle: 'q9', status: 'working' })
    fx.at(5_200).agentStatus({ handle: 'r3', status: 'working' })
  })
}

/** Three lanes, enough for the mark lane to have something to chew on. */
function threeLaneEvents(): RhizomorphEvent[] {
  return log((fx) => {
    fx.at(100).agentStatus({ handle: 'ke5', status: 'working' })
    fx.at(200).agentStatus({ handle: 'm2', status: 'working' })
    fx.at(300).agentStatus({ handle: 'q9', status: 'working' })
  })
}

describe('TideDock — the band, its rows, and its chip are gone in every mode (prd13 ruling 13)', () => {
  it('renders no band, no row, no fill and no coalescing chip in live mode', () => {
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled={false} />,
    )
    expect(screen.queryByTestId('tide')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('tide-row')).toHaveLength(0)
    expect(screen.queryAllByTestId('tide-band')).toHaveLength(0)
    expect(screen.queryByTestId('tide-more-chip')).not.toBeInTheDocument()
  })

  it('renders no band, no row, no fill and no coalescing chip in replay mode, on a 48-lane recording', () => {
    const events = log((fx) => {
      for (let i = 0; i < 48; i += 1) fx.at(i).agentStatus({ handle: `lane${i}`, status: 'working' })
    })
    render(<TideDock mode="replay" events={events} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />)
    expect(screen.queryByTestId('tide')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('tide-row')).toHaveLength(0)
    expect(screen.queryAllByTestId('tide-band')).toHaveLength(0)
    expect(screen.queryByTestId('tide-more-chip')).not.toBeInTheDocument()
  })

  it('the expand/collapse affordance is gone — there is nothing left to expand', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    expect(screen.queryByRole('button', { name: /expand/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /collapse/i })).not.toBeInTheDocument()
  })

  it('what remains is exactly the mark lane, the transport, and the zoom/shift affordances', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    expect(screen.getAllByTestId('chapter-mark')).toHaveLength(3)
    expect(screen.getByLabelText('Replay scrubber')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Shift window earlier' })).toBeInTheDocument()
  })
})

describe('TideDock — one shared scale (ruling 1: no second scale, not eyeballed)', () => {
  it('click-to-seek converts the click position with the exact same timeScale the mark lane renders with', () => {
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

  it('in live mode the playhead sits at the mapped range\'s own right edge ("now"), not at `value`', () => {
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

describe('TideDock — the mark lane (prd13 ruling 12) is the dock\'s whole glance layer', () => {
  it('renders a chapter mark for each lane, in the same track width the transport shares', () => {
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

describe('TideDock — drag-vs-click on the mark lane track (issue #186 defect 1/3, ~4px threshold)', () => {
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

describe('TideDock — one height, not mode-dependent (prd13 ruling 13, ex-#186 defect 4)', () => {
  it('the mark lane renders at its one default height in live', () => {
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled={false} />,
    )
    expect(screen.getByTestId('chapter-marks').style.height).toBe('10px')
  })

  it('the mark lane renders at the same height in replay — no mode split left to grow it', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={0} onSeek={() => {}} seekEnabled />,
    )
    expect(screen.getByTestId('chapter-marks').style.height).toBe('10px')
  })

  // #272 changed the first assertion of each of these two from "absent until
  // zoomed" to "present at rest, reading the full range". Zoomed out is the
  // *default* view, so gating the axis on zoom meant the dock said nothing
  // about when the playhead was until the operator went looking for it.
  it('the axis reads the full range at rest in replay, and the window once zoomed', () => {
    render(
      <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
    )
    // At rest the window IS the full range, so the axis reads the recording's
    // own first and last instant — the orientation half of #272.
    expect(screen.getByTestId('tide-axis').textContent).toBe(
      `${formatClock(T0)}${formatClock(T_END)}`,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const window_ = windowForLevel(1, 9_000, T0, T_END)
    const axis = screen.getByTestId('tide-axis')
    expect(axis.textContent).toBe(`${formatClock(window_.start)}${formatClock(window_.end)}`)
  })

  it('the axis is on in live too — it is gated on neither mode nor zoom', () => {
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled={false} />,
    )
    expect(screen.getByTestId('tide-axis')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByTestId('tide-axis')).toBeInTheDocument()
  })

  // The readout is `Scrubber`'s, but the thread from `TideDock`'s own prop to
  // it is this file's, and nothing else asserts the two are connected.
  it('passes the scrub facts through to the readout beside the thumb', () => {
    render(
      <TideDock
        mode="replay"
        events={threeLaneEvents()}
        start={T0}
        end={T_END}
        value={9_000}
        onSeek={() => {}}
        seekEnabled
        scrubFacts="4 worktrees · 8 commits · $2.14"
      />,
    )
    expect(screen.getByTestId('scrubber-readout').textContent).toContain(
      '4 worktrees · 8 commits · $2.14',
    )
  })

  /**
   * #273. The mark lane's cap used to be where zooming stopped. It is now a
   * threshold: one level past it, marks stop thinning and events appear.
   *
   * These drive the real button rather than setting a level directly, because
   * "the cap becomes a threshold rather than a stop" is a claim about the
   * *gesture* — a test that reached past the control could pass while the
   * button stayed disabled at the cap, which is the behaviour being changed.
   */
  describe('the loupe opens by zooming past the mark lane\'s cap', () => {
    function zoomToCap() {
      const button = screen.getByRole('button', { name: 'Zoom in' })
      // Zoom until one click short of exhausting the control. The bound is
      // generous and the loop stops on `disabled`, so this does not encode a
      // particular cap value — `usefulMaxZoomLevel` is free to move.
      const levels: number[] = []
      for (let i = 0; i < 40 && !(button as HTMLButtonElement).disabled; i += 1) {
        expect(screen.queryByTestId('tide-loupe')).not.toBeInTheDocument()
        fireEvent.click(button)
        levels.push(i)
        if (screen.queryByTestId('tide-loupe') !== null) return levels.length
      }
      return levels.length
    }

    /**
     * Counted against the cap, not merely "it opened eventually". An earlier
     * draft of this test asserted only that the loupe was absent before each
     * click and present after the last one — which is equally true of a loupe
     * that opens *at* the cap, the one thing "the cap becomes a threshold"
     * distinguishes. Mutating `>` to `>=` left it green. So the cap is computed
     * from the same inputs the component uses, and the click count is the
     * assertion.
     */
    it('stays shut at every level up to the cap, and opens exactly one past it', () => {
      const events = threeLaneEvents()
      const cap = usefulMaxZoomLevel(
        Math.max(1, T_END - T0),
        TRACK_WIDTH,
        medianEventSpacingMs(events),
      )
      expect(cap).toBeGreaterThan(0)

      render(
        <TideDock mode="replay" events={events} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
      )
      const button = screen.getByRole('button', { name: 'Zoom in' })

      // Every level up to and including the cap: marks, no events.
      for (let level = 0; level < cap; level += 1) {
        expect(screen.queryByTestId('tide-loupe')).not.toBeInTheDocument()
        fireEvent.click(button)
      }
      // Now at the cap itself — still the mark lane's own territory.
      expect(screen.queryByTestId('tide-loupe')).not.toBeInTheDocument()

      // One more, and the cap has been crossed.
      fireEvent.click(button)
      expect(screen.getByTestId('tide-loupe')).toBeInTheDocument()
    })

    it('stops there — the threshold is one level, not an open-ended descent', () => {
      render(
        <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
      )
      zoomToCap()
      expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled()
    })

    it('closes again on the way back out', () => {
      render(
        <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
      )
      zoomToCap()
      expect(screen.getByTestId('tide-loupe')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
      expect(screen.queryByTestId('tide-loupe')).not.toBeInTheDocument()
    })

    it('reads around the playhead, not around the window centre', () => {
      render(
        <TideDock mode="replay" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled />,
      )
      zoomToCap()
      expect(screen.getByTestId('tide-loupe')).toBeInTheDocument()

      // Pan the window off the playhead first. `zoomIn` re-centres on `value`
      // at every click, so until something pans, the playhead and the window
      // centre are the same number and this assertion holds for either of
      // them — which is why it used to survive the mutation it names.
      fireEvent.click(screen.getByRole('button', { name: 'Shift window earlier' }))

      expect(screen.getByTestId('tide-loupe-header').textContent).toContain(formatClockSeconds(9_000))
    })

    /**
     * Ruling 2's own boundary: the loupe is additive. If opening it changed what
     * the mark lane draws, the "coalescing law and its cap are untouched"
     * sentence would be false, and no other test in this file is looking.
     */
    it('leaves the mark lane exactly as it was at the cap', () => {
      render(
        <TideDock mode="replay" events={coalescingNearPlayhead()} start={T0} end={T_END} value={5_000} onSeek={() => {}} seekEnabled />,
      )
      const button = screen.getByRole('button', { name: 'Zoom in' })
      let atCap = ''
      let capCounts: (string | undefined)[] = []
      for (let i = 0; i < 40 && !(button as HTMLButtonElement).disabled; i += 1) {
        atCap = screen.getByTestId('chapter-marks').innerHTML
        capCounts = screen.getAllByTestId('chapter-mark').map((mark) => mark.dataset.count)
        fireEvent.click(button)
        if (screen.queryByTestId('tide-loupe') !== null) break
      }

      expect(screen.getByTestId('tide-loupe')).toBeInTheDocument()
      // The precondition, asserted rather than assumed. Without a coalesced
      // group inside the cap's window this whole comparison is vacuous, and it
      // silently was: a fixture 8.7 s from the playhead clamped every mark to
      // x=0, so the assertion below compared three zeros to three zeros.
      expect(capCounts).toContain('2')
      expect(screen.getAllByTestId('chapter-mark').map((mark) => mark.dataset.count)).toEqual(capCounts)
      expect(screen.getByTestId('chapter-marks').innerHTML).toBe(atCap)
    })
  })

  it('reads now in live, not the dormant replay clock, and carries no facts', () => {
    render(
      <TideDock mode="live" events={threeLaneEvents()} start={T0} end={T_END} value={9_000} onSeek={() => {}} seekEnabled={false} />,
    )
    // `value` is deliberately NOT `end` here, and that gap is the whole test.
    // Live paints the playhead at "now" (the range's right edge), so the
    // readout must agree with the playhead and disagree with `value`. The
    // previous version asserted `value` — it was pinning the defect: in the
    // real live prop shape `currentTs` is frozen at the range start, so the
    // readout printed the session's beginning beside a playhead at its end.
    expect(screen.getByTestId('scrubber-readout').textContent).toBe(formatClockSeconds(T_END))
    expect(screen.getByTestId('scrubber-readout').textContent).not.toBe(formatClockSeconds(9_000))
  })
})
