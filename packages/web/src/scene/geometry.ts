import { DEFAULT_SUBAGENT_RECENCY_MS } from '@rhizomorph/core'
import type { Fleet, Lane, PathologyKind } from '../fleet/index.js'
import { clamp01 } from './palette.js'
import type { RetireState } from './retire.js'
import { smoothSpine } from './ribbon.js'
import { isAlarmRank } from './salience.js'
import { WANDER_MAX_SPACING, variationFor, variationSeed } from './variation.js'

/**
 * WHERE THE MYCELIUM GROWS. Four facts carry meaning in the layout — see
 * docs/decisions/geometry-layout-encoding.md for the full rationale and what
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
 */

export interface Point {
  x: number
  y: number
}

export interface Knot {
  centre: Point
  radius: number
  /** Direction of the thread where the knot is tied — the orbit's zero phase. */
  tangent: number
}

export interface Rogue {
  /** Node → the fence it crossed. Stops short: a reach, not an arrival. */
  path: Point[]
  /** The lane whose fence claims the touched files, when the manifest named one. */
  victimId: string | null
}

export interface FilamentGeometry {
  /** Where it splits off the parent thread. 0 = root-mass, 1 = node. */
  at: number
  path: Point[]
  width: number
  /**
   * Finer hyphae in the bundle. This is request **volume**, not a count of
   * distinct subagents: the log names exactly three thread kinds, so a strand
   * count that implied otherwise would be an invented number. The honesty note
   * stands until the collectors name individual threads.
   */
  strands: Point[][]
  thread: string
}

/**
 * A SUBAGENT BUD (prd10 ruling 9) — a side-branchlet off the parent's own thread.
 *
 * Null for a lane with no live subagent reading — the majority case, and the
 * honest picture rather than a gap: `lane.subagents` is `null` whenever no
 * `thread: 'subagent'` telemetry has reached that lane inside core's own
 * recency window.
 *
 * The one number worth reading twice is {@link vitality}. The vital the chips
 * lane landed reports the *newest* thread-marked reading, not a start and an
 * end — so "the bud is live" is a claim with an expiry rather than a state
 * with an off switch, and this file draws exactly that: the branchlet is full
 * while the evidence is fresh and **retracts into its parent over the last
 * {@link BUD_ABSORB_MS} of the window**, so it is gone at the instant the
 * reading would have expired. It is stateless — no registry, no remembered
 * spawn, and therefore identical in a live scene and in a replay.
 */
export interface BudGeometry {
  /** Where it branches off the parent thread. 0 = root-mass, 1 = node. */
  at: number
  /** Junction → tip. Shortens as the bud is absorbed. */
  path: Point[]
  width: number
  /** The tip, kept because both the flare and the absorption are drawn there. */
  tip: Point
  /** 0–1: 1 while the reading is fresh, 0 once it has expired. */
  vitality: number
  /** 0–1 through the absorption. 0 while the bud is simply live. */
  absorb: number
  /** ms since the newest thread-marked reading — what the spawn flare rides. */
  sinceMs: number
  /**
   * `subagentType` from a matching trace span, or null. Enrichment only: a lane
   * can be live with no trace, never the other way round (`selectSubagentActivity`).
   */
  kind: string | null
}

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

/** How far along the parent a bud branches off, and how far it reaches. */
const BUD_AT = 0.46
const BUD_LENGTH_PX = { min: 13, span: 15 } as const

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

/**
 * THE RETURN, as shape (prd10 rulings 13–15). Null for every lane still
 * working. The retirement's *timing* is `retire.ts`'s; this is what those
 * numbers do to the picture — a **strand**, not a remnant. Nothing here
 * shortens it or returns an empty path. See
 * docs/decisions/geometry-return-as-shape.md.
 *
 * Carried beside the living geometry rather than replacing it:
 * {@link ThreadGeometry.path} is the undeformed spine that light already in
 * flight (a landing packet takes 2.8s to reach the mass, longer than the
 * 1.4s settle) and the returning motes still travel along; this is that
 * spine with the release (slack at the root, outward relax at the tip)
 * folded in.
 */
export interface RetireGeometry extends RetireState {
  /** The whole strand, root-mass rim → node, with the release folded into it. */
  path: Point[]
  /** The strand's widths, with the released taper already relaxed into them. */
  widthRoot: number
  widthTip: number
  /** THE WAY HOME (prd6 ruling 2) — see {@link homewardFlow}. Null when nothing is in transit. */
  homeward: Point[] | null
  /**
   * The operator's hide-finished toggle applies to this lane, so it draws
   * nothing at all. Only ever true of a lane that has reached `persistent` — a
   * return in progress is news and is always shown, because the one thing worse
   * than a finished lane you did not want to see is a completion you never saw.
   *
   * Load-bearing since ruling 16: with the network persisting, this is the *only*
   * thing that takes a finished lane off the canvas, and the ruling is explicit
   * that it stays obvious (`SceneView`'s control carries its own count).
   */
  hidden: boolean
}

