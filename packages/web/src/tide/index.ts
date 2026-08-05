/**
 * THE TIDE (prd13) — the scrubber's body.
 *
 * Ruling 13 (issue #194) cut the density band entirely: the state-fill bands,
 * the per-lane rows, the `+N` coalescing chip and the row-budget machinery
 * that sized them are gone, in every mode. What survives is the chapter-mark
 * lane, the time axis, and the transport — {@link chaptersFor} turns an event
 * log into glance-layer instants, {@link coalesceMarks} folds a dense cluster
 * of them into one counted group, and {@link ChapterMarks} is the one place
 * that draws either. `chapters.ts`/`markCoalesce.ts` import no React, read no
 * DOM, take no clock — `purity.test.ts` holds every `.ts` file in this
 * directory to that, so a computation that needs a view has left the lane by
 * construction.
 *
 * `scale.ts` (`timeScale`) and `label.ts` (`labelFits`) are the two pieces of
 * the deleted band machinery that are genuinely shared with the marks path,
 * not orphans: marks are pixels too, and a mark's short label follows the
 * same "label when it fits" law a band's used to.
 */
export {
  CHAPTER_KINDS,
  chapterLabel,
  chaptersFor,
  type Chapter,
  type ChapterKind,
} from './chapters.js'
export { laneOf } from './laneOf.js'
export { coalesceMarks, type MarkGroup } from './markCoalesce.js'
export { ChapterMarks, MARK_ROW_HEIGHT_PX, type ChapterMarksProps } from './ChapterMarks.js'
export { formatClock, formatClockSeconds } from './duration.js'
export { estimateLabelWidthPx, labelFits } from './label.js'
export { HOVER_PX, hoverThresholdMs, timeScale, type TimeScale } from './scale.js'
