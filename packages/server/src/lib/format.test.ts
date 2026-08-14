import { describe, expect, it } from 'vitest'
import { formatBytes, formatTokens } from './format.js'

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

describe('formatBytes', () => {
  it('prints sub-KB counts in bytes', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(1023)).toBe('1023B')
  })

  it('abbreviates KB and MB to one decimal', () => {
    expect(formatBytes(1536)).toBe('1.5KB')
    expect(formatBytes(1_572_864)).toBe('1.5MB')
  })

  it('drops a trailing .0', () => {
    expect(formatBytes(1024)).toBe('1KB')
    expect(formatBytes(1024 * 1024)).toBe('1MB')
  })
})
