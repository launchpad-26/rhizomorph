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
import { hoverThresholdMs, timeScale } from './scale.js'

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
 * **The wrack line (prd-13 amendment, operator-directed 2026-08-20).** The
 * uniform 2px tick grew into a glyph vocabulary, one shape per chapter kind:
 * a filled sprout dot for `lane-born`, a hollow ring for `lane-landed`, a
 * thorn for `gate-held`, a double bar for `session-boundary`, and a braided
 * stem with a count for a coalesced cluster. **Shape is the legend, hue only
 * reinforces it** — each glyph wears the *existing* status ink its fact
 * already means everywhere else (born/working green, landed/done green,
 * gate/needs-you amber; boundaries and clusters are structure and wear
 * structural ink), so law 9's greyscale-survival clause holds on shape alone
 * and "no new hue" holds by construction. Ruling 12's original cut kept every
 * mark in one ink to avoid an implicit legend; the amendment records why the
 * glyphs supersede that: a shape a hover card names is self-legending the
 * same way `×N` already was. The hover card's ~150ms delay is a *timing*
 * choice about when to reveal it, never an animated reveal of the card
 * itself — nothing here transitions or slides.
 *
 * **Hit target grown with the lane.** The visible glyph is ≤8px wide;
 * `px-[7px]` on the button around it brings the actual click/hover target to
 * ~22px in a 24px lane, the same "label when it fits, never clipped" spirit
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
 *
 * **The card shell is `pointer-events: none` (issue #232, the same defect
 * class one lane later).** Portaling fixed *where* the card paints, but not
 * that it still sat in the hit-test tree: a mark's hoverable strip is only
 * `MARK_ROW_HEIGHT_PX` tall, and a cursor resting near its lower edge could
 * land the card underneath it once mounted, so the browser's own
 * hit-test — not this file's state — flipped the mark's hover on/off at
 * frame rate (hover → mount → the card wins the point → mouseout → unmount
 * → mouseover → hover, repeat). `pointer-events: none` on the card removes
 * it from hit-testing entirely, so it can never become the element a
 * mouseover/mouseout resolves to; each row un-sets that back to `auto` so
 * the cluster's own click-to-seek keeps working, since only the mark's own
 * enter/leave ever drives `anchor` (never the card's).
 */

export const MARK_ROW_HEIGHT_PX = 24

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

/** Left+right padding a glyph's hit target gets beyond its own width — `label.ts`'s "estimate conservatively" philosophy applied to a target instead of a label. */
const MARK_HIT_PADDING_PX = 7

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

/**
 * `"163"` for a lone mark, `"×3"` for a cluster. The trailing `▸` died with
 * the wrack line: it existed to say "this seeks", which the glyph's own
 * cursor and shape now say — a label is a name, not an affordance.
 */
function markShortLabel(group: MarkGroup): string {
  if (group.members.length > 1) return `×${group.members.length}`
  const [member] = group.members as [Chapter]
  return member.lane ?? 'session'
}

/** Which glyph the group wears: its single member's own kind, or the braid. */
function glyphKindOf(group: MarkGroup): Chapter['kind'] | 'cluster' {
  if (group.members.length > 1) return 'cluster'
  const [member] = group.members as [Chapter]
  return member.kind
}

/**
 * THE GLYPHS — one shape per chapter kind, drawn in CSS so the whole lane
 * stays a handful of spans. Every shape rises from the lane's floor on a
 * quiet stem (the kind's own ink at reduced presence); the head is what
 * differs, and it differs in *shape* first so the vocabulary survives
 * greyscale (law 9). All spans are `aria-hidden` — the button's own
 * `aria-label` already carries every member's who/what/when in words.
 */
function MarkGlyph({ kind }: { kind: Chapter['kind'] | 'cluster' }): ReactElement {
  switch (kind) {
    case 'lane-born':
      return (
        <span aria-hidden="true" className="pointer-events-none">
          <span className="absolute bottom-0 left-1/2 h-2.5 w-0.5 -translate-x-1/2 bg-(--color-working) opacity-40" />
          <span className="absolute bottom-2 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-(--color-working)" />
        </span>
      )
    case 'lane-landed':
      return (
        <span aria-hidden="true" className="pointer-events-none">
          <span className="absolute bottom-0 left-1/2 h-2.5 w-0.5 -translate-x-1/2 bg-(--color-done) opacity-40" />
          <span className="absolute bottom-2 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full border-2 border-(--color-done)" />
        </span>
      )
    case 'gate-held':
      return (
        <span aria-hidden="true" className="pointer-events-none">
          <span className="absolute bottom-0 left-1/2 h-2.5 w-0.5 -translate-x-1/2 bg-(--color-needs-you) opacity-40" />
          <span className="absolute bottom-2 left-1/2 h-0 w-0 -translate-x-1/2 border-x-4 border-b-8 border-x-transparent border-b-(--color-needs-you)" />
        </span>
      )
    case 'session-boundary':
      return (
        <span aria-hidden="true" className="pointer-events-none">
          <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-[3px] bg-(--ink-dim)" />
          <span className="absolute inset-y-0 left-1/2 w-0.5 translate-x-px bg-(--ink-dim)" />
        </span>
      )
    case 'cluster':
      return (
        <span aria-hidden="true" className="pointer-events-none">
          <span className="absolute bottom-0 left-1/2 h-2 w-0.5 -translate-x-[5px] bg-(--ink-body) opacity-60" />
          <span className="absolute bottom-0 left-1/2 h-3.5 w-0.5 -translate-x-1/2 bg-(--ink-body)" />
          <span className="absolute bottom-0 left-1/2 h-2 w-0.5 translate-x-[3px] bg-(--ink-body) opacity-60" />
        </span>
      )
  }
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
        className="relative flex h-full w-2 items-end justify-center enabled:cursor-pointer disabled:cursor-default disabled:opacity-70"
        style={{ padding: `0 ${MARK_HIT_PADDING_PX}px`, boxSizing: 'content-box' }}
      >
        <MarkGlyph kind={glyphKindOf(group)} />
        {showLabel && (
          <span
            aria-hidden="true"
            className={`figures absolute bottom-0.5 left-full whitespace-nowrap pl-1 text-inst leading-none ${
              group.members.length > 1 ? 'font-semibold text-(--ink-body)' : 'text-(--ink-dim)'
            }`}
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
      className="pointer-events-none z-[9999] -translate-x-1/2 whitespace-nowrap rounded border border-(--line-strong) bg-(--surface-panel) p-1"
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
          className="figures pointer-events-auto block w-full rounded px-1 py-0.5 text-left text-inst-dense leading-tight text-(--ink-body) enabled:cursor-pointer enabled:hover:bg-(--surface-raised) enabled:hover:text-(--ink-primary) disabled:cursor-default"
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