export interface ThreadGeometry {
  laneId: string
  lane: Lane
  /** Stable for the session — see the note above. */
  angle: number
  /**
   * Sampled centreline, root-mass rim → node. Everything else indexes into it —
   * including, deliberately, the light in flight over a thread that is being
   * cut. See {@link RetireGeometry}.
   */
  path: Point[]
  node: Point
  /** Outward unit normal of the rim at this lane's angle — where its label goes. */
  outward: Point
  widthRoot: number
  widthTip: number
  /**
   * 0–1 work size on the absolute scale (prd6 ruling 1) — {@link seedSize} of
   * this lane's output, floored at {@link SEED_FLOOR} and capped at
   * {@link SEED_CEILING}. Never a comparison with another lane.
   */
  sizeFrac: number
  /**
   * 0–1, where 0 = spoke just now and 1 = silent for {@link RECENCY_SPAN_MS}.
   *
   * Recency, and **only** the lightness channel reads it now: prd6 ruling 4 took
   * the radius off it and gave the radius to the lifecycle. See
   * {@link lifeFrac}.
   */
  ageFrac: number
  /**
   * 0–1 how far through its life this lane is — what {@link node}'s distance from
   * the root-mass draws (prd6 ruling 4). 1 for a lane that has come home.
   */
  lifeFrac: number
  /**
   * The retired lane whose seed this thread grew out of (prd6 ruling 3), or null
   * for a lane that started life somewhere new. A germinated lane shares its
   * seed's angle and inherits its size as a floor.
   */
  germinatedFrom: string | null
  /** 0–1 grow-in progress. 1 for every lane that was already there (graft g3). */
  growth: number
  filaments: FilamentGeometry[]
  /**
   * This lane's live subagent branchlet (prd10 ruling 9), or null. One level deep,
   * and one bud: `parent_agent_id` is uncaptured and the vital reports one row per
   * lane, so a second level would be a number nothing measured.
   */
  bud: BudGeometry | null
  knot: Knot | null
  rogue: Rogue | null
  label: { anchor: Point; align: 'left' | 'right' | 'centre' }
  /** The worst fault this lane carries — what the node's behaviour draws. */
  pathology: PathologyKind | null
  /** True at needs-you or broken: this lane's marks are exempt from every fade. */
  alarm: boolean
  /** Non-null once this lane has left the living network (prd5 ruling 3). */
  retire: RetireGeometry | null
}

