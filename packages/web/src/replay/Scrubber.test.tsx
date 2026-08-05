import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Scrubber } from './Scrubber.js'

afterEach(cleanup)

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
