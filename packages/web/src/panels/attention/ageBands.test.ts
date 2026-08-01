import { describe, expect, it } from 'vitest'
import { AGE_INK_MAX_MS, AGE_QUIET_MAX_MS, ageBand } from './ageBands.js'

describe('ageBand', () => {
  it('reads null (the log cannot say) as the resting INK band', () => {
    expect(ageBand(null)).toBe('ink')
  })

  it('is QUIET just under the quiet ceiling', () => {
    expect(ageBand(0)).toBe('quiet')
    expect(ageBand(AGE_QUIET_MAX_MS - 1)).toBe('quiet')
  })

  it('crosses into INK exactly at the quiet ceiling', () => {
    expect(ageBand(AGE_QUIET_MAX_MS)).toBe('ink')
    expect(ageBand(AGE_INK_MAX_MS - 1)).toBe('ink')
  })

  it('crosses into PULSE exactly at the ink ceiling, and stays there', () => {
    expect(ageBand(AGE_INK_MAX_MS)).toBe('pulse')
    expect(ageBand(AGE_INK_MAX_MS * 10)).toBe('pulse')
  })
})
