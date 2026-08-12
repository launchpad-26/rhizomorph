import { useCallback, useEffect, useRef, useState } from 'react'

export type PlaybackSpeed = 1 | 4 | 16

/** The only speeds the transport offers, per prd0. */
export const PLAYBACK_SPEEDS: readonly PlaybackSpeed[] = [1, 4, 16]

export interface UsePlaybackOptions {
  start: number
  end: number
  /**
   * Injectable clock for tests; defaults to the real one. Must be a *stable*
   * reference: it is a dependency of the tick effect below, so a fresh identity
   * on every render tears the loop down, re-arms it, and rebases `lastTickRef`
   * to the moment of the re-arm — losing the interval between the last tick and
   * that flush, up to a frame's worth per render. The one production call site
   * (`useReplaySession`) passes nothing, so the dependency is the stable
   * `Date.now`.
   */
  now?: () => number
}

export interface UsePlaybackResult {
  currentTs: number
  playing: boolean
  speed: PlaybackSpeed
  play(): void
  pause(): void
  setSpeed(speed: PlaybackSpeed): void
  seek(ts: number): void
  reset(): void
}

/**
 * Drives the scrubber clock forward in real time, scaled by speed, while
 * playing. Live and replay never touch this — it only exists to move the
 * `ts` that `foldUpTo` folds against.
 *
 * #155 audit: the one legitimate wall-clock read in the whole replay path.
 * This is not judging a lane's recency against real time (the bug) — it is
 * converting real elapsed seconds into simulated timeline seconds, which is
 * the transport's entire job. `currentTs` is the finger: the scrubber thumb
 * reads it directly, and `useReplaySession` frame-coalesces it into the
 * `derivedTs` that `ModeContext.useModeClock` serves while replaying (#269).
 * Nothing downstream of either ever calls `Date.now()` on its own account.
 *
 * The tick rides `requestAnimationFrame` (#271) rather than a 100 ms
 * `setInterval`, so the painter gets a fresh instant on every frame it draws
 * instead of one frame in six. The cadence changed; the clock's owner did not.
 * Elapsed time is still measured by `now()` and not by the timestamp rAF hands
 * the callback, which is what keeps the injection point above load-bearing and
 * the read here the only one. Measuring from `now()` rather than from frames
 * received also means a window that stops getting them — hidden tab, throttled
 * background — resumes at the wall-clock-correct instant instead of counting the
 * frames it never got. That property predates #271: the old `setInterval`
 * measured `now()` deltas too. What the frame-driven tick changes is the *shape*
 * of the catch-up — rAF stops entirely in a hidden tab, so the whole gap is owed
 * on the one resuming frame (clamped to `end`), where a throttled interval paid
 * it down at roughly 1/s. Asserted in `usePlayback.test.ts`, both at 1x and at
 * 16x into a range shorter than the gap.
 */
export function usePlayback({ start, end, now = Date.now }: UsePlaybackOptions): UsePlaybackResult {
  const [currentTs, setCurrentTs] = useState(start)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1)
  const lastTickRef = useRef<number | null>(null)

  // A newly loaded session (or a cleared one) starts paused at its beginning.
  useEffect(() => {
    setCurrentTs(start)
    setPlaying(false)
    lastTickRef.current = null
  }, [start, end])

  useEffect(() => {
    if (!playing || start >= end) {
      lastTickRef.current = null
      return
    }

    lastTickRef.current = now()

    let frame = 0
    const tick = () => {
      const nowTs = now()
      const last = lastTickRef.current ?? nowTs
      const deltaMs = (nowTs - last) * speed
      lastTickRef.current = nowTs

      setCurrentTs((prev) => {
        const next = prev + deltaMs
        return next >= end ? end : next
      })

      // Each tick arms the next one, so `frame` always holds the only
      // outstanding request and the cleanup below has exactly one to cancel.
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, speed, start, end, now])

  // A separate effect (rather than inlining in the tick) so it fires exactly
  // once when playback crosses the end, regardless of tick granularity — and a
  // frame-driven tick makes that granularity coarse relative to short ranges: a
  // single 16 ms frame can step clean over the whole remainder. The clamp in the
  // tick keeps `currentTs` at `end`, and setting `playing` false tears down the
  // loop above, so no further frame arrives to run this again.
  //
  // The `playing` guard is defensive, not load-bearing: deleting it fails no
  // test, because the effect's only re-run after the stop dispatches
  // `setPlaying(false)` against an already-false state, which React bails out of
  // without scheduling a render. What actually delivers fire-once is the
  // teardown plus that bailout.
  useEffect(() => {
    if (playing && currentTs >= end) setPlaying(false)
  }, [playing, currentTs, end])

  const play = useCallback(() => {
    if (start >= end) return
    setPlaying(true)
  }, [start, end])

  const pause = useCallback(() => setPlaying(false), [])

  const setSpeed = useCallback((next: PlaybackSpeed) => setSpeedState(next), [])

  const seek = useCallback(
    (ts: number) => {
      setPlaying(false)
      setCurrentTs(Math.min(end, Math.max(start, ts)))
    },
    [start, end],
  )

  const reset = useCallback(() => {
    setPlaying(false)
    setCurrentTs(start)
  }, [start])

  return { currentTs, playing, speed, play, pause, setSpeed, seek, reset }
}
