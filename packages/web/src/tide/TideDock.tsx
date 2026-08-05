import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type RefObject,
} from 'react'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { Scrubber } from '../replay/Scrubber.js'
import { Tide, type TideMode } from './Tide.js'
import { timeScale } from './scale.js'
import { MAX_ZOOM_LEVEL, canShiftWindow, shiftWindow, windowForLevel } from './tideWindow.js'

/**
 * THE DOCK (prd13 wave 3, issue #169) — where "the scrubber grew a body"
 * becomes literally true. This file owns none of #167/#168's laws (it
 * imports {@link Tide} and {@link timeScale} unmodified) and none of
 * `Scrubber.tsx`'s native-input law; its only job is the geometry and state
 * that make the two read as one dock (ruling 1):
 *
 * - **One x-axis.** The Tide row and the `Scrubber` row are the two rows of a
 *   `grid-template-columns: auto 1fr auto` layout — the browser's own grid
 *   track sizing, not a hand-computed offset, is what guarantees the shared
 *   column is the same width in both rows. Exactly one {@link timeScale}
 *   call backs both the Tide's own band layout and this file's playhead
 *   line/click-to-seek math, at the default (fully zoomed-out) window that
 *   both surfaces share by default.
 * - **Collapsed vs expanded is `mode` plus one bit of local state.** Live
 *   defaults collapsed with an explicit toggle (ruling 2); replay is always
 *   expanded (ruling 3) and has no toggle — `Tide`'s own row-count law
 *   (`Tide.tsx`'s module note) does the rest.
 * - **Zoom (ruling 10) is local and visual only.** It narrows which slice of
 *   `[start, end]` the *Tide's bands* are drawn over; it never restricts what
 *   the `Scrubber` can scrub (that stays the full range always, unchanged
 *   from before this wave) and never reaches another panel, the URL, or
 *   #170's "scope to selection" (ruling 5, wave 4). `tideWindow.ts` is the
 *   pure math; this file only wires it to two buttons and a pan.
 */

export type TideDockMode = 'live' | 'replay'

export interface TideDockProps {
  mode: TideDockMode
  /** The raw log `bandsFor` folds — live's log-so-far, or replay's whole session. */
  events: readonly RhizomorphEvent[]
  /** The full mapped range: session-to-now in live (ruling 2), the whole session in replay. */
  start: number
  end: number
  /** The scrub position — `playback.currentTs`. Ignored for the playhead in live (see module note). */
  value: number
  onSeek(ts: number): void
  /** Mirrors the transport's own enable rule: off outside an active replay. */
  seekEnabled: boolean
}

const BUTTON_CLASS =
  'rounded border border-ice-850 px-1.5 py-0.5 text-[10px] leading-none text-ice-300 hover:border-ice-400 hover:text-ice-050 disabled:opacity-40 disabled:hover:border-ice-850 disabled:hover:text-ice-300'

function useElementWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (el === null) return

    const measure = () => setWidth(Math.max(0, Math.floor(el.getBoundingClientRect().width)))
    measure()

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(el)
    return () => observer?.disconnect()
  }, [])

  return [ref, width]
}

export function TideDock({ mode, events, start, end, value, onSeek, seekEnabled }: TideDockProps): ReactElement {
  const [trackRef, width] = useElementWidth()

  const [liveExpanded, setLiveExpanded] = useState(false)
  const tideMode: TideMode = mode === 'replay' || liveExpanded ? 'expanded' : 'collapsed'

  const [zoomLevel, setZoomLevel] = useState(0)
  const [windowCenter, setWindowCenter] = useState(value)

  // A newly loaded session, or a live/replay switch, means `[start, end]`
  // means something new — the previous window belonged to the old one.
  useEffect(() => {
    setZoomLevel(0)
  }, [start, end])

  const window_ = useMemo(
    () => windowForLevel(zoomLevel, windowCenter, start, end),
    [zoomLevel, windowCenter, start, end],
  )

  const scale = useMemo(() => timeScale(window_.start, window_.end, width), [window_, width])

  const zoomIn = useCallback(() => {
    setWindowCenter(value)
    setZoomLevel((level) => Math.min(MAX_ZOOM_LEVEL, level + 1))
  }, [value])

  const zoomOut = useCallback(() => setZoomLevel((level) => Math.max(0, level - 1)), [])

  const shift = useCallback(
    (direction: -1 | 1) => {
      setWindowCenter((center) => {
        const current = windowForLevel(zoomLevel, center, start, end)
        const next = shiftWindow(current, start, end, direction)
        return (next.start + next.end) / 2
      })
    },
    [zoomLevel, start, end],
  )

  const canShiftEarlier = canShiftWindow(window_, start, end, -1)
  const canShiftLater = canShiftWindow(window_, start, end, 1)

  // Live has no scrub position (the transport is disabled there); "now" —
  // the band's own right edge — is the one position that carries meaning.
  const playheadTs = mode === 'replay' ? value : end
  const showPlayhead = width > 0 && playheadTs >= window_.start && playheadTs <= window_.end
  const playheadX = showPlayhead ? scale.xOf(playheadTs) : 0

  const handleTrackClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!seekEnabled || width <= 0) return
      const rect = event.currentTarget.getBoundingClientRect()
      onSeek(scale.tsOf(event.clientX - rect.left))
    },
    [seekEnabled, width, scale, onSeek],
  )

  return (
    <div
      className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-px"
      data-testid="tide-dock"
      data-mode={mode}
      data-tide-mode={tideMode}
    >
      <div aria-hidden="true" />
      <div
        ref={trackRef}
        data-testid="tide-dock-track"
        className={`relative ${seekEnabled ? 'cursor-pointer' : ''}`}
        onClick={handleTrackClick}
      >
        {width > 0 && <Tide events={events} start={window_.start} end={window_.end} width={width} mode={tideMode} />}
        {showPlayhead && (
          <div
            aria-hidden="true"
            data-testid="tide-playhead"
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-ice-200"
            style={{ left: playheadX }}
          />
        )}
      </div>
      <div aria-hidden="true" />

      <button
        type="button"
        aria-label="Shift window earlier"
        title="Shift window earlier"
        onClick={() => shift(-1)}
        disabled={!canShiftEarlier}
        className={BUTTON_CLASS}
      >
        «
      </button>

      <Scrubber start={start} end={end} value={value} onChange={onSeek} disabled={!seekEnabled} />

      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in on the playhead"
          onClick={zoomIn}
          disabled={zoomLevel >= MAX_ZOOM_LEVEL}
          className={BUTTON_CLASS}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={zoomOut}
          disabled={zoomLevel === 0}
          className={BUTTON_CLASS}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Shift window later"
          title="Shift window later"
          onClick={() => shift(1)}
          disabled={!canShiftLater}
          className={BUTTON_CLASS}
        >
          »
        </button>
        {mode === 'live' && (
          <button
            type="button"
            aria-label={liveExpanded ? 'Collapse lane rows' : 'Expand lane rows'}
            title={liveExpanded ? 'Collapse lane rows' : 'Expand lane rows'}
            aria-pressed={liveExpanded}
            onClick={() => setLiveExpanded((expanded) => !expanded)}
            className={BUTTON_CLASS}
          >
            {liveExpanded ? 'Collapse' : 'Expand'}
          </button>
        )}
      </div>
    </div>
  )
}