export interface SceneGeometry {
  width: number
  height: number
  centre: Point
  /**
   * The mass's radius **as this frame draws it** — its resting size grown by
   * whatever work has landed (#118, {@link rootRadiusFor}), before the breath.
   *
   * Everything that has to stay clear of the mass reads this rather than a
   * resting size: the newborn radius, the bundle trunk, the hit target and the
   * camera's empty-scene bounds. `marks/root.ts` draws exactly this radius.
   */
  rootRadius: number
  /** How full the mass is, 0–1 — {@link rootFullness} of the work landed so far. */
  rootFullness: number
  /** Half-axes of the rim: where a fully-drifted node sits. */
  rx: number
  ry: number
  threads: ThreadGeometry[]
  byLane: Map<string, ThreadGeometry>
  /**
   * Ruling 31's named cheap retreat. `all` up to {@link LABELS_ALL_MAX} lanes;
   * past it only the hovered, spotlit and alarmed lanes are named. Lanes are
   * never hidden — that stayed off the table.
   */
  labelPolicy: 'all' | 'hover'
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

/**
 * …but never more than this much of a short strand. On a cramped panel a lane's
 * whole thread can be shorter than the reach, and a bend that consumed all of it
 * would have lifted the strand off the mass it is threaded into.
 */
const RELAX_MAX_FRACTION = 0.58

/**
 * THE DRIFT BAND (#117) — how far a finished lane's *tip* relaxes outward, on
 * top of the lifecycle pin's own journey to the rim: a local bend, each lane
 * by its own amount between `min` and `max`. See
 * docs/decisions/geometry-relax-reach.md for why a band and why seeded from
 * the lane's identity rather than from when it retired.
 *
 * Outward only, so a retired lane stays at the rim or past it and a living
 * one stays inside it — no amount of scatter may blur that line.
 */
const RETIRE_RELAX_PX = { min: 3, max: 27 } as const

/**
 * How long the returning substance is, in px of the thread it is made of
 * (prd6 ruling 2) — measured in px for the same reason the scar is, so a lane at
 * three o'clock does not send home three times as much matter as one at noon.
 */
const HOMEWARD_LENGTH_PX = 30

/**
 * How far the root end of the thread bows out as the tension leaves it, as a
 * fraction of the smaller rim half-axis — clamped, so the slack is the same
 * perceptible sag on a tall panel and on a letterbox one.
 */
const SLACK_FRACTION = 0.06
const SLACK_MIN_PX = 4
const SLACK_MAX_PX = 12
/**
 * …times the lane's own habit. The same free phase the drift band reads, taken
 * the other way round, so a lane that springs a long way out sags a little less
 * on the way and no two cuts have the same silhouette. Both ends of the range
 * are above zero: a cord that went slack by nothing would not have gone slack,
 * and `geometry.test.ts` measures that the loosening is a root-end fact.
 */
const SLACK_HABIT = { min: 0.7, max: 1.5 } as const

/** How far the released taper relaxes from root width toward tip width. */
const TAPER_RELAX = 0.5

/** Neighbours leave the mass together and fan apart, the way hyphae do. */
const BUNDLE_SIZE = 4

const THREAD_SAMPLES = 44

/**
 * How many data waypoints a thread's spine is built from before centripetal
 * Catmull-Rom smooths it (prd7 ruling 3). Sparse on purpose: the waypoints are
 * where the *encoding* lives (exit from the mass, lean into the bundle, node
 * at its lifecycle radius), and Catmull-Rom interpolates each exactly — dense
 * sampling would be the same picture at higher cost with nothing left to
 * interpolate.
 */
const SPINE_SEGMENTS = 8

/** Worst first: when a lane carries two faults, this one owns its node. */
const PATHOLOGY_PRIORITY: readonly PathologyKind[] = [
  'frozen',
  'looping',
  'waiting',
  'off-fence',
  'expensive',
]

export interface LayoutOptions {
  width: number
  height: number
  /**
   * The frame's **state** clock — `SceneFrame.asOf`, never `SceneFrame.now`
   * (#157's clock audit). Every use of it here judges a state by its age
   * (the lifecycle term, `ageFrac`, a bud's staleness) — never an animation;
   * `growth` and `retire` below carry their own already-integrated progress
   * on the real-time clock instead, which is the seam that lets this one
   * follow a scrub.
   *
   * Carried forward from the fleet snapshot rather than read live, so every
   * lane doesn't step forward together once a second as the model rebuilds
   * (ruling 32). Recency is measured against the snapshot rather than an
   * absolute instant, so a pinned fleet renders as a reproducible still image.
   */
  now: number
  /** laneId → grow-in progress 0–1. Absent means "already grown" (graft g3). */
  growth?: ReadonlyMap<string, number>
  /**
   * laneId → where its cord-cut has got to (prd5 ruling 3). Absent means the
   * lane is still in the living network — including a lane that has landed but
   * whose cut is still queued behind the structural cap, which is why this is a
   * map from `RetireRegistry` rather than something re-derived from `lane.activity`
   * here. The layout draws what the registry says is happening, and the registry
   * is the only thing that knows whether it *saw* it happen.
   */
  retire?: ReadonlyMap<string, RetireState>
  /**
   * The operator's hide-finished preference. Settled scars draw nothing while it
   * is on; cuts in progress are unaffected, and the lanes stay in the ring either
   * way so that toggling it never re-spaces the fleet (graft g7).
   */
  hideFinished?: boolean
}

/**
 * A THREAD'S SPINE, EXACTLY ONCE for a settled retired lane (#178). Still is
 * load-bearing (prd10 ruling 14) — nothing here may animate a settled cut, so
 * once the caller decides a lane's return is over, calling this again can
 * only reproduce the same points. See docs/decisions/geometry-cache-audit-178.md.
 */
interface ThreadSpine {
  path: Point[]
  filaments: FilamentGeometry[]
  bud: BudGeometry | null
}

function layoutSpine(
  lane: Lane,
  outward: Point,
  root: Point,
  bundle: Point,
  rim: Point,
  rx: number,
  ry: number,
  sizeFrac: number,
  widthTip: number,
  spacing: number,
  growth: number,
  cut: RetireState | null,
  now: number,
): ThreadSpine {
  // Deterministic sideways lean, keyed on the lane id (same wander every frame
  // and session). Every thread gets a *minimum* bow — sign from the hash,
  // magnitude floored — so a lane whose hash lands near the middle doesn't run
  // dead straight and read as a beam among curves.
  const perp: Point = { x: -outward.y, y: outward.x }
  const lean = hash(lane.id) - 0.5
  const wander = Math.sign(lean || 1) * (0.3 + Math.abs(lean) * 1.4) * Math.min(rx, ry) * 0.45
  const control: Point = {
    x: bundle.x + (rim.x - bundle.x) * 0.6 + perp.x * wander,
    y: bundle.y + (rim.y - bundle.y) * 0.6 + perp.y * wander,
  }

  // THE SPINE (prd7 rulings 3–4) — see the file header for the wander bound
  // this nudge respects.
  const sway = WANDER_MAX_SPACING * spacing
  const variation = variationFor(variationSeed(lane))
  const waypoints: Point[] = []
  for (let i = 0; i <= SPINE_SEGMENTS; i += 1) {
    const t = i / SPINE_SEGMENTS
    const on = cubicPoint(root, bundle, control, rim, t)
    const off = sway * variation.wander(t)
    waypoints.push({ x: on.x + perp.x * off, y: on.y + perp.y * off })
  }

  const full = smoothSpine(waypoints, THREAD_SAMPLES)
  const grown = growth >= 1 ? full : truncate(full, easeOut(growth))

  // The lane's own free phase (`variation.ts`'s `curl`), spent on the two
  // things about a return that carry nothing: how far its tip relaxes past the
  // rim, and how deeply the released strand sags. Two lanes that finished the
  // same work still let go differently — see docs/decisions/geometry-relax-reach.md
  // (#117) for why a rim where they did not is a problem.
  const habit = variation.curl
  const relax = RETIRE_RELAX_PX.min + (RETIRE_RELAX_PX.max - RETIRE_RELAX_PX.min) * habit
  const slack =
    Math.min(SLACK_MAX_PX, Math.max(SLACK_MIN_PX, Math.min(rx, ry) * SLACK_FRACTION)) *
    (SLACK_HABIT.min + (SLACK_HABIT.max - SLACK_HABIT.min) * (1 - habit))
  // How much of the strand the outward relax is allowed to bend, measured in px
  // of arc off the lane's own work-size. Measured on the thread as it *was*,
  // because this is the number the deformation is computed from and the stretch
  // it bends cannot shift under the bending.
  const rest = cut === null ? 1 : relaxRest(grown, relaxReachPx(sizeFrac))
  const path =
    cut === null
      ? grown
      : released(grown, {
          along: perp,
          side: Math.sign(lean || 1),
          slack: slack * cut.tension,
          outward,
          drift: relax * cut.drift,
          from: rest,
        })

  return {
    path,
    filaments: layoutFilaments(lane, path, widthTip, perp),
    // A retiring lane grows no bud: whatever it had handed out, it has finished.
    bud: cut === null ? layoutBud(lane, path, perp, now, variation.phase) : null,
  }
}

/** A hideable lane's spine is `[]`, never built. See docs/decisions/geometry-cache-audit-178.md. */
const EMPTY_PATH: readonly Point[] = []
const EMPTY_FILAMENTS: readonly FilamentGeometry[] = []

/**
 * One generation of settled spines, dropped whole (not pruned) whenever the
 * `world` they were built in moves — every entry was keyed to a world that no
 * longer exists. See {@link layoutScene}'s own `world` and
 * docs/decisions/geometry-cache-audit-178.md.
 */
let retiredSpineCache: { world: string; entries: Map<string, ThreadSpine> } | null = null

function retiredSpineCacheFor(world: string): Map<string, ThreadSpine> {
  if (retiredSpineCache === null || retiredSpineCache.world !== world) {
    retiredSpineCache = { world, entries: new Map() }
  }
  return retiredSpineCache.entries
}

export function layoutScene(fleet: Fleet, options: LayoutOptions): SceneGeometry {
  const { width, height, now } = options
  const centre: Point = { x: width / 2, y: height / 2 }
  // Big enough to read as the *mass* the threads are threaded into, rather than
  // as one more node that happens to sit in the middle. This is the mass at rest,
  // before anything has landed on it — a quiet session's centre, and the floor
  // the un-instrumented case sits at.
  const resting = Math.max(26, Math.min(width, height) * 0.11)

  // Labels live outside the nodes, so the rim has to leave them room — two lines
  // of 10px type radially outward, plus the widest lane name we might draw.
  const rx = Math.max(70, width / 2 - 116)
  const ry = Math.max(46, height / 2 - 32)

  // Slot order, not attention order: this is the whole of graft g7.
  const lanes = [...fleet.lanes].sort((a, b) => a.slot - b.slot)
  const byId = new Map(lanes.map((lane) => [lane.id, lane]))

  // Seats, not lanes: a re-dispatched handle shares the seat of the seed it grew
  // out of, so a returning lane never re-spaces the ring (prd6 ruling 3).
  const seedOf = germination(lanes, options.retire)
  const seatKey = (lane: Lane): number => {
    const seed = seedOf.get(lane.id)
    return seed === undefined ? lane.slot : (byId.get(seed)?.slot ?? lane.slot)
  }
  const seatKeys = [...new Set(lanes.map(seatKey))].sort((a, b) => a - b)
  const seatOf = new Map(seatKeys.map((key, i) => [key, i]))
  const angles = ringAngles(seatKeys.length, rx, ry)
  const spacing = rimSpacing(rx, ry, seatKeys.length)

  // THE MASS, AS THIS FRAME DRAWS IT (prd6 ruling 2, #118). Read off the
  // registry rather than off `isRetired`, so a landing still queued behind the
  // structural cap has not arrived here either. Hiding finished lanes must not
  // affect this sum: it's a request about clutter, not a claim work was undone.
  //
  // `clamp01(cut.withdraw)` deliberately duplicates `retire.ts`'s `homecoming`
  // rather than importing it: `motion.ts` imports this file and `retire.ts`
  // imports `motion.ts`, so importing from `retire.ts` here would close a
  // cycle. The dependency on `retire.ts` stays type-only; `geometry.test.ts`
  // pins the two readings equal so the copy cannot drift.
  let landedOutputTokens = 0
  for (const lane of lanes) {
    const cut = options.retire?.get(lane.id)
    if (cut === undefined) continue
    landedOutputTokens += lane.outputTokens * clamp01(cut.withdraw)
  }
  const fullness = rootFullness(landedOutputTokens)
  const rootRadius = rootRadiusFor(resting, rx, ry, fullness)

  const born = bornRadial(rootRadius, rx, ry)
  const bundleAt = bundleRadial(rootRadius, rx, ry)

  const sinceSnapshot = Math.max(0, now - fleet.now)

  // ONE WORLD-FRAME SIGNATURE FOR THIS FRAME — everything outside a single
  // lane that its cached spine is a function of. See
  // docs/decisions/geometry-cache-audit-178.md for why each term is here and
  // what a lane's own per-lane cache key (below) carries instead.
  const world = `${width}x${height}|${rootRadius.toFixed(3)}|${spacing.toFixed(3)}`

  const threads: ThreadGeometry[] = []
  const byLane = new Map<string, ThreadGeometry>()

  lanes.forEach((lane) => {
    const seat = seatOf.get(seatKey(lane)) as number
    const angle = angles[seat] as number
    const outward = rimNormal(angle, rx, ry)

    // Absolute, and floored by whatever the seed this lane grew from had already
    // accomplished: a germinated lane does not start over from nothing, because
    // the handle that came back is the same worker returning to the same ground.
    const seed = seedOf.get(lane.id)
    const seedLane = seed === undefined ? undefined : byId.get(seed)
    const sizeFrac = Math.max(
      seedSize(lane.outputTokens),
      seedLane === undefined ? 0 : seedSize(seedLane.outputTokens),
    )
    const widthRoot = 1.2 + 5 * sizeFrac
    const widthTip = 0.4 + 1.3 * sizeFrac

    const ageFrac =
      lane.ageMs === null ? 0.98 : clamp01((lane.ageMs + sinceSnapshot) / RECENCY_SPAN_MS)

    // The cut's first two stages are deformations of the thread rather than
    // separate marks: the slack bows the root end out, and the drift carries the
    // last stretch — the part that becomes the scar — outward. Its withdraw is also
    // what carries the lane the last of the way to the rim.
    const cut = options.retire?.get(lane.id) ?? null

    // Distance is the lifecycle, not recency (prd6 ruling 4).
    const lifeFrac = lifecycleFrac(sizeFrac, now - lane.firstSeenAt, cut?.drift ?? 0)
    const radial = born + (RADIAL_RIM - born) * lifeFrac
    const rim: Point = {
      x: centre.x + rx * radial * Math.cos(angle),
      y: centre.y + ry * radial * Math.sin(angle),
    }

    // The bundle: a shared trunk the group leaves the mass through. Without it
    // twenty threads read as a starburst rather than as a network.
    const bundleAngle = angles[bundleLeader(seat, seatKeys.length)] as number
    const bundle: Point = {
      x: centre.x + rx * bundleAt * Math.cos(bundleAngle),
      y: centre.y + ry * bundleAt * Math.sin(bundleAngle),
    }

    // It leaves the mass already leaning toward its bundle.
    const exitAngle = angle + angleDelta(angle, bundleAngle) * 0.6
    const root: Point = {
      x: centre.x + rootRadius * 0.94 * Math.cos(exitAngle),
      y: centre.y + rootRadius * 0.94 * Math.sin(exitAngle),
    }

    const growth = clamp01(options.growth?.get(lane.id) ?? 1)

    // HIDE FINISHED SKIPS LAYOUT TOO (prd10 ruling 16) — every mark builder
    // that touches a retired thread must check `cut.hidden` before touching
    // `path`/`node` (`marks/thread.ts`, `marks/node.ts`, `marks/dissolve.ts`).
    // See docs/decisions/geometry-cache-audit-178.md.
    const hideable = cut !== null && cut.stage === 'persistent' && options.hideFinished === true

    // SETTLED, AND CACHEABLE: gated on `cut.dissolve >= 1`, not
    // `cut.stage === 'persistent'` alone — see the decision doc above.
    const settled = cut !== null && cut.dissolve >= 1

    let path: readonly Point[]
    let filaments: readonly FilamentGeometry[]
    let bud: BudGeometry | null = null

    if (hideable) {
      path = EMPTY_PATH
      filaments = EMPTY_FILAMENTS
    } else if (settled) {
      const key = `${lane.id}|${angle.toFixed(6)}|${bundleAngle.toFixed(6)}|${cut.drift}`
      const cache = retiredSpineCacheFor(world)
      const known = cache.get(key)
      if (known === undefined) {
        const built = layoutSpine(
          lane,
          outward,
          root,
          bundle,
          rim,
          rx,
          ry,
          sizeFrac,
          widthTip,
          spacing,
          growth,
          cut,
          now,
        )
        cache.set(key, built)
        path = built.path
        filaments = built.filaments
      } else {
        path = known.path
        filaments = known.filaments
      }
    } else {
      const built = layoutSpine(
        lane,
        outward,
        root,
        bundle,
        rim,
        rx,
        ry,
        sizeFrac,
        widthTip,
        spacing,
        growth,
        cut,
        now,
      )
      path = built.path
      filaments = built.filaments
      bud = built.bud
    }

    // No re-measurement of the drawn arc after release: work-size is the
    // strand's own width, unbroken from mass to node, not the arc length of a
    // stub (ruling 13). See docs/decisions/geometry-return-as-shape.md.
    const node = path.length > 0 ? (path[path.length - 1] as Point) : rim

    const pathology =
      PATHOLOGY_PRIORITY.find((kind) => lane.pathologies.some((p) => p.kind === kind)) ?? null

    // Labels are pushed off the *rim*, not away from the centre: on the wide flat
    // ellipse a landscape panel produces, the two differ by 90° along the top and
    // bottom runs, and only the normal keeps a name clear of its neighbours.
    const reach = 12 + 6 * sizeFrac

    threads.push({
      laneId: lane.id,
      lane,
      angle,
      path: path as Point[],
      node,
      outward,
      widthRoot,
      widthTip,
      sizeFrac,
      ageFrac,
      lifeFrac,
      germinatedFrom: seed ?? null,
      growth,
      filaments: filaments as FilamentGeometry[],
      bud,
      knot: pathology === 'looping' ? knotAt(path, 0.78, 8 + 5 * sizeFrac) : null,
      rogue: null, // needs every node placed first; filled in below
      label: {
        anchor: { x: node.x + outward.x * reach, y: node.y + outward.y * reach },
        align: Math.abs(outward.x) < 0.5 ? 'centre' : outward.x > 0 ? 'left' : 'right',
      },
      pathology,
      alarm: isAlarmRank(lane.rank),
      retire:
        cut === null
          ? null
          : persistence(cut, path, widthRoot, widthTip, options.hideFinished === true),
    })
  })

  for (const thread of threads) byLane.set(thread.laneId, thread)

  // A trespass reaches for the lane it trespassed against, so every node has to
  // exist before any rogue filament can be aimed. `lane.trespasses` is empty
  // whenever there was no manifest to judge against (ruling 19), which is what
  // makes OFF-FENCE structurally unable to appear on a guess.
  for (const thread of threads) {
    if (thread.lane.trespasses.length === 0) continue
    const victimId = victimLaneId(thread.lane, threads)
    const target = victimId === null ? outwardReach(thread, rx, ry) : byLane.get(victimId)?.node
    if (target === undefined || target === null) continue
    thread.rogue = { path: rogueFilament(thread.node, target), victimId }
  }

  return {
    width,
    height,
    centre,
    rootRadius,
    rootFullness: fullness,
    rx,
    ry,
    threads,
    byLane,
    labelPolicy: threads.length > LABELS_ALL_MAX ? 'hover' : 'all',
  }
}

// ── seeds that germinate ────────────────────────────────────────────────────

/**
 * Living lane id → the retired lane whose seat and size it inherits
 * (prd6 ruling 3). A retired lane keeps its slot, so a returning handle grows
 * out of the seed already sitting at that angle instead of re-spacing the ring.
 *
 * **Handles, not ids**: a re-dispatch that reuses the branch is already the
 * same lane to `buildFleet`; this function exists for the case where the
 * identity moved (new worktree, new branch) and the handle workmux launched it
 * under is the only thread of continuity left.
 *
 * "Retired" means the registry's map, not `isRetired`: a lane whose cut is
 * still queued behind the structural cap is visibly living and not yet a seed
 * to grow from. At most one sprout per seed, earliest slot first, so two
 * returning lanes cannot claim the same ground.
 */
function germination(
  lanes: readonly Lane[],
  retire: ReadonlyMap<string, RetireState> | undefined,
): Map<string, string> {
  const grown = new Map<string, string>()
  if (retire === undefined || retire.size === 0) return grown

  const seeds = lanes.filter((lane) => retire.has(lane.id))
  if (seeds.length === 0) return grown

  const taken = new Set<string>()
  for (const lane of lanes) {
    if (retire.has(lane.id)) continue
    const seed = seeds.find(
      (candidate) =>
        candidate.id !== lane.id &&
        !taken.has(candidate.id) &&
        candidate.handles.some((handle) => lane.handles.includes(handle)),
    )
    if (seed === undefined) continue
    taken.add(seed.id)
    grown.set(lane.id, seed.id)
  }
  return grown
}

// ── the ring ────────────────────────────────────────────────────────────────

/**
 * `count` angles spaced by equal **arc length** around the rim (not equal
 * angle — on a wide short panel that piles lanes into the two ends where
 * there's no room for a label), starting at the top and running clockwise.
 * Deterministic in `(count, rx, ry)`, so a lane's angle stays a pure function
 * of its slot.
 */
export function ringAngles(count: number, rx: number, ry: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [-Math.PI / 2]

  const steps = 720
  const cumulative: number[] = [0]
  let previous = polar(rx, ry, 0)
  for (let i = 1; i <= steps; i += 1) {
    const at = polar(rx, ry, (i / steps) * Math.PI * 2)
    cumulative.push((cumulative[i - 1] as number) + Math.hypot(at.x - previous.x, at.y - previous.y))
    previous = at
  }
  const total = cumulative[steps] as number

  const angles: number[] = []
  for (let n = 0; n < count; n += 1) {
    const wanted = (total * n) / count
    // The table is monotonic, so a linear walk is exact and needs no search.
    let i = 1
    while (i < steps && (cumulative[i] as number) < wanted) i += 1
    const before = cumulative[i - 1] as number
    const span = (cumulative[i] as number) - before
    const within = span === 0 ? 0 : (wanted - before) / span
    angles.push(-Math.PI / 2 + ((i - 1 + within) / steps) * Math.PI * 2)
  }
  return angles
}

/**
 * How much rim there is per lane, in px — the unit prd7 ruling 4's wander cap
 * is expressed in, as a *fraction of the spacing* rather than a pixel amount,
 * so the bound stays true at every fleet size and zoom (a fixed px wander
 * would be gentle on four lanes and cross a neighbour's line on thirty).
 * Ramanujan's ellipse perimeter, exact to a part in 10⁵ at any aspect ratio.
 */
export function rimSpacing(rx: number, ry: number, count: number): number {
  const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)))
  return perimeter / Math.max(1, count)
}

