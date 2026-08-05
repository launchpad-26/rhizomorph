import { describe, expect, it } from 'vitest'
import {
  MAX_ZOOM_LEVEL,
  canShiftWindow,
  shiftWindow,
  usefulMaxZoomLevel,
  windowForLevel,
  zoomFractionLabel,
} from './tideWindow.js'

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

describe('usefulMaxZoomLevel — depth capped by the log\'s own grain (issue #186 defect 3)', () => {
  it('falls back to MAX_ZOOM_LEVEL when the spacing fact is unusable', () => {
    expect(usefulMaxZoomLevel(100_000, 900, Infinity)).toBe(MAX_ZOOM_LEVEL)
    expect(usefulMaxZoomLevel(100_000, 900, 0)).toBe(MAX_ZOOM_LEVEL)
    expect(usefulMaxZoomLevel(100_000, 0, 50)).toBe(MAX_ZOOM_LEVEL)
  })

  it('never retracts below the #169 floor (level 3, ⅛) — a sparse session never disables zoom', () => {
    // width=900, HOVER_PX=6 -> thresholdMs = (6/900) * windowSpan = windowSpan/150.
    // full span 150_000 -> level 3 threshold ~= 125ms, comfortably below a
    // huge median spacing: the log is sparse and no deeper zoom is useful,
    // but the answer is still the pre-existing floor, never less.
    expect(usefulMaxZoomLevel(150_000, 900, 1_000_000)).toBe(3)
  })

  it('extends past the floor for a denser median spacing', () => {
    // full span 150_000, width 900: level thresholds are ...125 (lvl3), 62.5 (lvl4)...
    // A median spacing of 100ms first drops the threshold at or below it at level 4.
    expect(usefulMaxZoomLevel(150_000, 900, 100)).toBe(4)
  })

  it('never exceeds MAX_ZOOM_LEVEL even for a vanishingly small median spacing', () => {
    expect(usefulMaxZoomLevel(150_000, 900, 0.0001)).toBe(MAX_ZOOM_LEVEL)
  })
})

describe('zoomFractionLabel — the window indicator\'s figures-voice fraction', () => {
  it('is "1" at level 0 (no bracket is drawn, but the label stays well-defined)', () => {
    expect(zoomFractionLabel(0)).toBe('1')
  })

  it('is "1/N" at deeper levels, matching the geometric fraction exactly', () => {
    expect(zoomFractionLabel(1)).toBe('1/2')
    expect(zoomFractionLabel(2)).toBe('1/4')
    expect(zoomFractionLabel(3)).toBe('1/8')
    expect(zoomFractionLabel(MAX_ZOOM_LEVEL)).toBe('1/64')
  })

  it('clamps out-of-range levels the same way windowForLevel does', () => {
    expect(zoomFractionLabel(-5)).toBe('1')
    expect(zoomFractionLabel(MAX_ZOOM_LEVEL + 10)).toBe('1/64')
  })
})
