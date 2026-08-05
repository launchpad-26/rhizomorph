import { useMemo, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { chapterLabel, chaptersFor } from './chapters.js'
import { coalesceMarks, type MarkGroup } from './markCoalesce.js'
import { hoverThresholdMs, timeScale, type TimeScale } from './scale.js'

/**
 * THE MARK LANE (prd13 ruling 12, issue #185) — the sparse row of chapters
 * above the band. Every fact drawn here comes from {@link chaptersFor} and
 * {@link coalesceMarks}; this file's only job, same as `Tide.tsx`'s own
 * module note, is turning a timestamp into a pixel and a fact into a glyph.
 *
 * **No new hue, no new motion (ruling 12's own words).** Every mark, of every
 * kind, renders in the same ink the playhead already uses (`text-ice-200`) —
 * colour-coding chapter kinds would grow an implicit legend, which ruling 7
 * already forbids for bands and this file does not reopen for marks. Nothing
 * here animates.
 *
 * **The prd12 bridge is stated, not built.** Ruling 12: "these are exactly
 * the moments prd12 ruling 2 names as checkpoint moments … When the
 * laboratory lands, forkable marks gain the fork affordance — chapters
 * today, fork origins tomorrow, no second timeline vocabulary." This file
 * renders a chapter and nothing more: no fork affordance, no lab call, no
 * checkpoint event. A future wave that wires `fork.checkpoint` capture to
 * these same instants extends this component; it does not replace it.
 */

export const MARK_ROW_HEIGHT_PX = 10

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

export function ChapterMarks({ events, start, end, width, onSeek, seekEnabled }: ChapterMarksProps): ReactElement {
  const scale = useMemo(() => timeScale(start, end, width), [start, end, width])
  const minSpanMs = useMemo(() => hoverThresholdMs(scale), [scale])
  const chapters = useMemo(() => chaptersFor(events), [events])
  const groups = useMemo(() => coalesceMarks(chapters, minSpanMs), [chapters, minSpanMs])

  return (
    <div
      data-testid="chapter-marks"
      role="img"
      aria-label="session chapters"
      className="relative"
      style={{ height: MARK_ROW_HEIGHT_PX, width: scale.width }}
    >
      {groups.map((group, index) => (
        <MarkView key={index} group={group} scale={scale} onSeek={onSeek} seekEnabled={seekEnabled} />
      ))}
    </div>
  )
}

function MarkView({
  group,
  scale,
  onSeek,
  seekEnabled,
}: {
  group: MarkGroup
  scale: TimeScale
  onSeek: (ts: number) => void
  seekEnabled: boolean
}): ReactElement {
  const x = scale.xOf(group.ts)
  const glyph = group.members.length > 1 ? `◆(${group.members.length})` : '◆'
  const title = group.members.map((member) => chapterLabel(member)).join('\n')

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    if (seekEnabled) onSeek(group.ts)
  }

  return (
    <button
      type="button"
      data-testid="chapter-mark"
      data-count={group.members.length}
      aria-label={title}
      title={title}
      disabled={!seekEnabled}
      onClick={handleClick}
      className="figures absolute top-0 -translate-x-1/2 text-[9px] leading-none text-ice-200 enabled:cursor-pointer disabled:cursor-default disabled:opacity-70"
      style={{ left: x }}
    >
      {glyph}
    </button>
  )
}