/** Outward unit normal of the ellipse at parametric `angle`. */
function rimNormal(angle: number, rx: number, ry: number): Point {
  const nx = Math.cos(angle) / rx
  const ny = Math.sin(angle) / ry
  const length = Math.hypot(nx, ny) || 1
  return { x: nx / length, y: ny / length }
}

function polar(rx: number, ry: number, angle: number): Point {
  return { x: rx * Math.cos(angle), y: ry * Math.sin(angle) }
}

/** The middle of this lane's bundle: whose angle the shared trunk leaves on. */
function bundleLeader(index: number, count: number): number {
  const first = Math.floor(index / BUNDLE_SIZE) * BUNDLE_SIZE
  const members = Math.min(BUNDLE_SIZE, count - first)
  return first + Math.floor((members - 1) / 2)
}

// ── second growth ───────────────────────────────────────────────────────────

function layoutFilaments(
  lane: Lane,
  path: readonly Point[],
  widthTip: number,
  perp: Point,
): FilamentGeometry[] {
  // The trunk *is* the main thread; only the other threads sprout filaments.
  const branching = lane.filaments.filter((f) => f.thread !== 'main')
  if (branching.length === 0) return []

  const busiest = Math.max(1, ...lane.filaments.map((f) => f.outputTokens))

  return branching.map((filament, i) => {
    const at = 0.58 + i * 0.14
    const origin = pointAt(path, at)
    const along = tangentAt(path, at)
    const side = i % 2 === 0 ? 1 : -1
    const share = clamp01(filament.outputTokens / busiest)
    const length = 24 + 32 * share

    const tip: Point = {
      x: origin.x + along.x * length * 0.55 + perp.x * side * length * 0.78,
      y: origin.y + along.y * length * 0.55 + perp.y * side * length * 0.78,
    }
    const control: Point = {
      x: origin.x + along.x * length * 0.62 + perp.x * side * length * 0.2,
      y: origin.y + along.y * length * 0.62 + perp.y * side * length * 0.2,
    }

    const count = 1 + Math.min(4, Math.floor(Math.log2(1 + filament.requestCount)))
    const strands: Point[][] = []
    for (let s = 0; s < count; s += 1) {
      const spread = (s - (count - 1) / 2) * 0.32
      strands.push(
        sampleQuad(
          origin,
          control,
          {
            x: tip.x + perp.x * side * spread * length * 0.5 + along.x * spread * length * 0.36,
            y: tip.y + perp.y * side * spread * length * 0.5 + along.y * spread * length * 0.36,
          },
          12,
        ),
      )
    }

    return {
      at,
      path: sampleQuad(origin, control, tip, 14),
      width: Math.max(0.35, widthTip * (0.55 + 0.5 * share)),
      strands,
      thread: filament.thread ?? 'unknown',
    }
  })
}

