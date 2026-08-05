import { describe, expect, it } from 'vitest'
import { estimateLabelWidthPx, labelFits } from './label.js'

describe('labelFits — labels when they fit, colour when they do not (ruling 7)', () => {
  it('fits a short word in a wide band', () => {
    expect(labelFits(200, 'WORKING')).toBe(true)
  })

  it('does not fit any word into a zero-width band', () => {
    expect(labelFits(0, 'DONE')).toBe(false)
  })

  it('is monotonic in band width for a fixed label — never flips fit back off as it widens', () => {
    const text = 'WAITING'
    const fitsAt = new Map<number, boolean>()
    for (let width = 0; width <= 200; width += 5) fitsAt.set(width, labelFits(width, text))
    let sawFit = false
    for (let width = 0; width <= 200; width += 5) {
      const fits = fitsAt.get(width) as boolean
      if (fits) sawFit = true
      // Once it fits at some width, every wider width must also fit.
      if (sawFit) expect(fits).toBe(true)
    }
  })

  it('a longer label needs a wider band than a shorter one', () => {
    const shortWidth = estimateLabelWidthPx('DONE')
    const longWidth = estimateLabelWidthPx('WORKING')
    expect(longWidth).toBeGreaterThan(shortWidth)
  })
})
