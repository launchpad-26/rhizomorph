import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { chapterLabel, chaptersFor, type Chapter } from './chapters.js'
import { labelFits } from './label.js'
import { coalesceMarks, type MarkGroup } from './markCoalesce.js'
import { hoverThresholdMs, timeScale, type TimeScale } from './scale.js'

/**
 * THE MARK LANE (prd13 ruling 12, issue #185; rebuilt as the primary
 * navigation surface for issue #186 defect 2 — the operator's "marks are
 * dust with a hidden voice"). Every fact drawn here still comes from
 * {@link chaptersFor} and {@link coalesceMarks}; this file's job, same as
 * `Tide.tsx`'s own module note, is turning a timestamp into a pixel and a
 * fact into a glyph — the glyph itself is now a full-height tick rather than
 * a 9px diamond, and its who/what/when now lives in a styled hover card
 * instead of the platform's own `title` tooltip.
 *
 * **No new hue, no new motion (ruling 12's own words, restated by the
 * research note's non-recommendations).** Every mark, of every kind, still
 * renders in the same ink the playhead already uses (`text-ice-200`/
 * `bg-ice-200`) — colour-coding chapter kinds would grow an implicit
 * legend, which ruling 7 already forbids for bands and this file does not
 * reopen for marks. The hover card's ~150ms delay is a *timing* choice
 * about when to reveal it, never an animated reveal of the card itself —
 * nothing here transitions or slides.
 *
 * **Hit target grown without growing the glyph.** The visible tick stays
 * 2px wide; `px-[5px]` on the button around it brings the actual click/hover
 * target to 12px, the same "label when it fits, never clipped" spirit
 * `label.ts` already states for bands, reused here via {@link labelFits}
 * against the pixel gap to this mark's nearest neighbour.
 *
 * **The prd12 bridge is stated, not built.** Ruling 12: "these are exactly
 * the moments prd12 ruling 2 names as checkpoint moments … When the
 * laboratory lands, forkable marks gain the fork affordance — chapters
 * today, fork origins tomorrow, no second timeline vocabulary." The hover
 * card is that bridge's declared future home (a code comment below, not an
 * implementation): a future wave adds a `fork ⎇` row per member; it does
 * not replace this card with a second one.
 *
 * **The card portals to `document.body` (issue #189 defect 1, FATAL).**
 * Every ancestor up through the dock is `position: static` / `z-index: auto`
 * — a card left in that flow paints under whatever the dock draws after it
 * (the band, the scrubber, the axis), which is exactly the bug the operator
 * hit: "tooltips pop up BEHIND the scrub bar." `createPortal` moves the DOM
 * node itself to `document.body`, so no ancestor's stacking context or
 * `overflow` can clip or bury it; position is computed from the tick's own
 * `getBoundingClientRect()` rather than CSS flow, since the node is no
 * longer a flow-child of the tick at all. jsdom cannot hit-test
 * (`elementFromPoint` always misses), so the law that actually would have
 * caught this — the card wins the point under its own centre — is a
 * real-browser check, not a unit test; see the verification notes.
 */

export const MARK_ROW_HEIGHT_PX = 10

/** The YouTube "chapter title appears as you scrub" idiom's dock-chrome sibling — a deliberate delay, not a debounce for performance. */
const HOVER_DELAY_MS = 150

/** Gap between the tick's own bottom edge and the portaled card (issue #189) — replaces the flow-based `mt-1` now that the card is no longer a flow-child of the tick. */
const CARD_GAP_PX = 4

/**
 * A conservative half-width to keep the (centred, `-translate-x-1/2`) card
 * fully on-screen for a mark near either edge of the viewport — the same
 * "estimate conservatively" stance `label.ts` takes, since the actual
 * rendered width isn't known until after paint. The session's earliest marks
 * sit at the track's own left edge by construction (ruling 2: live and
 * replay both start the band at the session's first instant), so this is not
 * a rare corner case — it is where `lane-born` chapters live by default.
 */
const CARD_HALF_WIDTH_ESTIMATE_PX = 110

/** Left+right padding a tick's hit target gets beyond its 2px glyph — `label.ts`'s "estimate conservatively" philosophy applied to a target instead of a label. */
const MARK_HIT_PADDING_PX = 5

export interface ChapterMarksProps {
  /** The raw log. `chaptersFor` is the only thing in this file allowed to fold it. */
  events: readonly RhizomorphEvent[]
  start: number
  end: number
  width: number
  onSeek(ts: number): void
  /** Mirrors the transport's own enable rule, same prop `TideDock` already threads to the track. */
  seekEnabled: boolean
}

export function ChapterMarks({
  events,
  start,
  end,
  width,
  onSeek,
  seekEnabled,
}: ChapterMarksProps): ReactElement {
  const scale = useMemo(() => timeScale(start, end, width), [start, end, width])
  const minSpanMs = useMemo(() => hoverThresholdMs(scale), [scale])
  const chapters = useMemo(() => chaptersFor(events), [events])
  const groups = useMemo(() => coalesceMarks(chapters, minSpanMs), [chapters, minSpanMs])

  const positions = useMemo(() => groups.map((group) => scale.xOf(group.ts)), [groups, scale])

  return (
    <div
      data-testid="chapter-marks"
      role="img"
      aria-label="session chapters"
      className="relative"
      style={{ height: MARK_ROW_HEIGHT_PX, width: scale.width }}
    >
      {groups.map((group, index) => (
        <MarkView
          key={index}
          group={group}
          x={positions[index] as number}
          availableWidthPx={neighbourGapPx(positions, index, scale.width)}
          onSeek={onSeek}
          seekEnabled={seekEnabled}
        />
      ))}
    </div>
  )
}

