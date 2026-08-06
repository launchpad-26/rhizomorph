/**
 * WHERE THE MYCELIUM GROWS. Four facts carry meaning in the layout — see
 * docs/design-notes/geometry-layout-encoding.md for the full rationale and what
 * each one replaced:
 *
 * - **distance from the root-mass = how far through its life the lane is**
 *   (prd6 ruling 4). See {@link lifecycleFrac}.
 * - **thread width = work size, on an absolute scale, never fleet-relative**
 *   (prd6 ruling 1). See {@link seedSize}.
 * - **angular position = identity, stable for the session** (graft g7) — from
 *   {@link Lane.slot}, never reshuffled by rank, pathology or token count.
 * - **length of the drawn thread = how grown-in it is** (graft g3), over
 *   {@link SETTLE_MS}.
 *
 * The ring re-spaces when the seat count changes (a new dispatch adds a
 * seat), but never when a lane's rank, age or size changes —
 * `geometry.test.ts` pins both. A *returning* lane shares its seed's seat
 * instead of claiming a new one (prd6 ruling 3): see {@link germination}.
 *
 * The spine's sideways wander (prd7) is bounded — by {@link WANDER_MAX_SPACING}
 * of the inter-lane gap, and zero at both ends — so all four facts above
 * survive it bit for bit; `geometry.test.ts` recomputes both from the fleet to
 * prove it. `variation.ts` is the table that says where else variation may be
 * spent.
 *
 * The model, math and layout are split across `geometry/` by concern — this
 * file is the public seam every other module in the app imports through.
 */

export type {
  BudGeometry,
  FilamentGeometry,
  Knot,
  LayoutOptions,
  Point,
  RetireGeometry,
  Rogue,
  SceneGeometry,
  ThreadGeometry,
} from './geometry/types.js'

export { BUD_ABSORB_MS, budLife } from './geometry/scale.js'
export {
  LABELS_ALL_MAX,
  LIFE_SPAN_MS,
  RADIAL_BORN,
  RADIAL_RIM,
  RECENCY_SPAN_MS,
  RELAX_REACH_MAX_PX,
  RELAX_REACH_MIN_PX,
  ROOT_GROWTH,
  SEED_CEILING,
  SEED_FLOOR,
  SEED_FULL_TOKENS,
  SEED_TOKENS,
  SETTLE_MS,
  bornRadial,
  bundleRadial,
  lifecycleFrac,
  relaxReachPx,
  rootFullness,
  rootRadiusFor,
  seedSize,
} from './geometry/scale.js'
export { ringAngles, rimSpacing } from './geometry/ring.js'
export { pointAt, tangentAt } from './geometry/curves.js'
export { layoutScene } from './geometry/layout.js'
