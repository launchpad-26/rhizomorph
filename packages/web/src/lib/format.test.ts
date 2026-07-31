import { describe, expect, it } from 'vitest'
import { formatTokenBreakdown, formatTokens, formatUsd, formatUsdPerHour } from './format.js'

describe('formatTokens', () => {
  it('prints small counts exactly', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(842)).toBe('842')
  })

  it('abbreviates thousands, millions and billions to one decimal', () => {
    expect(formatTokens(1_500)).toBe('1.5K')
    expect(formatTokens(1_184_279)).toBe('1.2M')
    expect(formatTokens(2_000_000_000)).toBe('2B')
  })

  it('drops a trailing .0', () => {
    expect(formatTokens(1_000)).toBe('1K')
    expect(formatTokens(1_000_000)).toBe('1M')
  })
})

describe('formatUsd', () => {
  it('shows a real zero as $0.00, not "unknown"', () => {
    expect(formatUsd(0)).toBe('$0.00')
  })

  it('shows sub-cent amounts as a floor rather than rounding to zero', () => {
    expect(formatUsd(0.000591)).toBe('<$0.01')
  })

  it('formats ordinary amounts to two decimal places', () => {
    expect(formatUsd(2.620591)).toBe('$2.62')
    expect(formatUsd(0.42)).toBe('$0.42')
  })
})

describe('formatUsdPerHour', () => {
  it('appends the rate suffix', () => {
    expect(formatUsdPerHour(12.5)).toBe('$12.50/hr')
  })
})

describe('formatTokenBreakdown', () => {
  it('renders all four tiers, labelled, output first, regardless of magnitude', () => {
    const breakdown = formatTokenBreakdown({
      input: 4,
      output: 3_100,
      cacheRead: 180_000,
      cacheCreation: 6_400,
      total: 189_504,
    })
    expect(breakdown).toBe('output 3.1K · input 4 · cache read 180K · cache write 6.4K')
  })

  it('never mentions total — every rendered number is one of the four tiers', () => {
    const breakdown = formatTokenBreakdown({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheCreation: 4,
      total: 10,
    })
    expect(breakdown).not.toContain('10')
    expect(breakdown).toBe('output 2 · input 1 · cache read 3 · cache write 4')
  })

  it('still names a zeroed tier rather than omitting it', () => {
    const breakdown = formatTokenBreakdown({
      input: 310,
      output: 40,
      cacheRead: 0,
      cacheCreation: 0,
      total: 350,
    })
    expect(breakdown).toContain('cache read 0')
    expect(breakdown).toContain('cache write 0')
  })
})
