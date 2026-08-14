import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Scrubber } from './Scrubber.js'

afterEach(cleanup)
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * jsdom reports zero for every layout box, so the component's one measurement
 * seam — the input's own `getBoundingClientRect().width` — has to be injected
 * to test the measured path at all. Returns a setter so a test can widen the
 * track and re-fire the observer.
 */
function stubTrackWidth(initial: number): (next: number) => void {
  let width = initial
  vi.spyOn(HTMLInputElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        width,
        height: 4,
        top: 0,
        left: 0,
        right: width,
        bottom: 4,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  )
  return (next) => {
    width = next
  }
}

/**
 * jsdom has no `ResizeObserver`; this one hands the test the callback so a
 * resize is deterministic, not timed, exposes the live observer set so teardown
 * is observable, and counts constructions so "the effect subscribes once, not
 * once per render" is observable too.
 */
function stubResizeObserver(): { resize(): void; observing(): number; instances(): number } {
  const callbacks = new Set<() => void>()
  let constructed = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: () => void) {
        constructed += 1
      }
      observe() {
        callbacks.add(this.callback)
      }
      disconnect() {
        callbacks.delete(this.callback)
      }
      unobserve() {
        callbacks.delete(this.callback)
      }
    },
  )
  return {
    resize() {
      act(() => {
        for (const callback of callbacks) callback()
      })
    },
    observing: () => callbacks.size,
    instances: () => constructed,
  }
}

const EIGHT_HOURS = 8 * 60 * 60 * 1000
const TWO_MINUTES = 2 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

function stepOf(): number {
  return Number((screen.getByLabelText('Replay scrubber') as HTMLInputElement).step)
}

