import { describe, expect, it } from 'vitest'
import { MAX_ZOOM_LEVEL, canShiftWindow, shiftWindow, windowForLevel } from './tideWindow.js'

const FULL_START = 0
const FULL_END = 100_000

describe('windowForLevel — zoom-out has a real floor', () => {
  it('level 0 is always the exact full range, regardless of centre', () => {
    expect(windowForLevel(0, 42, FULL_START, FULL_END)).toEqual({ start: FULL_START, end: FULL_END })
    expect(windowForLevel(0, 99_999, FULL_START, FULL_END)).toEqual({ start: FULL_START, end: FULL_END })
  })

  it('a deeper level halves the window at each step', () => {
    const l1 = windowForLevel(1, 50_000, FULL_START, FULL_END)
    expect(l1.end - l1.start).toBe((FULL_END - FULL_START) / 2)
    const l2 = windowForLevel(2, 50_000, FULL_START, FULL_END)
    expect(l2.end - l2.start).toBe((FULL_END - FULL_START) / 4)
  })

  it('centres on the requested timestamp when there is room', () => {
    const w = windowForLevel(1, 50_000, FULL_START, FULL_END)
    expect(w.start).toBe(25_000)
    expect(w.end).toBe(75_000)
  })

  it('clamps to the full range rather than hanging off either edge', () => {
    const left = windowForLevel(1, 0, FULL_START, FULL_END)
    expect(left.start).toBe(FULL_START)
    expect(left.end - left.start).toBe((FULL_END - FULL_START) / 2)

    const right = windowForLevel(1, FULL_END, FULL_START, FULL_END)
    expect(right.end).toBe(FULL_END)
    expect(right.end - right.start).toBe((FULL_END - FULL_START) / 2)
  })

  it('a level past the max clamps to the deepest defined zoom, never throws', () => {
    const deepest = windowForLevel(MAX_ZOOM_LEVEL, 50_000, FULL_START, FULL_END)
    const beyond = windowForLevel(MAX_ZOOM_LEVEL + 5, 50_000, FULL_START, FULL_END)
    expect(beyond).toEqual(deepest)
  })

  it('a negative level clamps to 0 (full range), never throws', () => {
    expect(windowForLevel(-3, 50_000, FULL_START, FULL_END)).toEqual({ start: FULL_START, end: FULL_END })
  })

  it('a zero-span full range never divides by zero', () => {
    expect(() => windowForLevel(2, 5, 5, 5)).not.toThrow()
  })
})

describe('shiftWindow — pans by half the window, clamped', () => {
  it('slides later by exactly half the window width', () => {
    const win = { start: 25_000, end: 75_000 }
    const shifted = shiftWindow(win, FULL_START, FULL_END, 1)
    expect(shifted).toEqual({ start: 50_000, end: 100_000 })
  })

  it('slides earlier by exactly half the window width', () => {
    const win = { start: 25_000, end: 75_000 }
    const shifted = shiftWindow(win, FULL_START, FULL_END, -1)
    expect(shifted).toEqual({ start: 0, end: 50_000 })
  })

  it('never overshoots the full range on repeated shifts', () => {
    let win = { start: 90_000, end: 95_000 }
    for (let i = 0; i < 10; i += 1) win = shiftWindow(win, FULL_START, FULL_END, 1)
    expect(win.end).toBe(FULL_END)
    expect(win.end - win.start).toBe(5_000)
  })

  it('preserves the window span across a shift', () => {
    const win = { start: 10_000, end: 30_000 }
    const shifted = shiftWindow(win, FULL_START, FULL_END, 1)
    expect(shifted.end - shifted.start).toBe(win.end - win.start)
  })
})

describe('canShiftWindow — the law shiftWindow no-ops obey', () => {
  it('the full-range window can never shift in either direction', () => {
    const full = { start: FULL_START, end: FULL_END }
    expect(canShiftWindow(full, FULL_START, FULL_END, -1)).toBe(false)
    expect(canShiftWindow(full, FULL_START, FULL_END, 1)).toBe(false)
  })

  it('a window already flush with an edge cannot shift further that way', () => {
    const atLeftEdge = { start: FULL_START, end: 50_000 }
    expect(canShiftWindow(atLeftEdge, FULL_START, FULL_END, -1)).toBe(false)
    expect(canShiftWindow(atLeftEdge, FULL_START, FULL_END, 1)).toBe(true)

    const atRightEdge = { start: 50_000, end: FULL_END }
    expect(canShiftWindow(atRightEdge, FULL_START, FULL_END, 1)).toBe(false)
    expect(canShiftWindow(atRightEdge, FULL_START, FULL_END, -1)).toBe(true)
  })

  it('agrees with shiftWindow: false means the position is unchanged', () => {
    const win = { start: FULL_START, end: 50_000 }
    expect(canShiftWindow(win, FULL_START, FULL_END, -1)).toBe(false)
    expect(shiftWindow(win, FULL_START, FULL_END, -1)).toEqual(win)
  })
})