// ── subagent buds ───────────────────────────────────────────────────────────

/**
 * THIS LANE'S BUD, or null (prd10 ruling 9, see {@link BudGeometry}).
 *
 * Liveness is **read**, never re-derived: `lane.subagents` is
 * `selectSubagentActivity`'s vital, and a trace span may only *enrich* it,
 * never decide it. This file adds only staleness (by the frame's clock),
 * turned into a length.
 *
 * The branchlet leaves the parent at {@link BUD_AT}, inside the filaments'
 * band (0.58 and out) so the two never overlap.
 */
function layoutBud(
  lane: Lane,
  path: readonly Point[],
  perp: Point,
  now: number,
  phase: number,
): BudGeometry | null {
  const vital = lane.subagents
  if (vital === null) return null

  const sinceMs = Math.max(0, now - vital.lastActivityTs)
  // The window is core's, not ours (`DEFAULT_SUBAGENT_RECENCY_MS`): the vital and
  // the picture have to agree about what "live" means, and one of them owns it.
  const { vitality, absorb } = budLife(sinceMs)
  // Absorbed and gone. The vital will drop to null on the next fleet rebuild; the
  // picture does not wait for it, because it can already see the reading expire.
  if (vitality <= 0) return null

  const origin = pointAt(path, BUD_AT)
  const along = tangentAt(path, BUD_AT)
  const side = phase < 0.5 ? -1 : 1
  const reach = (BUD_LENGTH_PX.min + BUD_LENGTH_PX.span * phase) * vitality

  const tip: Point = {
    x: origin.x + along.x * reach * 0.42 + perp.x * side * reach * 0.86,
    y: origin.y + along.y * reach * 0.42 + perp.y * side * reach * 0.86,
  }
  const control: Point = {
    x: origin.x + along.x * reach * 0.58 + perp.x * side * reach * 0.24,
    y: origin.y + along.y * reach * 0.58 + perp.y * side * reach * 0.24,
  }

  return {
    at: BUD_AT,
    path: sampleQuad(origin, control, tip, 10),
    // Finer than the parent's tip: a bud is anatomy of its thread, not a thread.
    width: 0.8,
    tip,
    vitality,
    absorb,
    sinceMs,
    kind: vital.subagentType,
  }
}

