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
import { ChapterMarks } from './ChapterMarks.js'
import { chapterLabel, chaptersFor } from './chapters.js'
import { formatClock } from './duration.js'
import { medianEventSpacingMs } from './eventSpacing.js'
import { coalesceMarks } from './markCoalesce.js'
import { hoverThresholdMs, timeScale } from './scale.js'
import { canShiftWindow, shiftWindow, usefulMaxZoomLevel, windowForLevel, zoomFractionLabel } from './tideWindow.js'

/**
 * THE DOCK (prd13 wave 3, issue #169 — cut down to its final shape by ruling
 * 13, issue #194: "get rid of the working green strips entirely"). What's
 * left is exactly what ruling 13 names: the chapter-mark lane, the time
 * axis, and the transport — a line of moments over a scrubber. Nothing else.
 *
 * - **One x-axis.** The mark row and the `Scrubber` row are two rows of a
 *   `grid-template-columns: auto 1fr auto` layout — the browser's own grid
 *   track sizing, not a hand-computed offset, is what guarantees the shared
 *   column is the same width in both rows. Exactly one {@link timeScale}
 *   call backs this file's own playhead line/click-to-seek math and
 *   `ChapterMarks`' own mark layout, at the default (fully zoomed-out) window
 *   every surface shares by default.
 * - **The mark lane (ruling 12) is `ChapterMarks`, unmodified**, doubling as
 *   the click-to-seek/pan/zoom detail track (below) since there is no longer
 *   a separate band row to host those handlers.
 * - **Zoom (ruling 10) is local and visual only.** It narrows which slice of
 *   `[start, end]` the mark lane is drawn over; it never restricts what the
 *   `Scrubber` can scrub (that stays the full range always) and never
 *   reaches another panel, the URL, or #170's "scope to selection".
 *   `tideWindow.ts` is the pure math; this file only wires it to two buttons
 *   and a pan.
 * - **One height, not a mode-dependent one (ruling 13).** #186 defect 4 grew
 *   a taller mark lane and row height for replay because replay's per-lane
 *   rows were the dock's primary control and earned the room; with the rows
 *   gone there is nothing left to earn it for, so `ChapterMarks` renders at
 *   its one default height in both modes and the axis appears whenever
 *   zoomed, in either mode — not gated to replay.
 *
 * **One draggable body, not two (issue #186 restating ruling 1).** The
 * `Scrubber` beneath is the *overview* — full range, the only element with a
 * grab affordance, unchanged. The mark lane above is the *detail* — windowed
 * under zoom, click-to-seek, never drag-grabbable (the playhead stays the
 * same `pointer-events-none` hairline it always was). When zoomed, this file
 * draws a still bracket over the `Scrubber` track, in the *full-range*
 * `timeScale` (a second `timeScale` call, deliberately — the windowed scale
 * above never touches the overview), plus a `figures`-voice label in the
 * button cluster (`window 1/4 · 14:02–14:31`, research note §4 R1). Dragging
 * on the mark lane pans the window (click-vs-drag threshold, ~4px) and
 * Shift+wheel zooms about the cursor's own timestamp — both read through the
 * exact same windowed `timeScale` click-to-seek already used, so "seek is
 * exact at every zoom level" extends to these two gestures rather than
 * competing with it. `[` / `]` step to the neighbouring chapter at the dock
 * level, never claiming a key the native range input owns (R3). Zoom depth
 * itself is capped by `usefulMaxZoomLevel` (`tideWindow.ts`) — the log's own
 * median event spacing, not an arbitrary ceiling.
 */

export type TideDockMode = 'live' | 'replay'

