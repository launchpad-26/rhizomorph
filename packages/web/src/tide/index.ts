/**
 * THE TIDE (prd13) — the scrubber's body.
 *
 * #167's three pure functions and the shapes between them: {@link bandsFor}
 * turns an event log into per-lane state bands, {@link coalesce} folds
 * slivers the caller's resolution cannot render, {@link rowPlan} decides
 * which lane gets which row. `bands.ts`/`coalesce.ts`/`rowPlan.ts` import no
 * React, read no DOM, take no clock — `purity.test.ts` holds every `.ts` file
 * in this directory to that, so a computation that needs a view has left the
 * lane by construction.
 *
 * #168 (wave 2) adds the one thing none of the three above does — a
 * timestamp → pixel mapping ({@link timeScale}, `scale.ts`) — and the `Tide`
 * component that draws with it. `Tide` computes nothing the three functions
 * above do not already hand it; see `Tide.tsx`'s own module note for what
 * that rules in and out.
 */
export {
  BAND_STATES,
  BAND_STATE_IS_LADDER_VOCABULARY,
  WORK_WITNESS_TYPES,
  bandsFor,
  laneOf,
  totalDurationMs,
  type Band,
  type BandState,
  type GapBand,
  type LaneBands,
  type StateBand,
} from './bands.js'
export { coalesce } from './coalesce.js'
export {
  rowPlan,
  type LaneRow,
  type MoreRow,
  type RowCandidate,
  type RowDescriptor,
} from './rowPlan.js'
export { formatDuration, formatClock, formatRange } from './duration.js'
export { estimateLabelWidthPx, labelFits } from './label.js'
export { layoutBands, type LaidBand } from './layout.js'
export { HOVER_PX, hoverThresholdMs, timeScale, type TimeScale } from './scale.js'
export { ROW_HEIGHT_PX, DEFAULT_TOP_N, Tide, type TideMode, type TideProps } from './Tide.js'
