import { describe, expect, it } from 'vitest'
import { formatClock, formatClockSeconds, formatDuration, formatRange } from './duration.js'

describe('formatDuration — ruling 6\'s stolen shape, first-class text', () => {
  it('prints seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45s')
  })

  it('prints whole minutes under an hour', () => {
    expect(formatDuration(38 * 60_000)).toBe('38m')
  })

  it('prints hours and minutes past an hour', () => {
    expect(formatDuration(80 * 60_000)).toBe('1h 20m')
  })

  it('drops the minutes when they are exactly zero', () => {
    expect(formatDuration(2 * 60 * 60_000)).toBe('2h')
  })

  it('never goes negative', () => {
    expect(formatDuration(-500)).toBe('0s')
  })
})

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

describe('formatRange — the hover\'s "start – end", open bands say "now"', () => {
  it('shows two clock readings for a closed band', () => {
    const start = Date.UTC(2026, 7, 4, 14, 0, 0)
    const end = Date.UTC(2026, 7, 4, 14, 38, 0)
    expect(formatRange(start, end)).toBe('14:00 – 14:38')
  })

  it('names the open edge "now" rather than inventing a timestamp', () => {
    const start = Date.UTC(2026, 7, 4, 14, 38, 0)
    expect(formatRange(start, null)).toBe('14:38 – now')
  })
})