export interface TideDockProps {
  mode: TideDockMode
  /** The raw log — live's log-so-far, or replay's whole session. */
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

/** The click-vs-drag boundary on the mark lane track (research note §4 R4). Below it, a mousedown+mouseup is a seek; at or past it, it is a pan. */
const PAN_THRESHOLD_PX = 4

/** Typing surfaces the dock's `[`/`]` chapter-step keys must not steal from — the native range input owns none of these keys, so it is deliberately not one of them. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.tagName === 'TEXTAREA') return true
  return target.tagName === 'INPUT' && target.getAttribute('type') !== 'range'
}

export function TideDock({ mode, events, start, end, value, onSeek, seekEnabled }: TideDockProps): ReactElement {
  const [trackRef, width] = useElementWidth()

  const [zoomLevel, setZoomLevel] = useState(0)
  const [windowCenter, setWindowCenter] = useState(value)

  // A newly loaded session, or a live/replay switch, means `[start, end]`
  // means something new — the previous window belonged to the old one.
  useEffect(() => {
    setZoomLevel(0)
  }, [start, end])

  // Issue #186 defect 3: depth is capped by the log's own grain, never
  // offered past the point where clusters have already split.
  const medianSpacing = useMemo(() => medianEventSpacingMs(events), [events])
  const maxZoomLevel = useMemo(
    () => usefulMaxZoomLevel(Math.max(1, end - start), width, medianSpacing),
    [end, start, width, medianSpacing],
  )

  const window_ = useMemo(
    () => windowForLevel(zoomLevel, windowCenter, start, end),
    [zoomLevel, windowCenter, start, end],
  )

  const scale = useMemo(() => timeScale(window_.start, window_.end, width), [window_, width])
  // The overview's own scale — full range, never the windowed one — is the
  // one this file needs to draw the window bracket over the `Scrubber` in
  // the *overview's* coordinates (research note §4 R1), a second and
  // deliberately distinct `timeScale` call from the one above.
  const fullScale = useMemo(() => timeScale(start, end, width), [start, end, width])

  const zoomIn = useCallback(() => {
    setWindowCenter(value)
    setZoomLevel((level) => Math.min(maxZoomLevel, level + 1))
  }, [value, maxZoomLevel])

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
  // the mapped range's own right edge — is the one position that carries
  // meaning.
  const playheadTs = mode === 'replay' ? value : end
  const showPlayhead = width > 0 && playheadTs >= window_.start && playheadTs <= window_.end
  const playheadX = showPlayhead ? scale.xOf(playheadTs) : 0

  // A drag that crossed the pan threshold suppresses the click-to-seek that
  // would otherwise follow on mouseup — one gesture is either a seek or a
  // pan, never both (research note §4 R4: "drag-on-track pans when zoomed").
  const justPannedRef = useRef(false)

  const handleTrackClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (justPannedRef.current) {
        justPannedRef.current = false
        return
      }
      if (!seekEnabled || width <= 0) return
      const rect = event.currentTarget.getBoundingClientRect()
      onSeek(scale.tsOf(event.clientX - rect.left))
    },
    [seekEnabled, width, scale, onSeek],
  )

  const handleTrackMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (width <= 0) return
      const startX = event.clientX
      const startCenter = (window_.start + window_.end) / 2
      const pxPerMs = width / Math.max(1, window_.end - window_.start)
      let dragging = false

      const handleMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX
        if (!dragging && Math.abs(dx) < PAN_THRESHOLD_PX) return
        dragging = true
        setWindowCenter(startCenter - dx / pxPerMs)
      }

      const handleUp = () => {
        document.removeEventListener('mousemove', handleMove)
        document.removeEventListener('mouseup', handleUp)
        justPannedRef.current = dragging
      }

      document.addEventListener('mousemove', handleMove)
      document.addEventListener('mouseup', handleUp)
    },
    [width, window_],
  )

  // Shift+wheel zooms about the cursor's own timestamp (Audacity's
  // pointer-anchored law), modifier-gated so an un-shifted wheel keeps
  // scrolling the page (DevTools' two-mode lesson) — research note §4 R4.
  //
  // Wired as a *native* listener rather than React's `onWheel` prop: React
  // registers `wheel`/`touchstart`/`touchmove` passively at the root for
  // scroll-perf reasons, and a passive listener's `preventDefault()` is a
  // silent no-op in a real browser (confirmed via the actual "Unable to
  // preventDefault inside passive event listener invocation" console error —
  // jsdom does not enforce this, so the unit tests alone never caught it).
  // `{ passive: false }` here is what makes the modifier gate actually gate.
  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (!event.shiftKey || width <= 0) return
      const el = trackRef.current
      if (el === null) return
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const cursorTs = scale.tsOf(event.clientX - rect.left)
      const direction = event.deltaY < 0 ? 1 : -1
      setWindowCenter(cursorTs)
      setZoomLevel((level) => Math.min(maxZoomLevel, Math.max(0, level + direction)))
    },
    [width, scale, maxZoomLevel, trackRef],
  )

  useEffect(() => {
    const el = trackRef.current
    if (el === null) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel, trackRef])

  // The same chapter groups `ChapterMarks` renders for this window — built
  // here too (rather than read back from the child) so `[`/`]` steps to
  // exactly the glyph the operator sees, never a second, silently divergent
  // notion of "the next mark" (ruling 1's one-scale law, restated for marks).
  const chapters = useMemo(() => chaptersFor(events), [events])
  const markMinSpanMs = useMemo(() => hoverThresholdMs(scale), [scale])
  const markGroups = useMemo(() => coalesceMarks(chapters, markMinSpanMs), [chapters, markMinSpanMs])

  const stepChapter = useCallback(
    (direction: -1 | 1) => {
      if (!seekEnabled || markGroups.length === 0) return
      if (direction === 1) {
        const next = markGroups.find((group) => group.ts > value)
        if (next !== undefined) onSeek(next.ts)
      } else {
        let prev: (typeof markGroups)[number] | undefined
        for (const group of markGroups) {
          if (group.ts < value) prev = group
        }
        if (prev !== undefined) onSeek(prev.ts)
      }
    },
    [seekEnabled, markGroups, value, onSeek],
  )

  useEffect(() => {
    if (!seekEnabled) return
    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return
      if (event.key === ']') stepChapter(1)
      else if (event.key === '[') stepChapter(-1)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [seekEnabled, stepChapter])

  // Sorted, unclustered — the drag-label idiom (research note §4 R2, "the
  // nearest chapter's label shows above the thumb") wants every real
  // instant, not the window-scoped coalesced groups above.
  const chapterMarkers = useMemo(() => chapters.map((chapter) => ({ ts: chapter.ts, label: chapterLabel(chapter) })), [chapters])

  const zoomed = zoomLevel > 0
  // Ruling 13: no mode-dependent height left to gate this on — the axis
  // shows whenever zoomed, in either mode.
  const showAxis = zoomed

  const bracketLeft = zoomed ? fullScale.xOf(window_.start) : 0
  const bracketWidth = zoomed ? Math.max(1, fullScale.xOf(window_.end) - bracketLeft) : 0

  return (
    <div
      className="grid grid-cols-[auto_1fr_minmax(0,auto)] items-center gap-x-2 gap-y-px"
      data-testid="tide-dock"
      data-mode={mode}
    >
      <div aria-hidden="true" />
      <div
        ref={trackRef}
        data-testid="tide-dock-track"
        className={`relative ${seekEnabled ? 'cursor-pointer' : ''}`}
        onClick={handleTrackClick}
        onMouseDown={handleTrackMouseDown}
      >
        {width > 0 && (
          <ChapterMarks
            events={events}
            start={window_.start}
            end={window_.end}
            width={width}
            onSeek={onSeek}
            seekEnabled={seekEnabled}
          />
        )}
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

      {showAxis && (
        <>
          <div aria-hidden="true" />
          <div
            data-testid="tide-axis"
            className="figures flex items-center justify-between text-[8px] leading-none text-ice-400"
          >
            <span>{formatClock(window_.start)}</span>
            <span>{formatClock(window_.end)}</span>
          </div>
          <div aria-hidden="true" />
        </>
      )}

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

      <div className="relative">
        <Scrubber
          start={start}
          end={end}
          value={value}
          onChange={onSeek}
          disabled={!seekEnabled}
          chapterMarkers={chapterMarkers}
        />
        {zoomed && width > 0 && (
          <div
            aria-hidden="true"
            data-testid="tide-window-bracket"
            className="pointer-events-none absolute -top-1 h-1.5 border-l border-r border-t border-ice-400"
            style={{ left: bracketLeft, width: bracketWidth }}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-1">
        {zoomed && (
          <span
            className="figures min-w-0 max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap text-[10px] leading-none text-ice-400"
            data-testid="window-indicator"
          >
            window {zoomFractionLabel(zoomLevel)} · {formatClock(window_.start)}–{formatClock(window_.end)}
          </span>
        )}
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in on the playhead"
          onClick={zoomIn}
          disabled={zoomLevel >= maxZoomLevel}
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
      </div>
    </div>
  )
}
