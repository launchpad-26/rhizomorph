import { describe, expect, it } from 'vitest'
import { formatClock, formatClockSeconds } from './duration.js'

describe('formatClock — HH:MM, UTC, by arithmetic', () => {
  it('reads a known epoch instant correctly', () => {
    // 2026-08-04T14:38:00.000Z
    expect(formatClock(Date.UTC(2026, 7, 4, 14, 38, 0))).toBe('14:38')
  })

  it('pads single-digit hours and minutes', () => {
    expect(formatClock(Date.UTC(2026, 7, 4, 4, 5, 0))).toBe('04:05')
  })

  it('wraps past midnight', () => {
    expect(formatClock(Date.UTC(2026, 7, 4, 23, 59, 0) + 60_000)).toBe('00:00')
  })
})

describe('formatClockSeconds — HH:MM:SS, UTC, by arithmetic — the mark hover\'s finer grain', () => {
  it('reads a known epoch instant correctly, seconds included', () => {
    // 2026-08-04T14:32:07.000Z — prd13 ruling 12's own example: "163 landed · 14:32:07"
    expect(formatClockSeconds(Date.UTC(2026, 7, 4, 14, 32, 7))).toBe('14:32:07')
  })

  it('pads single-digit hours, minutes and seconds', () => {
    expect(formatClockSeconds(Date.UTC(2026, 7, 4, 4, 5, 6))).toBe('04:05:06')
  })

  it('wraps past midnight', () => {
    expect(formatClockSeconds(Date.UTC(2026, 7, 4, 23, 59, 59) + 1_000)).toBe('00:00:00')
  })

  it('agrees with formatClock on the minute, for the same instant', () => {
    const ts = Date.UTC(2026, 7, 4, 14, 32, 7)
    expect(formatClockSeconds(ts).slice(0, 5)).toBe(formatClock(ts))
  })
})