// ── the return, as shape ────────────────────────────────────────────────────

interface Release {
  /** The thread's own sideways direction — the axis its bow already runs on. */
  along: Point
  /** Which way that bow leans, so the slack loosens the curve rather than fighting it. */
  side: number
  /** Peak sideways sag, in px. */
  slack: number
  /** The rim's outward normal at this lane's angle. */
  outward: Point
  /** How far the node end is carried toward the rim, in px. */
  drift: number
  /** Where the outward relax begins — the stretch of strand the drift bends. */
  from: number
}

/**
 * The thread with the tension let out of it and its tip drifted. Two
 * displacements, each a different stage's whole contribution:
 *
 * - **slack**, along the thread's *own* lean, peaking about a third of the way
 *   out — sagging the *other* way would read as something pulling on it, not
 *   as the thread going loose.
 * - **drift**, along the rim normal, zero where the relax reach begins and
 *   full at the node — rigid drift would fight the slack instead of easing
 *   past it.
 */
function released(path: readonly Point[], release: Release): Point[] {
  const last = path.length - 1
  return path.map((point, i) => {
    const t = last <= 0 ? 1 : i / last
    const sag = release.slack * slackHump(t)
    const out = release.drift * driftWeight(t, release.from)
    return {
      x: point.x + release.along.x * release.side * sag + release.outward.x * out,
      y: point.y + release.along.y * release.side * sag + release.outward.y * out,
    }
  })
}

