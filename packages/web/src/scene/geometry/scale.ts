import { DEFAULT_SUBAGENT_RECENCY_MS } from '@rhizomorph/core'
import { clamp01 } from '../palette.js'

/**
 * How long the absorption takes, in ms — deliberately the same span the
 * composting decay runs over (`DISSOLUTION.spanMs`), because it is the same
 * act at a smaller scale.
 *
 * Restated here rather than imported: `motion.ts` imports this file for
 * {@link RECENCY_SPAN_MS}, so reaching the other way would close a module
 * cycle and leave a `const` undefined at evaluation time. `geometry.test.ts`
 * pins the two numbers equal so the copy cannot drift.
 */
export const BUD_ABSORB_MS = 2_400

/**
 * HOW ALIVE A BUD IS, given how stale its newest reading has got (prd10
 * ruling 9). Exported because two things read it: a worker's bud (below) and
 * the conductor's (`marks/root.ts`, which grows off the mass and so cannot go
 * through this file's per-lane layout) — one function, so the two can never
 * disagree about when a subagent has finished.
 */
export function budLife(sinceMs: number): { vitality: number; absorb: number } {
  const expiring = Math.max(0, DEFAULT_SUBAGENT_RECENCY_MS - BUD_ABSORB_MS)
  const absorb = clamp01((Math.max(0, sinceMs) - expiring) / BUD_ABSORB_MS)
  return { vitality: 1 - absorb, absorb }
}

/** Silent this long and a lane's thread has gone as pale as it gets. */
export const RECENCY_SPAN_MS = 10 * 60_000

/**
 * ABSOLUTE SEED SIZE (prd6 ruling 1) — how much output reads as a full-grown
 * seed. The scale is **fixed**: nothing in {@link seedSize} looks at another
 * lane, so a lane's size is a fact about that lane, not the fleet's busiest
 * one. See docs/decisions/geometry-absolute-scale.md for why it takes two
 * reference points rather than one.
 */
export const SEED_TOKENS = 1_000
/** …and full size. A lane past this is drawn at the ceiling, not beyond it. */
export const SEED_FULL_TOKENS = 100_000
/**
 * The floor. A lane that has produced nothing is still a lane, and ruling 22 says
 * draw it — so a fresh seed is small and unmistakably present rather than absent.
 */
export const SEED_FLOOR = 0.08
/** The ceiling. Ruling 1's "nothing balloons", as a number rather than a hope. */
export const SEED_CEILING = 1

/**
 * A lane's seed size, 0–1, from its output tokens alone.
 *
 * Monotone, absolute, floored and capped: ten times the reference draws exactly
 * the same as the reference, and a sibling's growth cannot move it.
 */
export function seedSize(outputTokens: number): number {
  const span = Math.log1p(SEED_FULL_TOKENS) - Math.log1p(SEED_TOKENS)
  const above = Math.log1p(Math.max(0, outputTokens)) - Math.log1p(SEED_TOKENS)
  return Math.min(SEED_CEILING, Math.max(SEED_FLOOR, above / span))
}

/**
 * THE MASS GROWS WITH THE WORK (prd6 ruling 2) — a *geometry* fact, on the
 * same absolute-scale discipline as {@link seedSize}. See
 * docs/decisions/geometry-absolute-scale.md for #118's wreath finding and why
 * both constraints below matter.
 *
 * 1. The ceiling is {@link ROOT_GROWTH.maxReach} of `min(rx, ry)` — a fraction
 *    of the *scene*, not of the mass — so it cannot crowd the rim or labels at
 *    any panel shape or zoom.
 * 2. {@link bornRadial} and the bundle radius are measured off *this* grown
 *    radius, not a resting one, which is why the growth is computed here and
 *    not in the mark builder: `root.ts` must never lay a thread out against a
 *    radius that's about to change.
 */
export const ROOT_GROWTH = {
  /** Landed output below which the mass is still its own resting size. */
  seedTokens: 10_000,
  /** …and at which it has grown all the way (a long night — see the decision doc). */
  fullTokens: 2_000_000,
  /**
   * THE CAP, as a fraction of the distance from the centre to the nearest point
   * of the retirement band. Half — found empirically, not reasoned; the failure
   * modes either side of 0.5 are documented in
   * docs/decisions/geometry-absolute-scale.md. Keep it clear of both: too low
   * and the mass never escapes the newborn nodes' clearance, too high and the
   * lifecycle band (born to rim) gets squeezed into unreadability.
   */
  maxReach: 0.5,
} as const

/**
 * How full the mass is, 0–1 — the fraction of its growth it has taken home.
 * Monotone, absolute and capped, on the same discipline as {@link seedSize}.
 */
export function rootFullness(landedOutputTokens: number): number {
  const span = Math.log1p(ROOT_GROWTH.fullTokens) - Math.log1p(ROOT_GROWTH.seedTokens)
  const above = Math.log1p(Math.max(0, landedOutputTokens)) - Math.log1p(ROOT_GROWTH.seedTokens)
  return clamp01(above / span)
}

/**
 * The mass's radius on this panel, having taken this much landed work home.
 *
 * `resting` is the floor and the ceiling is the scene's own: a panel too cramped
 * for the mass to grow at all (the ceiling below its resting size) simply does not
 * grow it, rather than shrinking it — the un-instrumented floor law is that an
 * empty fleet's mass is a floor, not a void, and a cramped one is no different.
 */
export function rootRadiusFor(resting: number, rx: number, ry: number, fullness: number): number {
  const ceiling = Math.max(resting, ROOT_GROWTH.maxReach * Math.max(1, Math.min(rx, ry)))
  return resting + (ceiling - resting) * clamp01(fullness)
}

