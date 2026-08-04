import { useCallback, useEffect, useRef, useState } from 'react'

export type PlaybackSpeed = 1 | 4 | 16

/** The only speeds the transport offers, per prd0. */
export const PLAYBACK_SPEEDS: readonly PlaybackSpeed[] = [1, 4, 16]

export interface UsePlaybackOptions {
  start: number
  end: number
  /** Injectable clock for tests; defaults to the real one. */
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

const TICK_MS = 100

/**
 * Drives the scrubber clock forward in real time, scaled by speed, while
 * playing. Live and replay never touch this — it only exists to move the
 * `ts` that `foldUpTo` folds against.
 *
 * #155 audit: the one legitimate wall-clock read in the whole replay path.
 * This is not judging a lane's recency against real time (the bug) — it is
 * converting real elapsed seconds into simulated timeline seconds, which is
 * the transport's entire job. `currentTs` is what `ModeContext.useModeClock`
 * reads while replaying; nothing downstream of that ever calls `Date.now()`
 * on its own account.
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
    const interval = setInterval(() => {
      const nowTs = now()
      const last = lastTickRef.current ?? nowTs
      const deltaMs = (nowTs - last) * speed
      lastTickRef.current = nowTs

      setCurrentTs((prev) => {
        const next = prev + deltaMs
        return next >= end ? end : next
      })
    }, TICK_MS)

    return () => clearInterval(interval)
  }, [playing, speed, start, end, now])

  // A separate effect (rather than inlining in the tick) so it fires exactly
  // once when playback crosses the end, regardless of tick granularity.
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
