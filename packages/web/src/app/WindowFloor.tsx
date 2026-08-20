import type { ReactNode } from 'react'
import { useWindowSize } from './windowSize.js'

/**
 * THE WINDOW FLOOR (S5, prd-32 ruling 10) — the instrument is laptop-first:
 * ~1440×900 is the primary target and the layout scales up gracefully above
 * it. Below this hard minimum there is no honest way to lay the shell out, so
 * the whole app frame is replaced by one panel that says so — the same
 * honest-gap voice used for missing data (`recordings/RecordingsPage.tsx`'s
 * `no recordings yet`, `lab/LabPage.tsx`'s two empty sentences), applied to
 * its own frame. Never a silently broken layout: nothing below the floor
 * renders anything else.
 */
export const WINDOW_MIN_WIDTH = 1100
export const WINDOW_MIN_HEIGHT = 700

function isBelowFloor(width: number, height: number): boolean {
  return width < WINDOW_MIN_WIDTH || height < WINDOW_MIN_HEIGHT
}

export function WindowFloor({ children }: { children: ReactNode }) {
  const { width, height } = useWindowSize()
  if (isBelowFloor(width, height)) {
    return <BelowFloorPanel width={width} height={height} />
  }
  return <>{children}</>
}

function BelowFloorPanel({ width, height }: { width: number; height: number }) {
  return (
    <div
      role="status"
      data-testid="window-floor"
      className="flex h-screen flex-col items-center justify-center gap-3 bg-(--surface-floor) px-6 text-center font-sans text-(--ink-body)"
    >
      <p className="max-w-md font-mono text-read-floor leading-snug text-(--ink-dim)">
        THIS WINDOW IS TOO SMALL FOR THE INSTRUMENT — the minimum is{' '}
        <span className="figures text-(--ink-primary)">
          {WINDOW_MIN_WIDTH}×{WINDOW_MIN_HEIGHT}
        </span>
        , this window is{' '}
        <span data-testid="window-floor-current" className="figures text-(--ink-primary)">
          {width}×{height}
        </span>
        . Resize it and the instrument resumes.
      </p>
    </div>
  )
}