/** Zero at both ends, peak 1 at t ≈ 0.32 — the slack is a root-end fact. */
function slackHump(t: number): number {
  return Math.sin(Math.PI * Math.pow(clamp01(t), 0.6))
}

/** Zero everywhere but the stretch the relax reaches, easing in and out. */
function driftWeight(t: number, from: number): number {
  const span = 1 - from
  if (span <= 0) return clamp01(t) >= 1 ? 1 : 0
  const into = (clamp01(t) - from) / span
  return into <= 0 ? 0 : smooth(into)
}

/**
 * The path parameter `lengthPx` of arc length back from the node — where the
 * outward relax begins. Walked from the tip backwards over the sampled
 * polyline; exact enough since the ribbon is drawn with the same
 * segment-linear approximation anyway.
 */
function relaxRest(path: readonly Point[], lengthPx: number): number {
  const last = path.length - 1
  if (last < 1) return 0

  let total = 0
  for (let i = last; i > 0; i -= 1) {
    const a = path[i] as Point
    const b = path[i - 1] as Point
    const step = Math.hypot(a.x - b.x, a.y - b.y)
    if (total + step >= lengthPx) {
      const within = step === 0 ? 0 : (lengthPx - total) / step
      return Math.max(1 - RELAX_MAX_FRACTION, (i - within) / last)
    }
    total += step
  }
  // The whole thread is shorter than the mark: keep the tail fraction instead.
  return 1 - RELAX_MAX_FRACTION
}

/**
 * THE WAY HOME (prd6 ruling 2) — where the lane's substance has got to: a
 * stretch of the thread's own centreline, leaving the node when the withdraw
 * begins and gone into the mass when it ends. Not a pulse (light is what a
 * *working* lane spends) — this is matter, which is why the mass is thicker
 * afterwards (`marks/root.ts`).
 *
 * Travels on the withdraw's own clock rather than a new animation budget, so
 * it is null at both ends of that stage: it grows out of the node rather than
 * popping into existence, and is absorbed rather than blinking out.
 */
function homewardFlow(path: readonly Point[], withdraw: number): Point[] | null {
  if (withdraw <= 0 || withdraw >= 1) return null

  // Measured in arc length rather than in path parameter: the samples of a cubic
  // are not evenly spaced along it, so a fixed *parameter* span would send three
  // times as much substance home from one end of the ellipse as from the other.
  const cumulative = arcTable(path)
  const total = cumulative[cumulative.length - 1] ?? 0
  if (total <= 0) return null

  const parcel = Math.min(HOMEWARD_LENGTH_PX, total * 0.5)
  // The leading (rootward) edge, from the node at `total` to one parcel-length
  // past the mass — which is where the last of it disappears under the mass.
  const lead = total - (total + parcel) * withdraw
  const from = Math.max(0, lead)
  const to = Math.min(total, lead + parcel)
  if (to - from < 0.5) return null

  return between(path, paramAtArc(cumulative, from), paramAtArc(cumulative, to), 12)
}

/**
 * THE STRAND A FINISHED LANE KEEPS (prd10 rulings 13–15) — the whole of it,
 * root-mass rim to node, threaded in at both ends; no code path here can
 * shorten or empty it. See docs/decisions/geometry-return-as-shape.md.
 *
 * Keeps the whole thread's taper, so `thread width = work size` survives
 * intact: the *encoding* lives here, the *hierarchy* (how much thinner,
 * `retire.ts`'s {@link PERSIST_WIDTH_SCALE}) lives where the ribbon is built
 * (`marks/thread.ts`) — which keeps a retune of one from silently changing
 * the other. The release changes only the taper's *steepness*, relaxing
 * {@link TAPER_RELAX} of the way toward the tip's width.
 */
