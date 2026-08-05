/**
 * THE TIDE (prd13) — the scrubber's body, computed.
 *
 * Three pure functions and the shapes between them: {@link bandsFor} turns an
 * event log into per-lane state bands, {@link coalesce} folds slivers the
 * caller's resolution cannot render, {@link rowPlan} decides which lane gets
 * which row. Waves 2–4 draw from exactly this and add nothing to it.
 *
 * Nothing here imports React, reads the DOM, or takes a clock.
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
