import { describe, expect, it } from 'vitest'
import { HOVER_PX, hoverThresholdMs, timeScale } from './scale.js'

const T0 = 1_754_316_000_000 // arbitrary fixed epoch ms — no clock read

describe('timeScale — the one time→x mapping', () => {
  it('maps start to 0 and end to width', () => {
    const scale = timeScale(T0, T0 + 60 * 60_000, 600)
    expect(scale.xOf(T0)).toBe(0)
    expect(scale.xOf(T0 + 60 * 60_000)).toBe(600)
  })

  it('maps the midpoint to the midpoint, linearly', () => {
    const scale = timeScale(T0, T0 + 100_000, 1000)
    expect(scale.xOf(T0 + 50_000)).toBeCloseTo(500)
  })

  it('clamps a timestamp outside the window to the bar edges', () => {
    const scale = timeScale(T0, T0 + 1000, 100)
    expect(scale.xOf(T0 - 500)).toBe(0)
    expect(scale.xOf(T0 + 5000)).toBe(100)
  })

  it('is the inverse of itself: tsOf(xOf(ts)) round-trips within the window', () => {
    const scale = timeScale(T0, T0 + 7 * 60_000, 700)
    for (const offset of [0, 1234, 60_000, 7 * 60_000]) {
      const ts = T0 + offset
      expect(scale.tsOf(scale.xOf(ts))).toBeCloseTo(ts, 0)
    }
  })

  it('never divides by zero when start === end', () => {
    const scale = timeScale(T0, T0, 400)
    expect(Number.isFinite(scale.xOf(T0))).toBe(true)
    expect(Number.isFinite(scale.widthOf(1000))).toBe(true)
  })

  it('widthOf a duration is proportional to the scale — no second copy of the ratio', () => {
    const scale = timeScale(T0, T0 + 100_000, 500)
    expect(scale.widthOf(10_000)).toBeCloseTo(50)
    expect(scale.widthOf(0)).toBe(0)
  })
})

describe('hoverThresholdMs — the caller\'s pixel budget, as a duration', () => {
  it('converts HOVER_PX into the same fraction of the window in ms', () => {
    const scale = timeScale(T0, T0 + 1_000_000, 1000) // 1000ms per pixel
    expect(hoverThresholdMs(scale)).toBeCloseTo(HOVER_PX * 1000)
  })

  it('is zero when the bar has no width to hover in', () => {
    const scale = timeScale(T0, T0 + 1000, 0)
    expect(hoverThresholdMs(scale)).toBe(0)
  })
})
