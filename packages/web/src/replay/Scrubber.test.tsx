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

/** jsdom has no `ResizeObserver`; this one hands the test the callback so a resize is deterministic, not timed. */
function stubResizeObserver(): { resize(): void } {
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
  it('an eight-hour session gets one stop per pixel, not 1000 stops in total', () => {
    stubTrackWidth(1_920)
    render(<Scrubber start={0} end={EIGHT_HOURS} value={0} onChange={() => {}} />)

    expect(stepOf()).toBe(EIGHT_HOURS / 1_920)
    // The quantum is a pixel, so the thumb cannot jump a visible distance —
    // the old `span / 1000` left 1.92px between stops on this track.
    expect(EIGHT_HOURS / stepOf()).toBe(1_920)
  })

  it('a two-minute session is no longer floored to one-second notches', () => {
    stubTrackWidth(960)
    render(<Scrubber start={0} end={TWO_MINUTES} value={0} onChange={() => {}} />)

    // `max(1000, span / 1000)` gave 1000ms here: 120 stops, 8 visible pixels apart.
    expect(stepOf()).toBe(TWO_MINUTES / 960)
    expect(stepOf()).toBeLessThan(1_000)
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
    render(<Scrubber start={0} end={500} value={0} onChange={() => {}} />)

    expect(stepOf()).toBe(1)
  })

  it('re-measures when the track is resized — the pixel guarantee is not a mount-time snapshot', () => {
    const observer = stubResizeObserver()
    const setWidth = stubTrackWidth(480)
    render(<Scrubber start={0} end={EIGHT_HOURS} value={0} onChange={() => {}} />)
    expect(stepOf()).toBe(EIGHT_HOURS / 480)

    setWidth(1_920)
    observer.resize()

    expect(stepOf()).toBe(EIGHT_HOURS / 1_920)
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