function persistence(
  cut: RetireState,
  path: readonly Point[],
  widthRoot: number,
  widthTip: number,
  hideFinished: boolean,
): RetireGeometry {
  const relaxed = widthRoot + (widthTip - widthRoot) * TAPER_RELAX * cut.tension

  return {
    ...cut,
    // The strand as drawn, at full resolution — the same array the living thread
    // carries, which is what makes "no geometry is ever deleted" a thing a test
    // can assert by comparing two paths rather than by counting marks.
    path: [...path],
    widthRoot: relaxed,
    widthTip,
    homeward: homewardFlow(path, cut.withdraw),
    // Only a lane that has reached `persistent` is hideable. A return in progress
    // is news, and the one thing worse than a finished lane the operator asked not
    // to see is a completion they never saw at all.
    hidden: hideFinished && cut.stage === 'persistent',
  }
}

/** The stretch of a path between two parameters, resampled to `steps` segments. */
function between(path: readonly Point[], from: number, to: number, steps: number): Point[] {
  const start = clamp01(from)
  const end = clamp01(to)
  const out: Point[] = []
  for (let i = 0; i <= steps; i += 1) out.push(pointAt(path, start + (end - start) * (i / steps)))
  return out
}

/** Cumulative arc length at each sample of a path — `[0, …, total]`. */
function arcTable(path: readonly Point[]): number[] {
  const out = [0]
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    out.push((out[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y))
  }
  return out
}

/** The path parameter `s` px along a path, off its own cumulative table. */
function paramAtArc(cumulative: readonly number[], s: number): number {
  const last = cumulative.length - 1
  if (last < 1) return 0
  let i = 1
  while (i < last && (cumulative[i] as number) < s) i += 1
  const before = cumulative[i - 1] as number
  const step = (cumulative[i] as number) - before
  const within = step === 0 ? 0 : (s - before) / step
  return clamp01((i - 1 + within) / last)
}

// ── faults with a shape ─────────────────────────────────────────────────────

/** A closed loop tied into the thread. A pulse going round it is going nowhere. */
function knotAt(path: readonly Point[], at: number, radius: number): Knot {
  const on = pointAt(path, at)
  const along = tangentAt(path, at)
  return {
    centre: { x: on.x + along.x * radius * 0.2, y: on.y + along.y * radius * 0.2 },
    radius,
    tangent: Math.atan2(along.y, along.x),
  }
}

/** A bowed reach from the offender's node into the ground it is touching. */
function rogueFilament(from: Point, target: Point): Point[] {
  const dx = target.x - from.x
  const dy = target.y - from.y
  const control: Point = {
    x: from.x + dx * 0.5 - dy * 0.16,
    y: from.y + dy * 0.5 + dx * 0.16,
  }
  // Stops short of the victim's node: it reached in, it did not arrive.
  return sampleQuad(from, control, { x: from.x + dx * 0.9, y: from.y + dy * 0.9 }, 22)
}

/** The manifest named a fence-owner; find the lane wearing that handle. */
function victimLaneId(lane: Lane, threads: readonly ThreadGeometry[]): string | null {
  for (const trespass of lane.trespasses) {
    if (trespass.victim === null) continue
    for (const thread of threads) {
      const other = thread.lane
      if (
        other.id === trespass.victim ||
        other.branch === trespass.victim ||
        other.handles.includes(trespass.victim)
      ) {
        return other.id
      }
    }
  }
  return null
}

/**
 * A trespass on nobody's fence still left the lane's own ground, so the filament
 * still crosses out — just past the rim rather than at another lane.
 */
function outwardReach(thread: ThreadGeometry, rx: number, ry: number): Point {
  const reach = Math.min(rx, ry) * 0.34
  return {
    x: thread.node.x + thread.outward.x * reach,
    y: thread.node.y + thread.outward.y * reach,
  }
}

// ── curves ──────────────────────────────────────────────────────────────────

function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

function sampleQuad(p0: Point, p1: Point, p2: Point, steps: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const u = 1 - t
    out.push({
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    })
  }
  return out
}

/** The first `fraction` of a path, resampled to the same point count. */
function truncate(path: readonly Point[], fraction: number): Point[] {
  const steps = path.length - 1
  const out: Point[] = []
  for (let i = 0; i <= steps; i += 1) out.push(pointAt(path, (i / steps) * clamp01(fraction)))
  return out
}

/** Point at `t` along a sampled path: 0 = root-mass, 1 = node. */
export function pointAt(path: readonly Point[], t: number): Point {
  if (path.length === 0) return { x: 0, y: 0 }
  const at = clamp01(t) * (path.length - 1)
  const i = Math.floor(at)
  const j = Math.min(path.length - 1, i + 1)
  const f = at - i
  const a = path[i] as Point
  const b = path[j] as Point
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

export function tangentAt(path: readonly Point[], t: number): Point {
  const a = pointAt(path, Math.max(0, t - 0.02))
  const b = pointAt(path, Math.min(1, t + 0.02))
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  return { x: dx / length, y: dy / length }
}

function angleDelta(from: number, to: number): number {
  let delta = to - from
  while (delta > Math.PI) delta -= 2 * Math.PI
  while (delta < -Math.PI) delta += 2 * Math.PI
  return delta
}

function easeOut(t: number): number {
  const k = clamp01(t)
  return 1 - (1 - k) * (1 - k)
}

/** Smoothstep: flat at both ends, so a weighted displacement blends in without a kink. */
function smooth(t: number): number {
  const k = clamp01(t)
  return k * k * (3 - 2 * k)
}

/** Stable 0–1 from a string, so the wander is the same every frame. */
function hash(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10_000) / 10_000
}
