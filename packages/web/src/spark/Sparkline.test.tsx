import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Sparkline } from './Sparkline.js'

afterEach(cleanup)

describe('Sparkline', () => {
  it('renders nothing for fewer than three points — the honest gap', () => {
    const { container: empty } = render(<Sparkline values={[]} />)
    expect(empty.querySelector('svg')).toBeNull()

    const { container: one } = render(<Sparkline values={[5]} />)
    expect(one.querySelector('svg')).toBeNull()

    const { container: two } = render(<Sparkline values={[5, 9]} />)
    expect(two.querySelector('svg')).toBeNull()
  })

  it('draws a line once three or more points are honest', () => {
    const { container } = render(<Sparkline values={[1, 4, 2]} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(3)
  })

  it('is aria-hidden — the number beside it stays the truth, this is texture', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} />)
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('draws a flat series as a real flat line, not as an absence', () => {
    const { container } = render(<Sparkline values={[5, 5, 5, 5]} />)
    const points = container.querySelector('polyline')?.getAttribute('points')?.split(' ') ?? []
    expect(points).toHaveLength(4)
    const ys = points.map((p) => Number(p.split(',')[1]))
    expect(new Set(ys).size).toBe(1)
  })

  it('respects a caller-supplied size', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} width={40} height={12} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('40')
    expect(svg?.getAttribute('height')).toBe('12')
  })

  it('inherits ink from its surroundings rather than carrying a hue of its own', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} />)
    expect(container.querySelector('polyline')?.getAttribute('stroke')).toBe('currentColor')
  })
})