/**
 * The pixel room this mark's short label has before it would collide with
 * the next mark or the track's right edge — only the forward gap, since the
 * label always renders to the *right* of its own tick (never left of it, so
 * a crowded predecessor to the left can never clip this mark's own text).
 * The same "estimate conservatively" stance `label.ts` already takes for
 * bands.
 */
function neighbourGapPx(positions: readonly number[], index: number, trackWidth: number): number {
  const x = positions[index] as number
  const right = index === positions.length - 1 ? trackWidth - x : (positions[index + 1] as number) - x
  return Math.max(0, right)
}

/** `"163 ▸"` for a lone mark, `"×3 ▸"` for a cluster — self-legending the way band labels already are, never a per-kind colour. */
function markShortLabel(group: MarkGroup): string {
  if (group.members.length > 1) return `×${group.members.length} ▸`
  const [member] = group.members as [Chapter]
  return `${member.lane ?? 'session'} ▸`
}

/** Where the portaled card lands — the tick's own screen rect, read once at show time and kept live while hovered (issue #189 defect 1). */
interface CardAnchor {
  left: number
  top: number
}

function MarkView({
  group,
  x,
  availableWidthPx,
  onSeek,
  seekEnabled,
}: {
  group: MarkGroup
  x: number
  availableWidthPx: number
  onSeek: (ts: number) => void
  seekEnabled: boolean
}): ReactElement {
  const [anchor, setAnchor] = useState<CardAnchor | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const measure = (): CardAnchor | null => {
    const el = wrapperRef.current
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    const centre = rect.left + rect.width / 2
    const viewportWidth = window.innerWidth
    const left = Math.min(
      Math.max(centre, CARD_HALF_WIDTH_ESTIMATE_PX),
      Math.max(CARD_HALF_WIDTH_ESTIMATE_PX, viewportWidth - CARD_HALF_WIDTH_ESTIMATE_PX),
    )
    return { left, top: rect.bottom + CARD_GAP_PX }
  }

  const scheduleShow = () => {
    clearTimer()
    timerRef.current = setTimeout(() => setAnchor(measure()), HOVER_DELAY_MS)
  }

  const hide = () => {
    clearTimer()
    setAnchor(null)
  }

  // The tick doesn't move once mounted, but the viewport it's measured
  // against can — a resize or a scroll of an ancestor while the card is open
  // must not leave it pointing at empty space (issue #189: the card is no
  // longer a flow-child, so CSS can no longer keep it glued to the tick).
  useEffect(() => {
    if (anchor === null) return
    const reposition = () => setAnchor((current) => (current === null ? current : measure()))
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor !== null])

  const label = markShortLabel(group)
  const showLabel = labelFits(availableWidthPx, label)
  const ariaText = group.members.map((member) => chapterLabel(member)).join('\n')

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    if (seekEnabled) onSeek(group.ts)
  }

  return (
    <div
      ref={wrapperRef}
      className="absolute inset-y-0 -translate-x-1/2"
      style={{ left: x }}
      onMouseEnter={scheduleShow}
      onMouseLeave={hide}
      onFocus={scheduleShow}
      onBlur={hide}
    >
      <button
        type="button"
        data-testid="chapter-mark"
        data-count={group.members.length}
        aria-label={ariaText}
        disabled={!seekEnabled}
        onClick={handleClick}
        className="relative flex h-full items-center enabled:cursor-pointer disabled:cursor-default"
        style={{ padding: `0 ${MARK_HIT_PADDING_PX}px` }}
      >
        <span aria-hidden="true" className="h-full w-0.5 bg-ice-200 disabled:opacity-70" />
        {showLabel && (
          <span
            aria-hidden="true"
            className="figures absolute left-full top-1/2 -translate-y-1/2 whitespace-nowrap pl-0.5 text-[9px] leading-none text-ice-200"
          >
            {label}
          </span>
        )}
      </button>
      {anchor !== null &&
        createPortal(
          <MarkHoverCard group={group} onSeek={onSeek} seekEnabled={seekEnabled} anchor={anchor} />,
          document.body,
        )}
    </div>
  )
}

function MarkHoverCard({
  group,
  onSeek,
  seekEnabled,
  anchor,
}: {
  group: MarkGroup
  onSeek: (ts: number) => void
  seekEnabled: boolean
  anchor: CardAnchor
}): ReactElement {
  return (
    <div
      role="dialog"
      data-testid="chapter-mark-card"
      className="z-[9999] -translate-x-1/2 whitespace-nowrap rounded border border-ice-700 bg-ice-950 p-1"
      style={{ position: 'fixed', left: anchor.left, top: anchor.top }}
    >
      {group.members.map((member, index) => (
        <button
          key={index}
          type="button"
          data-testid="chapter-mark-card-row"
          disabled={!seekEnabled}
          onClick={(event) => {
            event.stopPropagation()
            if (seekEnabled) onSeek(member.ts)
          }}
          className="figures block w-full rounded px-1 py-0.5 text-left text-[10px] leading-tight text-ice-100 enabled:cursor-pointer enabled:hover:bg-ice-900 enabled:hover:text-ice-050 disabled:cursor-default"
        >
          {chapterLabel(member)}
        </button>
      ))}
      {/*
        prd12 bridge: when the laboratory lands, each member row above
        grows a sibling "fork ⎇" row bound to that member's own
        `fork.checkpoint` — the same card, one more row per member, never a
        second timeline vocabulary (ruling 12).
      */}
    </div>
  )
}
