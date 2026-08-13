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

    // Tolerance tightened with the cadence (#271). The old bound was ±100 ms —
    // one 100 ms tick of slack either side. A frame-driven tick lands within one
    // frame of the elapsed wall clock, and because every delta is measured from
    // `now()` it can never run *ahead* of it, so the upper bound is exact.
    expect(result.current.currentTs).toBeGreaterThanOrEqual(1980)
    expect(result.current.currentTs).toBeLessThanOrEqual(2000)
  })

  // The #271 regression test. `vi.useFakeTimers()` fakes `requestAnimationFrame`
  // as well as `setInterval`, so frames are driven by `advanceTimersByTime` — no
  // assertion here depends on this machine's real frame cadence.
  it('advances on every frame, not once per 100 ms', () => {
    const { result } = renderHook(() => usePlayback({ start: 0, end: 100_000 }))

    act(() => result.current.play())

    // Six frames' worth of wall clock is less than one 100 ms tick, so under the
    // old `setInterval` every read below is 0 and the first assertion fails.
    let previous = 0
    for (let i = 0; i < 6; i += 1) {
      act(() => {
        vi.advanceTimersByTime(16)
      })
      const current = result.current.currentTs
      expect(current).toBeGreaterThan(previous)
      previous = current
    }
    // Exact, not slack: six advances of 16 ms move the faked wall clock by
    // 96 ms, and a clock that only ever adds `now()` deltas cannot exceed that
    // however many frames the fake scheduler chose to fire inside it.
    expect(previous).toBeLessThanOrEqual(96)
  })

  // #155's property, now that a frame timestamp is within reach: rAF hands its
  // callback a `DOMHighResTimeStamp`, and using it would be both a second
  // wall-clock read and one no test could inject.
  it('measures elapsed time with the injected clock, not the frame timestamp', () => {
    let injected = 0
    const { result } = renderHook(() =>
      usePlayback({ start: 0, end: 100_000, now: () => injected }),
    )

    act(() => result.current.play())

    // Ten frames fire, but the injected clock has not moved: no simulated time
    // may pass. Reading rAF's own timestamp instead would advance ~160 ms here.
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(result.current.currentTs).toBe(0)

    // Move only the injected clock: the next frame owes the whole delta.
    injected = 500
    act(() => {
      vi.advanceTimersByTime(16)
    })
    expect(result.current.currentTs).toBe(500)
  })

  // The `now` stability contract on `UsePlaybackOptions`. Anything that changes
  // the tick effect's dependencies every render — an inline `now`, or a new
  // entry in the dep array — tears the loop down and re-arms it once per commit
  // instead of once per frame. Under fake timers no simulated time is lost to
  // that, so not one timing assertion in this file would notice; the arm count
  // is what notices.
  it('arms one frame per frame, not one per render', () => {
    const arm = vi.spyOn(globalThis, 'requestAnimationFrame')
    try {
      const { result } = renderHook(() => usePlayback({ start: 0, end: 100_000 }))

      act(() => result.current.play())
      const afterPlay = arm.mock.calls.length

      for (let i = 0; i < 6; i += 1) {
        act(() => {
          vi.advanceTimersByTime(16)
        })
      }

      // Six frames fired, each arming its own successor and nothing else.
      expect(arm.mock.calls.length - afterPlay).toBe(6)
    } finally {
      arm.mockRestore()
    }
  })

  // The doc comment's hidden-tab claim, at 1x. rAF stops entirely in a hidden
  // tab, so the resuming frame owes the whole gap — which holds only while
  // `now()` owns the clock. The injected clock is deliberately decoupled from
  // the fake timer clock here: moving `wall` *without* advancing timers is
  // exactly "real time kept going while no frame arrived".
  it('resumes at the wall-clock-correct instant after a gap with no frames', () => {
    let wall = 0
    const now = () => wall
    const { result } = renderHook(() => usePlayback({ start: 0, end: 10_000_000, now }))

    act(() => result.current.play())
    act(() => {
      wall += 16
      vi.advanceTimersByTime(16)
    })
    expect(result.current.currentTs).toBe(16)

    // Five minutes of wall clock, and exactly one frame on the far side of it.
    act(() => {
      wall += 300_000
      vi.advanceTimersByTime(16)
    })

    // The whole gap, on the one resuming frame — not one frame's worth of it,
    // and not the frames that never fired.
    expect(result.current.currentTs).toBe(300_016)
  })

  // The same claim at 16x, where the gap is multiplied past the end of a short
  // recording: the clamp has to hold against an arbitrarily large single step.
  it('clamps a hidden-tab gap that overshoots the range at speed', () => {
    let wall = 0
    const now = () => wall
    const { result } = renderHook(() => usePlayback({ start: 0, end: 60_000, now }))

    act(() => result.current.setSpeed(16))
    act(() => result.current.play())
    act(() => {
      wall += 300_000
      vi.advanceTimersByTime(16)
    })

    // 300 s of wall clock at 16x is 4800 s of timeline against a 60 s range.
    expect(result.current.currentTs).toBe(60_000)
    expect(result.current.playing).toBe(false)
  })

  it('cancels the armed frame on pause instead of leaving the loop running', () => {
    const { result } = renderHook(() => usePlayback({ start: 0, end: 100_000 }))

    act(() => result.current.play())
    act(() => {
      vi.advanceTimersByTime(32)
    })
    const pausedAt = result.current.currentTs
    expect(pausedAt).toBeGreaterThan(0)

    act(() => result.current.pause())
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    // A self-re-arming tick that outlived its cleanup would keep reading `now()`
    // and so would move the clock a full second past the pause.
    expect(result.current.currentTs).toBe(pausedAt)
  })

  // #395. The mirror of the hidden-tab tests above: there, a gap with no frames
  // is genuinely owed and must be paid on the resuming frame. Here the gap is
  // *paused* time, which is owed to nobody — press play after five minutes and
  // the timeline moves one frame, not five minutes.
  //
  // This assertion looks unnecessary, and that is exactly why it is written
  // down. The property is guarded twice over in `usePlayback.ts`: the paused
  // branch nulls `lastTickRef`, *and* the arming path rebases it to `now()`.
  // Either guard alone delivers it, so no single-point mutation can expose the
  // gap and ordinary mutation testing reports the area as covered. A plausible
  // tidy-up — "one of these two is redundant" — removes both halves of the
  // belt-and-braces across two commits with every gate green. The two-point
  // mutation this test exists to fail is:
  //
  //     if (!playing || start >= end) {
  //  -    lastTickRef.current = null
  //       return
  //     }
  //  -  lastTickRef.current = now()
  //  +  lastTickRef.current = lastTickRef.current ?? now()
  //
  // Against that, the rest of this file stays green and the whole suite exits 0;
  // this test fails with `expected 300032 to be 32`.
  it('does not credit the paused interval on resume', () => {
    let wall = 0
    const now = () => wall
    const { result } = renderHook(() => usePlayback({ start: 0, end: 10_000_000, now }))

    act(() => result.current.play())
    act(() => {
      wall += 16
      vi.advanceTimersByTime(16)
    })
    expect(result.current.currentTs).toBe(16)

    act(() => result.current.pause())

    // Five minutes paused. Real time passes; no simulated time is owed, because
    // no frame was *missed* — the loop was torn down deliberately.
    wall += 300_000
    act(() => result.current.play())
    act(() => {
      wall += 16
      vi.advanceTimersByTime(16)
    })

    // One frame since the resume, not five minutes.
    expect(result.current.currentTs).toBe(32)
  })

  it('clamps to end on a frame that steps over it, then goes quiet', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return usePlayback({ start: 0, end: 10 })
    })

    act(() => result.current.play())
    // A single ~16 ms frame is wider than the whole 10 ms range, so the clamp
    // has to hold at frame granularity and not just at 100 ms granularity.
    act(() => {
      vi.advanceTimersByTime(16)
    })

    expect(result.current.currentTs).toBe(10)
    expect(result.current.playing).toBe(false)

    const rendersAtStop = renders
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    // Not one further render in a second of frames: the stop cancelled the armed
    // frame rather than leaving the loop re-arming itself. That teardown, plus
    // React bailing out of a `setPlaying(false)` dispatched against an already
    // false state, is what makes the stop fire once — not the effect's `playing`
    // guard, which is defensive only and whose deletion fails no test here.
    expect(renders).toBe(rendersAtStop)
    expect(result.current.currentTs).toBe(10)
    expect(result.current.playing).toBe(false)
  })

  it('advances proportionally faster at higher speeds', () => {
    const { result } = renderHook(() => usePlayback({ start: 0, end: 100_000 }))

    act(() => result.current.setSpeed(16))
    act(() => result.current.play())
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    // Also tightened with the cadence: the slack here was one 100 ms tick scaled
    // by 16x (1600 ms of simulated time). One frame at 16x is 256 ms, and the
    // ceiling is again exact — 1000 ms of `now()` at 16x cannot exceed 16 s.
    expect(result.current.currentTs).toBeGreaterThanOrEqual(15_700)
    expect(result.current.currentTs).toBeLessThanOrEqual(16_000)
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