/**
 * THE LIFECYCLE JOURNEY (prd6 ruling 4) — what distance from the mass means.
 * See docs/decisions/geometry-layout-encoding.md for why this replaced
 * distance-as-recency.
 *
 * Every term in the blend must stay **monotone** — a radius that could go
 * backwards would be a lane un-living part of its life:
 *
 * - **work done** ({@link seedSize}, {@link WORK_SHARE} of the blend) — the
 *   dominant term, and the same measurement {@link seedSize} itself draws
 *   from, so the two channels cannot disagree.
 * - **age since first sighting** (over {@link LIFE_SPAN_MS}, the rest) — keeps
 *   the journey moving between snapshots even for a lane with little to show.
 * - **the terminal pin**, through `done`/`parked` only — not through any
 *   other activity state, because a lane can *leave* `waiting`, and a term it
 *   could leave would not be monotone. The pin rides the cut's own
 *   critically-damped spring (the structural class, cap and queue already pay
 *   for it) and reads {@link RetireState.drift} rather than `withdraw` — the
 *   one place the two differ, since drift is zero when the mode forbids
 *   travel, which is what keeps reduced motion's cord-severed-in-place law
 *   without this file having to know the preference exists.
 *
 * A lane whose cut is still queued behind the structural cap has no pin yet,
 * and is correctly still drawn as the living thread it visibly is.
 */
export const LIFE_SPAN_MS = 60 * 60_000
/** How much of the journey is work rather than wall-clock. Work leads. */
const WORK_SHARE = 0.65
/**
 * Where a newborn lane sits, as a fraction of the rim — close in, but a thread
 * rather than a smudge on the mass, and clear of the bundle trunk at 0.32.
 *
 * A *fraction*, so it is only half the answer: on a cramped panel the rim can
 * close in on the mass until 42% of it is inside the mass, and a node born inside
 * the thing it grew out of is not a picture of anything. {@link bornRadial} is the
 * other half.
 */
export const RADIAL_BORN = 0.42
/** …and where it comes to rest. The rim is retirement. */
export const RADIAL_RIM = 1
/** How much daylight a newborn node keeps between itself and the mass. */
const BORN_CLEARANCE_PX = 10
/**
 * …and how much the bundle trunk keeps. Less, because it is a control point on a
 * curve rather than a drawn node: it only has to sit *outside* the surface, so
 * that a thread leaving the mass leans toward its neighbours instead of bowing
 * back into the body it just came out of.
 */
const BUNDLE_CLEARANCE_PX = 4
/**
 * Where neighbours share a trunk on the way out, as a fraction of the rim
 * (see {@link BUNDLE_SIZE}) — the floor, on a scene whose mass has not grown.
 */
const RADIAL_BUNDLE = 0.32

/**
 * {@link RADIAL_BORN}, pushed out far enough that a newborn node clears the
 * mass on this panel. Measured against the *smaller* half-axis, the direction
 * the rim runs closest to the mass in.
 *
 * `rootRadius` must be the mass's *grown* radius (#118), not a resting one —
 * otherwise the mass fills the empty middle it was grown to fill and swallows
 * the youngest lane in the fleet along with it.
 */
export function bornRadial(rootRadius: number, rx: number, ry: number): number {
  const smaller = Math.max(1, Math.min(rx, ry))
  return Math.min(0.9, Math.max(RADIAL_BORN, (rootRadius + BORN_CLEARANCE_PX) / smaller))
}

/** The same, for the shared trunk — always inside {@link bornRadial}. */
export function bundleRadial(rootRadius: number, rx: number, ry: number): number {
  const smaller = Math.max(1, Math.min(rx, ry))
  return Math.min(0.88, Math.max(RADIAL_BUNDLE, (rootRadius + BUNDLE_CLEARANCE_PX) / smaller))
}

/**
 * How far through its life a lane is, 0–1. `homecoming` is the withdraw of its
 * cord-cut — 0 for every lane still in the network.
 */
export function lifecycleFrac(
  sizeFrac: number,
  sinceFirstSeenMs: number,
  homecoming: number,
): number {
  const worked = clamp01(sizeFrac)
  const aged = clamp01(Math.max(0, sinceFirstSeenMs) / LIFE_SPAN_MS)
  const living = clamp01(WORK_SHARE * worked + (1 - WORK_SHARE) * aged)
  // The pin closes whatever distance is left, over the cut's own withdraw, so a
  // landing arrives at the rim instead of teleporting to it.
  return living + (1 - living) * clamp01(homecoming)
}

/**
 * How long a newly discovered lane takes to grow in (graft g3). Long enough to
 * read as growth, short enough that it is over before anyone looks twice.
 * Matches `--duration-settle` in the theme.
 */
export const SETTLE_MS = 900

/**
 * Where labels stop being drawn for every lane. B and C independently predicted
 * label collisions near 30–35 lanes (ruling 31), so the retreat is armed just
 * below that — and at the twenty-lane fixture every label still renders.
 */
export const LABELS_ALL_MAX = 28

/**
 * THE RELAX REACH, **in px of arc length, not a fraction of it** (the rim is
 * a wide ellipse — see docs/decisions/geometry-relax-reach.md, #102): how much
 * of a finished strand ({@link RETIRE_RELAX_PX} is how far it bends,
 * this is how much of it) eases outward past the rim, sized by the lane's own
 * work ({@link seedSize}) so thirty finished lanes end at thirty different radii.
 */
export const RELAX_REACH_MIN_PX = 16
export const RELAX_REACH_MAX_PX = 88

/** The relax reach a lane of this work-size takes, in px of arc. */
export function relaxReachPx(sizeFrac: number): number {
  return RELAX_REACH_MIN_PX + (RELAX_REACH_MAX_PX - RELAX_REACH_MIN_PX) * clamp01(sizeFrac)
}