describe('Scrubber — a native range input, never a reimplementation (ruling 10 restated)', () => {
  it('renders a real <input type="range"> with the expected aria-label', () => {
    render(<Scrubber start={0} end={10_000} value={0} onChange={() => {}} />)
    const input = screen.getByLabelText('Replay scrubber')
    expect(input.tagName).toBe('INPUT')
    expect(input).toHaveAttribute('type', 'range')
  })

  it('min/max/value track the props exactly — the browser owns stepping, not this component', () => {
    render(<Scrubber start={1_000} end={5_000} value={3_000} onChange={() => {}} />)
    const input = screen.getByLabelText('Replay scrubber') as HTMLInputElement
    expect(input.min).toBe('1000')
    expect(input.max).toBe('5000')
    expect(input.value).toBe('3000')
  })

  it('a keydown on the input is never intercepted — nothing here calls preventDefault', () => {
    render(<Scrubber start={0} end={10_000} value={0} onChange={() => {}} />)
    const input = screen.getByLabelText('Replay scrubber')

    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End', 'PageUp', 'PageDown']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
  })

  it('onChange fires with the numeric value, same contract as before', () => {
    const onChange = vi.fn()
    render(<Scrubber start={0} end={10_000} value={0} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Replay scrubber'), { target: { value: '4000' } })
    expect(onChange).toHaveBeenCalledWith(4000)
  })

  it('disabled passes straight through to the native attribute', () => {
    render(<Scrubber start={0} end={10_000} value={0} onChange={() => {}} disabled />)
    expect(screen.getByLabelText('Replay scrubber')).toBeDisabled()
  })

  it('the input has no horizontal sibling — full width, so the TIDE above it shares its x-axis', () => {
    const { container } = render(<Scrubber start={0} end={10_000} value={0} onChange={() => {}} />)
    const root = container.firstElementChild as HTMLElement
    const input = screen.getByLabelText('Replay scrubber')
    // The input's own row (its parent) contains only the input — the elapsed/
    // remaining labels moved to a second line, so nothing eats into the
    // input's width from the side.
    expect(input.parentElement).toBe(root)
    expect(Array.from(root.children).filter((el) => el.tagName === 'INPUT')).toHaveLength(1)
    expect(input.className).toContain('w-full')
  })

  it('still shows elapsed and total time, just no longer flanking the input', () => {
    render(<Scrubber start={1_000} end={11_000} value={5_000} onChange={() => {}} />)
    expect(screen.getByText('0:04')).toBeInTheDocument()
    expect(screen.getByText('0:10')).toBeInTheDocument()
  })
})

describe('Scrubber — one notch is one pixel of track, at any session length (#270)', () => {
  it('an eight-hour session gets at least one stop per pixel, not 1000 stops in total', () => {
    stubTrackWidth(1_920)
    render(<Scrubber start={0} end={EIGHT_HOURS} value={0} onChange={() => {}} />)

    // The quantum is at most a pixel, so the thumb cannot jump a visible
    // distance — the old `span / 1000` left 1.92px between stops on this track.
    expect(stepOf()).toBeLessThanOrEqual(EIGHT_HOURS / 1_920)
    expect(stepOf()).toBe(EIGHT_HOURS / 2_048)
  })

  it('a two-minute session is no longer floored to one-second notches', () => {
    stubTrackWidth(960)
    render(<Scrubber start={0} end={TWO_MINUTES} value={0} onChange={() => {}} />)

    // `max(1000, span / 1000)` gave 1000ms here: 120 stops, 8 visible pixels apart.
    expect(stepOf()).toBeLessThanOrEqual(TWO_MINUTES / 960)
    expect(stepOf()).toBeLessThan(1_000)
  })

  it('`end` is a grid point at widths that do not divide the session — the last pixel is reachable', () => {
    // The grid is `min + n * step`, and step membership is decided in decimal
    // arithmetic on the serialized attribute, where `span / 1907` does not
    // divide `span` however close the doubles look. Get this wrong and the far
    // end rounds down a whole notch: `End`, and a drag to the right edge, land
    // ~2.4 minutes short of the end of an eight-hour recording.
    const setWidth = stubTrackWidth(0)

    for (const width of [1_907, 1_001, 733, 397]) {
      setWidth(width)
      render(<Scrubber start={0} end={EIGHT_HOURS} value={EIGHT_HOURS} onChange={() => {}} />)

      const input = screen.getByLabelText('Replay scrubber') as HTMLInputElement
      expect(input.validity.stepMismatch).toBe(false)
      expect(input.value).toBe(String(EIGHT_HOURS))
      cleanup()
    }
  })

  it('`end` is still a grid point on a multi-day recording, where the step stops serialising exactly', () => {
    // `span / 2 ** k` is exact in binary, but the attribute carries the
    // shortest round-tripping decimal, which stops being the exact quotient
    // past ~17 significant digits. Unguarded, a 3.107-day recording on a
    // 2560px dock lands 65.5s short of its own end, and a 12.43-day one at
    // 1920px lands 524s short — worse, in that corner, than the 1/1000 grid
    // this replaced, which always serialised exactly.
    const setWidth = stubTrackWidth(0)

    const cases: readonly (readonly [width: number, span: number])[] = [
      [2_049, 268_435_457], // 2**28 + 1, 3.1069 d — the earliest span that misses at all
      [2_560, 268_435_459], // 2**28 + 3 — the earliest that misses by a whole notch
      [2_560, 999_999_999], // 11.6 d
      [1_920, 1_073_809_011], // 12.43 d
      [3_840, 30 * DAY + 7],
      [2_560, 60 * DAY + 3],
    ]

    for (const [width, span] of cases) {
      setWidth(width)
      render(<Scrubber start={0} end={span} value={span} onChange={() => {}} />)

      const input = screen.getByLabelText('Replay scrubber') as HTMLInputElement
      expect(input.validity.stepMismatch).toBe(false)
      // And the guard must not pay for that with #270's own currency: even
      // where it fires, the grid stays finer than the 1000 stops it replaced.
      expect(Math.round(span / stepOf())).toBeGreaterThanOrEqual(1_024)
      cleanup()
    }
  })

  it('the guard never fires on an ordinary recording — pixel density up to three days is untouched', () => {
    // The regression this change must not cause. A blanket notch-count cap
    // would buy the endpoint above by coarsening these: an 8h + 1ms recording
    // at 1920px would drop 2048 -> 1024 notches, 0.94px -> 1.88px per notch.
    const setWidth = stubTrackWidth(0)

    const cases: readonly (readonly [width: number, span: number, notches: number])[] = [
      [1_920, EIGHT_HOURS, 2_048],
      [1_920, EIGHT_HOURS + 1, 2_048],
      [2_560, EIGHT_HOURS + 1, 4_096],
      [2_560, 12 * 60 * 60 * 1_000 + 1, 4_096],
      [3_840, DAY + 1, 4_096],
      [2_560, 3 * DAY + 1, 4_096],
    ]

    for (const [width, span, notches] of cases) {
      setWidth(width)
      render(<Scrubber start={0} end={span} value={span} onChange={() => {}} />)

      expect(stepOf()).toBe(span / notches)
      expect((screen.getByLabelText('Replay scrubber') as HTMLInputElement).validity.stepMismatch).toBe(false)
      cleanup()
    }
  })

  it('a notch is half a pixel to a pixel of track — a two-sided law, down to a one-pixel track', () => {
    const setWidth = stubTrackWidth(0)

    // The notch count is the smallest power of two at least `width`, so it is
    // in `[width, 2 * width)` whenever neither the 1ms floor nor the
    // serialisation guard binds — which, for an eight-hour session, is every
    // width. Stated as bounds rather than as a count, the upper one is "never
    // coarser than a pixel" and the lower one is "never wastefully finer than
    // half a pixel": together they leave no room for a width the grid ignores.
    for (const width of [1, 17, 200, 479, 480, 960, 1_920, 2_560, 3_840]) {
      setWidth(width)
      render(<Scrubber start={0} end={EIGHT_HOURS} value={0} onChange={() => {}} />)

      expect(stepOf()).toBeLessThanOrEqual(EIGHT_HOURS / width)
      expect(stepOf()).toBeGreaterThan(EIGHT_HOURS / (2 * width))
      expect(stepOf()).toBeGreaterThanOrEqual(1)
      cleanup()
    }
  })

  it('measures in whole pixels — a fractional track width does not buy a finer grid', () => {
    // A width of 2048.5 asks for 2048 notches, not 4096: `Math.floor` on the
    // measured rect and the strict `notches < trackWidth` are what decide that,
    // and neither is visible in any other assertion here.
    stubTrackWidth(2_048.5)
    render(<Scrubber start={0} end={EIGHT_HOURS} value={0} onChange={() => {}} />)

    expect(stepOf()).toBe(EIGHT_HOURS / 2_048)
  })

  it('subscribes to the observer once, not once per render', () => {
    const observer = stubResizeObserver()
    stubTrackWidth(1_920)
    const { rerender } = render(<Scrubber start={0} end={EIGHT_HOURS} value={0} onChange={() => {}} />)

    for (const value of [1_000, 2_000, 3_000]) {
      rerender(<Scrubber start={0} end={EIGHT_HOURS} value={value} onChange={() => {}} />)
    }

    // The effect's empty dependency list is the only thing holding this: drop
    // it and every render tears down and rebuilds the subscription.
    expect(observer.instances()).toBe(1)
    expect(observer.observing()).toBe(1)
  })

  it('an arrow press still moves a useful increment — about 0.1% of the session, never one millisecond', () => {
    const setWidth = stubTrackWidth(0)

    for (const width of [480, 960, 1_920]) {
      for (const span of [TWO_MINUTES, EIGHT_HOURS]) {
        setWidth(width)
        render(<Scrubber start={0} end={span} value={0} onChange={() => {}} />)

        const step = stepOf()
        expect(step).toBeGreaterThan(1)
        // #186's calibration was ~0.1% of the session per press. This band is
        // asserted for these three widths only, and it is not a law about all
        // of them: a 200px track gives 0.39% and a 2049px one 0.024%, both
        // outside it. The law that does hold at every width is the two-sided
        // pixel bound above; this pins the calibration where a real dock sits.
        expect(step / span).toBeGreaterThan(0.000_4)
        expect(step / span).toBeLessThan(0.002_5)
        cleanup()
      }
    }
  })

  it('never produces a sub-millisecond step, however short the session', () => {
    stubTrackWidth(960)
    render(<Scrubber start={0} end={500} value={500} onChange={() => {}} />)

    // The floor binds here, so a notch is wider than a pixel — but the grid
    // still holds `end`, and it still beats what shipped, which cut this
    // session into a single 1000ms notch and froze the slider outright.
    expect(stepOf()).toBeGreaterThanOrEqual(1)
    expect(stepOf()).toBeLessThan(500)
    expect((screen.getByLabelText('Replay scrubber') as HTMLInputElement).validity.stepMismatch).toBe(false)
  })

  it('re-measures when the track is resized — the pixel guarantee is not a mount-time snapshot', () => {
    const observer = stubResizeObserver()
    const setWidth = stubTrackWidth(480)
    render(<Scrubber start={0} end={EIGHT_HOURS} value={0} onChange={() => {}} />)
    expect(stepOf()).toBe(EIGHT_HOURS / 512)

    setWidth(1_920)
    observer.resize()

    expect(stepOf()).toBe(EIGHT_HOURS / 2_048)
  })

  it('disconnects the observer on unmount — a resize after teardown reaches nothing', () => {
    const observer = stubResizeObserver()
    stubTrackWidth(480)
    const { unmount } = render(<Scrubber start={0} end={EIGHT_HOURS} value={0} onChange={() => {}} />)
    expect(observer.observing()).toBe(1)

    unmount()

    expect(observer.observing()).toBe(0)
    // And firing it anyway must not reach a `setState` on a dead component.
    expect(() => observer.resize()).not.toThrow()
  })

  it('degrades to the previous 1/1000 expression when the track has no measurable width', () => {
    // No `getBoundingClientRect` stub: jsdom reports zero, as would the frame
    // before layout. The fallback is exactly what shipped before this change.
    render(<Scrubber start={0} end={EIGHT_HOURS} value={0} onChange={() => {}} />)
    expect(stepOf()).toBe(Math.max(1_000, EIGHT_HOURS / 1_000))

    cleanup()
    render(<Scrubber start={0} end={TWO_MINUTES} value={0} onChange={() => {}} />)
    expect(stepOf()).toBe(1_000)
  })

  it('the law holds on the measured path too: a keydown is still never intercepted', () => {
    stubResizeObserver()
    stubTrackWidth(1_920)
    render(<Scrubber start={0} end={EIGHT_HOURS} value={0} onChange={() => {}} />)
    const input = screen.getByLabelText('Replay scrubber')

    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End', 'PageUp', 'PageDown']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
  })

  it('measuring the track changes nothing about the props the input reflects', () => {
    stubTrackWidth(1_920)
    render(<Scrubber start={1_000} end={5_000} value={3_000} onChange={() => {}} />)
    const input = screen.getByLabelText('Replay scrubber') as HTMLInputElement

    expect(input.min).toBe('1000')
    expect(input.max).toBe('5000')
    expect(input.value).toBe('3000')
  })

  /**
   * #272. The defect was not that these facts were unavailable — the clock was
   * derivable off a zoomed axis, and the counts sat on a prose row at the foot
   * of the bar. It was that neither was where the operator's eye already is,
   * and neither was there *at rest*. So every assertion here is about presence
   * without a gesture: the existing drag label is the thing that requires a
   * pointer, and it is deliberately not what these test.
   */
  describe('the readout beside the thumb', () => {
    const NOON = 12 * 60 * 60 * 1_000

    it('reads the absolute clock at the playhead with no drag and no zoom', () => {
      render(<Scrubber start={NOON} end={NOON + 60_000} value={NOON + 7_000} onChange={() => {}} />)

      // 12:00:07 — not an elapsed figure, and not conditional on a pointer
      // being down. Gating this render on `dragging` is the mutation that
      // returns the component to the behaviour the issue reported.
      expect(screen.getByTestId('scrubber-readout').textContent).toBe('12:00:07')
      expect(screen.queryByTestId('scrubber-drag-label')).not.toBeInTheDocument()
    })

    it('carries the scrub instant\'s facts beside the clock when it is given them', () => {
      render(
        <Scrubber
          start={NOON}
          end={NOON + 60_000}
          value={NOON + 7_000}
          onChange={() => {}}
          facts="4 worktrees · 8 commits · $2.14"
        />,
      )
      expect(screen.getByTestId('scrubber-readout').textContent).toBe(
        '12:00:07 · 4 worktrees · 8 commits · $2.14',
      )
    })

    it('tracks the value it is handed, so the clock follows the thumb', () => {
      const { rerender } = render(
        <Scrubber start={NOON} end={NOON + 60_000} value={NOON} onChange={() => {}} />,
      )
      expect(screen.getByTestId('scrubber-readout').textContent).toBe('12:00:00')

      rerender(<Scrubber start={NOON} end={NOON + 60_000} value={NOON + 42_000} onChange={() => {}} />)
      expect(screen.getByTestId('scrubber-readout').textContent).toBe('12:00:42')
    })

    it('is positioned on the thumb rather than at a fixed place on the track', () => {
      render(<Scrubber start={0} end={100_000} value={25_000} onChange={() => {}} />)
      expect(screen.getByTestId('scrubber-readout').style.left).toBe('25%')
    })

    /**
     * The painted readout is `aria-hidden`, because a live region rewritten on
     * every frame of a drag would be hostile to a screen reader. That is only
     * defensible while the same text reaches assistive tech some other way, and
     * `aria-valuetext` is that way — without it a range input announces the raw
     * epoch millisecond, which is not a time anyone can hear.
     */
    it('hands the same text to assistive tech as aria-valuetext, not as a live region', () => {
      render(
        <Scrubber
          start={NOON}
          end={NOON + 60_000}
          value={NOON + 7_000}
          onChange={() => {}}
          facts="4 worktrees · 8 commits · $2.14"
        />,
      )
      const readout = screen.getByTestId('scrubber-readout')
      const input = screen.getByLabelText('Replay scrubber')

      expect(readout.getAttribute('aria-hidden')).toBe('true')
      expect(input.getAttribute('aria-valuetext')).toBe(readout.textContent)
      expect(input.getAttribute('aria-valuetext')).toBe(
        '12:00:07 · 4 worktrees · 8 commits · $2.14',
      )
    })

    it('does not block the track it sits over', () => {
      render(<Scrubber start={0} end={100_000} value={25_000} onChange={() => {}} />)
      expect(screen.getByTestId('scrubber-readout').className).toContain('pointer-events-none')
    })
  })
})
