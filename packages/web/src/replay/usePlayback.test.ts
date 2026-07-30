import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayback } from './usePlayback.js'

describe('usePlayback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts paused at the range start', () => {
    const { result } = renderHook(() => usePlayback({ start: 1000, end: 5000 }))
    expect(result.current.playing).toBe(false)
    expect(result.current.currentTs).toBe(1000)
    expect(result.current.speed).toBe(1)
  })

  it('advances currentTs in real time while playing at 1x', () => {
    const { result } = renderHook(() => usePlayback({ start: 0, end: 10_000 }))

    act(() => result.current.play())
    expect(result.current.playing).toBe(true)

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(result.current.currentTs).toBeGreaterThanOrEqual(1900)
    expect(result.current.currentTs).toBeLessThanOrEqual(2100)
  })

  it('advances proportionally faster at higher speeds', () => {
    const { result } = renderHook(() => usePlayback({ start: 0, end: 100_000 }))

    act(() => result.current.setSpeed(16))
    act(() => result.current.play())
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(result.current.currentTs).toBeGreaterThanOrEqual(14_000)
  })

  it('clamps at the end and stops playing there', () => {
    const { result } = renderHook(() => usePlayback({ start: 0, end: 1000 }))

    act(() => result.current.play())
    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(result.current.currentTs).toBe(1000)
    expect(result.current.playing).toBe(false)
  })

  it('seek pauses playback and clamps into range', () => {
    const { result } = renderHook(() => usePlayback({ start: 0, end: 1000 }))

    act(() => result.current.play())
    act(() => result.current.seek(5000))

    expect(result.current.currentTs).toBe(1000)
    expect(result.current.playing).toBe(false)

    act(() => result.current.seek(-500))
    expect(result.current.currentTs).toBe(0)
  })

  it('resets to the start and pauses when the range changes', () => {
    const { result, rerender } = renderHook(({ start, end }) => usePlayback({ start, end }), {
      initialProps: { start: 0, end: 1000 },
    })

    act(() => result.current.play())
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(result.current.currentTs).toBeGreaterThan(0)

    rerender({ start: 2000, end: 3000 })

    expect(result.current.currentTs).toBe(2000)
    expect(result.current.playing).toBe(false)
  })

  it('refuses to play an empty range', () => {
    const { result } = renderHook(() => usePlayback({ start: 0, end: 0 }))
    act(() => result.current.play())
    expect(result.current.playing).toBe(false)
  })
})
