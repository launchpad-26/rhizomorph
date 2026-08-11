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

/** jsdom has no `ResizeObserver`; this one hands the test the callback so a resize is deterministic, not timed, and exposes the live observer set so teardown is observable. */
function stubResizeObserver(): { resize(): void; observing(): number } {
  const callbacks = new Set<() => void>()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: () => void) {}
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
  }
}

const EIGHT_HOURS = 8 * 60 * 60 * 1000
const TWO_MINUTES = 2 * 60 * 1000

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

  it('a notch is never coarser than a pixel, down to a one-pixel track', () => {
    const setWidth = stubTrackWidth(0)

    for (const width of [1, 17, 200, 479, 480]) {
      setWidth(width)
      render(<Scrubber start={0} end={EIGHT_HOURS} value={0} onChange={() => {}} />)

      expect(stepOf()).toBeLessThanOrEqual(EIGHT_HOURS / width)
      expect(stepOf()).toBeGreaterThanOrEqual(1)
      cleanup()
    }
  })

  it('an arrow press still moves a useful increment — about 0.1% of the session, never one millisecond', () => {
    const setWidth = stubTrackWidth(0)

    for (const width of [480, 960, 1_920]) {
      for (const span of [TWO_MINUTES, EIGHT_HOURS]) {
        setWidth(width)
        render(<Scrubber start={0} end={span} value={0} onChange={() => {}} />)

        const step = stepOf()
        expect(step).toBeGreaterThan(1)
        // #186's calibration was ~0.1% of the session per press; one pixel of
        // any real track width stays inside a factor of ~2 of it either way.
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
})
