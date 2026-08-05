import { describe, expect, it } from 'vitest'
import { medianEventSpacingMs } from './eventSpacing.js'

describe('medianEventSpacingMs — the log\'s typical grain', () => {
  it('is Infinity for zero or one event: no gap was ever observed', () => {
    expect(medianEventSpacingMs([])).toBe(Infinity)
    expect(medianEventSpacingMs([{ ts: 100 }])).toBe(Infinity)
  })

  it('is the exact gap for two events', () => {
    expect(medianEventSpacingMs([{ ts: 0 }, { ts: 250 }])).toBe(250)
  })

  it('is the middle gap for an odd number of gaps', () => {
    // gaps: 10, 20, 30 -> median 20
    expect(medianEventSpacingMs([{ ts: 0 }, { ts: 10 }, { ts: 30 }, { ts: 60 }])).toBe(20)
  })

  it('is the average of the two middle gaps for an even number of gaps', () => {
    // gaps: 10, 20, 30, 40 -> median (20+30)/2 = 25
    expect(medianEventSpacingMs([{ ts: 0 }, { ts: 10 }, { ts: 30 }, { ts: 60 }, { ts: 100 }])).toBe(25)
  })

  it('is unaffected by input order — sorts before diffing', () => {
    const forward = medianEventSpacingMs([{ ts: 0 }, { ts: 10 }, { ts: 30 }])
    const shuffled = medianEventSpacingMs([{ ts: 30 }, { ts: 0 }, { ts: 10 }])
    expect(shuffled).toBe(forward)
  })

  it('a single dense burst does not drag the median to near-zero when most of the log is idle', () => {
    // One 1ms-apart pair, then long idle stretches — the median should track
    // the idle stretches, not the burst (the "◆(1023)" pathology's opposite).
    const events = [{ ts: 0 }, { ts: 1 }, { ts: 3_600_000 }, { ts: 7_200_000 }]
    // gaps: 1, 3_599_999, 3_600_000 -> median is the middle one
    expect(medianEventSpacingMs(events)).toBe(3_599_999)
  })
})
