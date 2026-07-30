import { describe, expect, it } from 'vitest'
import { formatOverheadRatio, formatTokens, formatUsd, formatUsdPerHour } from './format.js'

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

describe('formatOverheadRatio', () => {
  it('renders null as an explicit unknown, never 0.00×', () => {
    expect(formatOverheadRatio(null)).toBe('unknown — no conductor telemetry yet')
  })

  it('formats a ratio to two decimal places with a × suffix', () => {
    expect(formatOverheadRatio(1.837742)).toBe('1.84×')
    expect(formatOverheadRatio(0.5)).toBe('0.50×')
  })
})
