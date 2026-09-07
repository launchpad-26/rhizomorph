import { describe, expect, it } from 'vitest'
import { AXIS_INSET, axisX, compareByPosition, markerX, percentLabel, sessionFraction } from './position.js'

describe('sessionFraction — %-of-session is byte over byte length, never wall-clock (prd53 ruling 4)', () => {
  it('is the cut over the length, clamped to 0..1', () => {
    expect(sessionFraction(460, 1000)).toBe(0.46)
    expect(sessionFraction(0, 1000)).toBe(0)
    expect(sessionFraction(1500, 1000)).toBe(1)
  })

  it('is null — unknown, not zero — when the session length cannot be known (the file moved)', () => {
    expect(sessionFraction(460, null)).toBeNull()
    expect(sessionFraction(460, 0)).toBeNull()
  })
})

describe('axisX / markerX — one byte, one x', () => {
  it('maps 0 to the left inset and 1 to the right inset, on any width', () => {
    expect(axisX(0, 1000)).toBe(AXIS_INSET)
    expect(axisX(1, 1000)).toBe(1000 - AXIS_INSET)
    expect(axisX(0.5, 600)).toBe(300)
  })

  it('a degraded checkpoint has no x — the caller draws it with its reason, not at a guessed position', () => {
    expect(markerX({ sessionCutByte: 460, sessionByteLength: null }, 1000)).toBeNull()
    expect(markerX({ sessionCutByte: 460, sessionByteLength: 1000 }, 1000)).toBe(axisX(0.46, 1000))
  })
})

describe('compareByPosition — byte first, event index the tie-break', () => {
  it('orders by byte, and by event index when two cuts share a byte', () => {
    const a = { sessionCutByte: 100, eventIndex: 5 }
    const b = { sessionCutByte: 100, eventIndex: 7 }
    const c = { sessionCutByte: 50, eventIndex: 9 }
    expect([b, a, c].sort(compareByPosition)).toEqual([c, a, b])
  })
})

describe('percentLabel', () => {
  it('rounds to a whole percent and says nothing for an unknown position', () => {
    expect(percentLabel(0.456)).toBe('46 %')
    expect(percentLabel(null)).toBeNull()
  })
})
