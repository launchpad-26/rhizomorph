import { DEFAULT_SUBAGENT_RECENCY_MS } from '@rhizomorph/core'
import type { Fleet, Lane, PathologyKind } from '../fleet/index.js'
import { clamp01 } from './palette.js'
import type { RetireState } from './retire.js'
import { smoothSpine } from './ribbon.js'
import { isAlarmRank } from './salience.js'
import { WANDER_MAX_SPACING, variationFor, variationSeed } from './variation.js'

/**
 * WHERE THE MYCELIUM GROWS.
 *
 * Four facts carry meaning in the layout, and each one is a recorded fact rather
 * than a decoration:
 *
 * - **distance from the root-mass = how far through its life the lane is**
 *   (prd6 ruling 4). Born against the mass, travelling outward as it works,
 *   retiring at the rim — where the cord-cut already happens, so the two now
 *   tell one story. See {@link lifecycleFrac}. This REPLACES prd3 graft g6's
 *   distance-as-recency, which needed explaining and therefore failed the layman
 *   bar; recency keeps the channel it already shared, **thread lightness**
 *   (`thread.ts`'s `freshness`, off {@link ThreadGeometry.ageFrac}), so no fact
 *   was dropped when the radius changed hands.
 * - **thread width = work size, on an absolute scale** (prd6 ruling 1). Output
 *   tokens log-scaled against a *fixed* reference — never against the fleet's own
 *   busiest lane — so a lane's size is a fact about the lane. See
 *   {@link seedSize}. Tapering root→tip like a real hypha.
 * - **angular position = identity, and it is stable for the session** (graft
 *   g7). The angle comes from {@link Lane.slot} — assigned by first sighting in
 *   the derived model and never reshuffled by rank — so "72 lives at four
 *   o'clock" stays true while the attention ordering churns above it. Nothing
 *   here reads a pathology, a rank or a token count to decide where a lane sits.
 * - **length of the drawn thread = how grown-in it is** (graft g3). A lane
 *   discovered while we are watching grows out of the mass over
 *   {@link SETTLE_MS} rather than appearing at full length.
 *
 * The one honest caveat: the ring is subdivided by how many *seats* there are, so
 * a new dispatch re-spaces everyone. That is a different fact from the one g7
 * protects against — a lane must not move because its mood changed — and even
 * spacing is what keeps twenty labels legible (ruling 31's collision trigger).
 * `geometry.test.ts` pins both halves: same lanes → same angles in any event
 * order, and a lane's angle is untouched by its rank, age or size.
 *
 * A *returning* lane is the exception that proves it (prd6 ruling 3): a
 * re-dispatched handle grows out of the seed it left behind, sharing that seat
 * rather than claiming a new one — so the ring is not re-spaced at all, and the
 * scene remembers where a lane worked. See {@link germination}.
 *
 * **What prd7 added, and what it was not allowed to touch.** A thread's spine is
 * now sparse waypoints off that curve, nudged sideways by a noise field seeded
 * from the lane's own handle, and interpolated by centripetal Catmull-Rom
 * (`ribbon.ts`) — which is what stops twenty lanes reading as twenty drafted
 * arcs. The nudge is bounded twice: by {@link WANDER_MAX_SPACING} of the gap
 * between two lanes, and by an envelope that is exactly zero at both ends. So
 * every one of the four facts above survives it *bit for bit* — the node is
 * still at its lifecycle radius on its own angle, and `geometry.test.ts`
 * recomputes both from the fleet to prove it. Variation is spent only where
 * nothing is encoded; `variation.ts` is the table that says where that is.
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
 * Null for a lane with no live subagent reading, which is the *majority* case and
 * carries no apology: `lane.subagents` is `null` whenever no `thread: 'subagent'`
 * telemetry has reached that lane inside core's own recency window, and "no bud"
 * is then the honest picture rather than a gap the scene has to talk about (the
 * ruling's own words: a lane with no telemetry grows no buds and loses nothing
 * else).
 *
 * The one number worth reading twice is {@link vitality}. The vital the chips lane
 * landed reports the *newest* thread-marked reading, not a start and an end — so
 * "the bud is live" is a claim with an expiry rather than a state with an off
 * switch, and this file draws exactly that: the branchlet is full while the
 * evidence is fresh and **retracts into its parent over the last
 * {@link BUD_ABSORB_MS} of the window**, so it is gone at the instant the reading
 * would have expired. That is ruling 2's return grammar in miniature (ruling 9's
 * own instruction), and it is stateless — no registry, no remembered spawn, and
 * therefore identical in a live scene and in a replay.
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
 * How long the absorption takes, in ms — and it is deliberately the same span the
 * composting decay runs over (`DISSOLUTION.spanMs`), because it is the same act at
 * a smaller scale.
 *
 * Restated here rather than imported: `motion.ts` imports this file for
 * {@link RECENCY_SPAN_MS}, so reaching the other way would close a module cycle
 * and leave a `const` undefined at evaluation time — the same trap the landed-work
 * sum below already documents. `geometry.test.ts` pins the two numbers equal so
 * the copy cannot drift.
 */
export const BUD_ABSORB_MS = 2_400

/** How far along the parent a bud branches off, and how far it reaches. */
const BUD_AT = 0.46
const BUD_LENGTH_PX = { min: 13, span: 15 } as const

/**
 * HOW ALIVE A BUD IS, given how stale its newest reading has got (prd10 ruling 9).
 *
 * The one piece of arithmetic that turns core's *expiring claim* into the scene's
 * *retracting branchlet*, and it is exported because two things read it: a worker's
 * bud (below) and the conductor's, which grows off the mass rather than off a
 * thread and therefore cannot come through this file's per-lane layout at all
 * (`marks/root.ts`). One function, so the two can never disagree about when a
 * subagent has finished.
 */
export function budLife(sinceMs: number): { vitality: number; absorb: number } {
  const expiring = Math.max(0, DEFAULT_SUBAGENT_RECENCY_MS - BUD_ABSORB_MS)
  const absorb = clamp01((Math.max(0, sinceMs) - expiring) / BUD_ABSORB_MS)
  return { vitality: 1 - absorb, absorb }
}

/**
 * THE RETURN, as shape (prd10 rulings 13–15). Null for every lane still working.
 *
 * The retirement's *timing* is `retire.ts`'s; this is what those numbers do to
 * the picture. It used to describe a **remnant** — the stub left after a cord was
 * severed from the mass, shortening frame by frame until prd10 ruling 2 erased it
 * altogether. It describes a **strand** now: the same curve the lane always had,
 * root-mass rim to node, threaded into the mass for the rest of the session.
 * Nothing here shortens, nothing here can return an empty path, and there is no
 * severance parameter left to shorten it *from*.
 *
 * It is still carried beside the living geometry rather than replacing it, for the
 * reason it always was: {@link ThreadGeometry.path} is the undeformed spine, which
 * is what the light already in flight finishes its journey along (a landing packet
 * takes 2.8 s to reach the mass and the settle takes 1.4) and what the returning
 * motes ride. This is that spine with the release folded into it — the slack at
 * the root, the tip's own outward relax — which is what actually gets drawn.
 */
export interface RetireGeometry extends RetireState {
  /** The whole strand, root-mass rim → node, with the release folded into it. */
  path: Point[]
  /** The strand's widths, with the released taper already relaxed into them. */
  widthRoot: number
  widthTip: number
  /**
   * THE WAY HOME (prd6 ruling 2). The stretch of the lane's own thread that is
   * currently travelling down it into the root-mass — real mycelium reabsorbs a
   * spent hypha and translocates its substance back through the network, which is
   * what a merge is. Null whenever nothing is in transit: before the withdraw
   * begins, after it has arrived, and for every landing that was never watched
   * (history, replay, reduced motion) — a journey nobody saw start is a journey
   * that did not happen on this screen.
   *
   * It runs the strand's own curve, so the substance is visibly *inside* the
   * hypha rather than beside it — the honest reading of a translocation.
   */
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
 * ABSOLUTE SEED SIZE (prd6 ruling 1) — how much output reads as a full-grown seed.
 *
 * The scale is **fixed**, which is the whole ruling. The old reading divided by
 * the fleet's own busiest lane, so a 20K lane visibly *shrank* the moment a 500K
 * whale started working beside it, and growth — the one thing the operator asked
 * to be able to see — never read at all. Nothing in {@link seedSize} looks at
 * another lane, so a lane's size is a fact about that lane.
 *
 * Two references rather than one, because a bare `log1p(t) / log1p(FULL)` spends
 * most of its range below a thousand tokens, where no real lane ever sits: 9K and
 * 120K come out 0.79 and 1.00, which is the same "growth never reads" failure in a
 * different coordinate system. So the ruler runs between the two ends that exist
 * in practice — a lane that has only just started producing, and one that has done
 * a long day's work — and the log does its compressing in between.
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
 * THE MASS GROWS WITH THE WORK (prd6 ruling 2) — and it is a *geometry* fact.
 *
 * It used to be a multiplier `marks/root.ts` applied to a fixed radius, worth 30%
 * at the ceiling, and #118's finding against it was the picture: after thirty-eight
 * landings and 2.5M output tokens the scene read as a **wreath** — a ring of
 * retired lanes around a large empty middle with a small blob at the centre. The
 * encoding was already there and simply far too weak to see. Three things had to
 * change together, and this is where two of them live.
 *
 * **1. The ceiling is a fraction of the scene, not of the mass.** A cap of
 * "+30% of its own resting size" is a statement about the mass and says nothing
 * about the picture it sits in; the thing an operator can actually see is how much
 * of the *gap to the retirement band* the centre has taken. So the ceiling is
 * {@link ROOT_GROWTH.maxReach} of {@link Math.min}(`rx`, `ry`) — the direction the
 * rim runs closest, for the same reason {@link bornRadial} measures against it —
 * and the mass therefore cannot crowd the rim or the lane labels on a letterbox
 * panel, on a square one, or at any zoom, since the camera magnifies the ceiling
 * and the rim by the same factor.
 *
 * **2. Everything inside the rim has to make room.** A mass that grows into the
 * space where the bundle trunk and the newborn nodes already sit would swallow
 * them, so {@link bornRadial} and the bundle radius are measured off *this*
 * radius rather than off a resting one. That is why the growth is computed here
 * and not in the mark builder: by the time `root.ts` runs, every thread has
 * already been laid out against a radius that was wrong.
 *
 * The discipline is ruling 1's, unchanged and for the same reasons as
 * {@link seedSize}: a two-ended log so the range is spent where landings actually
 * sit, an **absolute** scale so a sibling landing cannot move it and the same
 * session always draws the same size, and a hard cap so nothing balloons.
 */
export const ROOT_GROWTH = {
  /** Landed output below which the mass is still its own resting size. */
  seedTokens: 10_000,
  /**
   * …and at which it has grown all the way. A long night: #118's own session had
   * landed 2.5M by the time the ruling was written, so the ruler has to run to
   * something of that order or every session past the first hour draws the same.
   */
  fullTokens: 2_000_000,
  /**
   * THE CAP, as a fraction of the distance from the centre to the nearest point
   * of the retirement band.
   *
   * Half. Found by looking at rendered frames at 2× rather than reasoned, and the
   * two failures either side of it are different: below about 0.42 the mass never
   * gets past where a newborn node already sits, so the empty annulus the ruling
   * is about survives and only the blob in it is slightly larger; past about 0.55
   * the lifecycle band — born to rim, the one channel prd6 ruling 4 put distance
   * on — is squeezed into the outer third of the picture and a lane's journey
   * stops being readable. At 0.5 the centre is unmistakably the biggest thing in
   * the frame and the living band still has half the radius to run in.
   */
  maxReach: 0.5,
} as const

/**
 * How full the mass is, 0–1 — the fraction of its growth it has taken home.
 *
 * Monotone, absolute and capped, exactly as {@link seedSize} is: ten times the
 * reference draws the same as the reference, and no other lane's work is in it.
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
 *
 * "How far through its life is this?" needs no legend, which is exactly what
 * distance-as-recency needed. Born against the mass, travelling outward as it
 * works, coming to rest at the rim.
 *
 * The signal is built from what the fleet object already records, and every term
 * in it had to be **monotone** — a radius that could go backwards would be a lane
 * un-living part of its life, which is not a thing that happens:
 *
 * - **work done** ({@link seedSize} of the lane's output, {@link WORK_SHARE} of
 *   the blend) — the dominant term, because a lane's life is measured in what it
 *   produced rather than in how long it sat there. It is the same measurement the
 *   seed's own size is drawn from, so the two channels cannot disagree.
 * - **age since first sighting** (`now - lane.firstSeenAt` over
 *   {@link LIFE_SPAN_MS}, the rest of the blend) — a lane that has been alive a
 *   long time is further through its life even if it has little to show, and this
 *   is the term that keeps the journey moving between snapshots.
 * - **activity**, through exactly one door: the terminal pin. `done` and `parked`
 *   are what `retire.ts` reads to cut a cord, so a lane comes to rest at the rim
 *   *as its cord parts* rather than jumping there — the pin rides the cut's own
 *   critically-damped spring, which is the structural class and the cap and the
 *   queue already paid for. The other activity states say what a lane is doing
 *   *now*, which is recency's fact and not a lifecycle fact; a lane can leave
 *   `waiting`, and a term it could leave would not be monotone.
 *
 * The pin reads {@link RetireState.drift} rather than the withdraw, which is the
 * one place the two differ: **drift is zero when the mode forbids travel**. So
 * reduced motion keeps its existing law — the cord is severed in place and nothing
 * crosses the picture — without this file having to know the preference exists.
 *
 * A lane whose cut is still queued behind the structural cap has no pin yet, and
 * that is correct: it is still drawn as the living thread it visibly is.
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
 * {@link RADIAL_BORN}, pushed out far enough that a newborn node clears the mass
 * on this panel. Measured against the *smaller* half-axis, because that is the
 * direction the rim runs closest to the mass in — a lane born at the top of a
 * letterbox ellipse must clear it as surely as one born at the side.
 *
 * `rootRadius` is the mass's radius **as this frame draws it** (#118), grown by
 * whatever has landed. It has to be: the whole point of growing the mass is that
 * it fills the empty middle, and the empty middle is where the newborn nodes are.
 * A born radius pinned to a resting size would have the mass swallow the youngest
 * lane in the fleet on any session that had landed a night's work.
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
 * THE RELAX REACH — how much of its own strand a finished lane bends outward,
 * **in px of arc length**.
 *
 * This used to be the length of the *remnant* a cut left at the rim, and ruling
 * 13 has taken the cut away. What the number does now is the half of it that was
 * always about the picture rather than about the severing: it is the stretch at
 * the far end that eases outward past the rim as the lane comes to rest
 * ({@link RETIRE_RELAX_PX} is how far, this is how much of the strand), so thirty
 * finished lanes end at thirty slightly different radii instead of on one perfect
 * ellipse.
 *
 * A length rather than a fraction, and that half of #102 stands: the rim is a wide
 * ellipse, so a lane at three o'clock has a thread three times as long as one at
 * noon, and a fixed *fraction* of it would make the bend a fact about the panel's
 * aspect ratio. Nothing means that.
 *
 * Sized by the lane's own work on the same absolute scale everything else is
 * ({@link seedSize}), for the reason prd6 ruling 1 gave when this was a mark: a
 * rim where a 216K lane and an empty one finish identically has thrown away the
 * only thing it had to say about them.
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
 * THE DRIFT BAND (#117) — how far a finished lane's *tip* relaxes outward,
 * on top of the journey to the rim the lifecycle pin is already carrying it on.
 *
 * A local bend, not a translation: it is what keeps the strand on its own line
 * for most of its length while its far end eases out. It was one number, nine
 * pixels for every lane, and that was half of why a rim of finished lanes read as
 * eyelashes on a clock face — thirty-seven ends all sitting on one perfect
 * ellipse.
 * It is now a **band**: each lane relaxes by its own amount between these two,
 * so the rim is ragged the way a rim of things that finished at different times
 * and at different sizes ought to be.
 *
 * **Seeded from the lane's identity, not from when it retired**, and that is a
 * deliberate refusal. "When" is recency, and prd6 ruling 4 took recency off the
 * radius on purpose — it needed explaining, so it failed the layman bar, and
 * giving it back to the radius for retired lanes only would be a second meaning
 * for the one channel whose meaning the ruling settled. What the picture needs
 * here is *scatter*, not a second encoding, and `variation.ts`'s permission
 * system already says exactly where scatter may come from: a channel that
 * carries nothing, seeded off the lane's handle. Among lanes that have all
 * finished, the radius carries nothing — they are all at `lifeFrac` 1 — so this
 * is the free channel it looks like.
 *
 * Outward only, which is what keeps the ruling's own reading intact: a retired
 * lane is at the rim or past it, a living one is inside it, and no amount of
 * scatter can make one look like the other.
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
 * Catmull-Rom smooths it (prd7 ruling 3).
 *
 * Sparse on purpose. The waypoints are where the *encoding* lives — the exit
 * from the mass, the lean into the bundle, the node at its lifecycle radius —
 * and Catmull-Rom interpolates every one of them, so the curve drawn passes
 * through each exactly. Sampling the underlying cubic densely and smoothing
 * *that* would be the same picture at three times the cost and with nothing left
 * to interpolate.
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
   * (#157's clock audit).
   *
   * Every use of it in this file judges a state by its age: the lifecycle's term
   * against `lane.firstSeenAt`, recency's `ageFrac` by `now - fleet.now`, and a
   * bud's staleness against its vital's last reading. Not one of them is an
   * animation — the two animations the layout takes part in (`growth` and
   * `retire`) arrive as their own already-integrated progress below, on the
   * real-time clock, which is the seam that lets this one follow a scrub.
   *
   * Both continuous facts are carried forward from the fleet snapshot with it
   * rather than read straight off it, because otherwise every lane in the picture
   * would step forward together once a second as the derived model is rebuilt.
   * Ruling 32 blesses the glide.
   *
   * Recency is measured *against the snapshot* rather than as an absolute
   * instant, so a pinned fleet rendered at its own `now` is exactly the still
   * image the snapshot describes. That is what makes a fixture screenshot
   * reproducible.
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
 * A THREAD'S SPINE, EXACTLY ONCE (#178 — the audit's P2 scene finding, measured
 * by #175's `perf.test.ts`). The waypoints, the centripetal Catmull-Rom fit, the
 * release deformation and the filaments grown off it: this is the whole
 * expensive half of laying out a lane, and for a settled retired one it never
 * has to run again after the return finishes.
 *
 * **The law it leans on** (prd10 ruling 14): "a completed strand stays visible
 * as a thin, still, luminous filament." Still is load-bearing — nothing here
 * animates a settled cut — so once `retiredSpineCacheFor`'s caller decides a
 * lane's return is over, calling this function again can only ever reproduce
 * the same points it already produced. `heart.ts` is the model for the same
 * argument at the mass's own scale.
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
  // A deterministic sideways lean, so no two threads are congruent and the
  // network looks grown rather than drafted. Keyed on the lane id, so it is
  // the same wander every frame and every session.
  //
  // Every thread gets a *minimum* bow, not just a random one: a lane whose
  // hash lands near the middle would otherwise run dead straight out of the
  // mass, and a straight line among curves reads as a beam rather than as a
  // hypha. The sign is the hash's; only the magnitude is floored.
  const perp: Point = { x: -outward.y, y: outward.x }
  const lean = hash(lane.id) - 0.5
  const wander = Math.sign(lean || 1) * (0.3 + Math.abs(lean) * 1.4) * Math.min(rx, ry) * 0.45
  const control: Point = {
    x: bundle.x + (rim.x - bundle.x) * 0.6 + perp.x * wander,
    y: bundle.y + (rim.y - bundle.y) * 0.6 + perp.y * wander,
  }

  // THE SPINE (prd7 rulings 3 and 4). Sparse waypoints off the data curve,
  // nudged sideways by this lane's own noise, then interpolated by centripetal
  // Catmull-Rom. The nudge is what makes the fleet look grown rather than
  // drafted, and it is bounded twice over: never more than
  // `WANDER_MAX_SPACING` of the gap between two lanes, and multiplied by zero
  // at both ends — so where the thread leaves the mass and where its node came
  // to rest are bit-identical to what the encoding asked for.
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
  // same work still let go differently, and a rim where they did not is the rim
  // #117 found — which matters more now than it did, because thirty strands
  // whose ends all sat on one perfect ellipse would read as the wreath ruling
  // 13 is trying to stop the field becoming.
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

/** Every retired lane's spine is `[]`, never built (#178's HIDE FINISHED half). */
const EMPTY_PATH: readonly Point[] = []
const EMPTY_FILAMENTS: readonly FilamentGeometry[] = []

/**
 * ONE GENERATION OF SETTLED SPINES, kept until the world they were built in
 * moves (#178). `world` is everything outside a single lane that a spine's
 * points are a function of — see {@link layoutScene}'s own `world` for exactly
 * what that is and why. A new generation drops the old one whole rather than
 * pruning it: every entry in it was keyed to a world that no longer exists, so
 * nothing in it can ever be hit again. `heart.ts`'s cache keeps its bound the
 * same way, on a different clock (a landing's roster) — this one's clock is the
 * scene's own world frame.
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
  // structural cap has not arrived here either and a wave of twelve reads as
  // twelve arrivals instead of one lurch. A scar the operator asked not to look
  // at still counts: hiding finished lanes is a request about clutter, not a
  // claim that the work was undone.
  //
  // `clamp01(cut.withdraw)` rather than `retire.ts`'s `homecoming`, which is the
  // same expression under a better name — and the duplication is deliberate.
  // `motion.ts` imports this file and `retire.ts` imports `motion.ts`, so taking
  // one value out of `retire.ts` closes a cycle and leaves `STRUCTURAL`
  // undefined at module-evaluation time. The dependency on `retire.ts` stays
  // type-only, exactly as it was, and `geometry.test.ts` pins the two readings
  // equal so the copy cannot drift.
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

  // ONE WORLD-FRAME SIGNATURE FOR THIS FRAME (#178) — everything outside a
  // single lane that its cached spine is a function of, so a change to any of
  // it invalidates every settled lane's cache at once rather than letting one
  // drift stale. `width`/`height` catch a resize (they set `centre`, `rx`,
  // `ry`); `rootRadius` catches the mass growing as *other* lanes land (#118 —
  // a settled lane's `root` point is measured off it, every frame, forever);
  // `spacing` catches a new dispatch re-spacing the ring (the file's own "one
  // honest caveat" above) — a lane's own `angle`/`bundleAngle` already move
  // with it, and both are folded into the per-lane cache key below, but the
  // sideways wander's amplitude does not touch either, so it needs its own
  // term. Almost nothing about *this* lane belongs here — see `layoutSpine`'s
  // header for why its own `cut` need not carry `tension`/`withdraw`/`stilled`
  // into the per-lane key below; `drift` is the one field of it that does
  // (reduced motion's `SETTLED_IN_PLACE` reaches `dissolve >= 1` exactly as a
  // normal return does, but pins `drift` at 0 instead of 1 — the swap-in-place
  // that keeps a cut's node from travelling at all).
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

    // HIDE FINISHED SKIPS LAYOUT TOO (#178, prd10 ruling 16). The toggle used to
    // take a settled lane off the canvas by having `persistentMarks` refuse to
    // paint it — but `layoutScene` had already built its Catmull-Rom spine,
    // released it and sampled its filaments before that check ever ran. Once
    // this lane is hideable, none of that runs at all: `rim` above is the only
    // position it gets, and nothing downstream reads it, because every mark
    // builder that touches a retired thread checks `cut.hidden` before it
    // touches `path` or `node` (`marks/thread.ts`, `marks/node.ts`,
    // `marks/dissolve.ts`) — an unbuilt spine is exactly as invisible as an
    // unpainted one.
    const hideable = cut !== null && cut.stage === 'persistent' && options.hideFinished === true

    // SETTLED, AND CACHEABLE (#178). Gated on `cut.dissolve >= 1` rather than on
    // `cut.stage === 'persistent'` alone, on the issue's own instruction: dissolve
    // outlives the settle by design (`retire.ts`), so a lane can be `persistent`
    // for a second or more while its own motes are still visibly travelling home.
    // Past `dissolve >= 1` — `returnAt`'s literal terminal state — `tension`,
    // `withdraw`, `drift` and `stilled` are pinned at 1 for the rest of the
    // session, which is what makes `layoutSpine`'s output a pure function of the
    // world frame from here on: a fresh `cut` object arrives every frame (a new
    // `elapsedMs`, read live by `marks/root.ts`'s ring ordering and never cached
    // here), but every number it feeds into the spine itself has already
    // stopped moving.
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

    // The second walk over the drawn polyline is **gone** with the remnant that
    // needed it (ruling 13). It existed because prd6 ruling 1 measured a lane's
    // work by the arc length of the stub left at the rim, so the drawn arc had to
    // be re-measured after the release bowed it. There is no stub to measure now —
    // the work-size channel is the strand's own width, unbroken from the mass to
    // the node — so a retiring lane costs one polyline walk a frame instead of two.
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
 * (prd6 ruling 3).
 *
 * A retired lane keeps its slot, so when a handle comes back the scene has
 * somewhere to put it: the new thread grows out of the seed already sitting at
 * that angle instead of a stranger appearing on the other side of the ring and
 * re-spacing everybody. That is the whole difference between "the scene remembers
 * where 72 worked" and "the ring reshuffled while you were reading it".
 *
 * **Handles, not ids.** A re-dispatch that reuses the branch is already the same
 * lane to `buildFleet` and needs nothing from this function; the case that needs
 * it is the one where the identity moved — new worktree, new branch — and the only
 * thread of continuity left is the handle workmux launched it under.
 *
 * Retired means "the registry says this lane's cord has been cut", not
 * `isRetired`: a lane whose cut is still queued behind the structural cap is
 * visibly a living thread and is not a seed anybody can grow out of yet. (Reading
 * the map also keeps this file's dependency on `retire.ts` type-only.)
 *
 * At most one sprout per seed, earliest slot first, so two returning lanes cannot
 * both claim the same ground.
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
 * `count` angles spaced by equal **arc length** around the rim, starting at the
 * top and running clockwise.
 *
 * Equal arc rather than equal angle because the panel is wide and short: on a
 * 480×95 ellipse, equal angles pile a third of the fleet into the two ends where
 * there is no room for a label, while equal arc lays them out along the long
 * runs where there is. Deterministic in `(count, rx, ry)`, so a lane's angle is
 * still a pure function of its slot.
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
 * How much rim there is per lane, in px — the unit prd7 ruling 4's wander cap is
 * expressed in.
 *
 * A *fraction of the spacing* rather than a pixel amount, because that is the
 * only form of the bound that stays true at every fleet size and every zoom: a
 * 6px wander is a gentle bend on a rim with four lanes on it and a lane crossing
 * its neighbour's line on a rim with thirty. Ramanujan's ellipse perimeter,
 * which is exact to a part in 10⁵ at any aspect ratio this panel produces.
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
 * THIS LANE'S BUD, or null (prd10 ruling 9).
 *
 * Everything about liveness is **read**, never re-derived: `lane.subagents` is the
 * vital the chips lane landed off `selectSubagentActivity`, whose whole discipline
 * is that liveness comes from thread-marked sessionlog telemetry and a trace span
 * may only ever *enrich* it. This file measures one thing the vital cannot — how
 * stale the reading has got by the frame's own clock — and turns that into a
 * length, which is what makes the bud absorb rather than blink out.
 *
 * The branchlet leaves the parent at {@link BUD_AT}, well inside the filaments'
 * band (0.58 and out) so a bud and a lane's second growth never sit on top of each
 * other, and on the side the lane's free phase says — the same channel the tails
 * and seals lean on, because which way a bud points carries nothing.
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
 * The thread with the tension let out of it and its tip drifted.
 *
 * Two displacements, and each one is a different stage's whole contribution:
 *
 * - **slack**, along the thread's *own* lean. A cord released from a post does
 *   not straighten, it sags — and sagging further along the bow it already has
 *   reads as the same thread going loose, where sagging the other way would read
 *   as something pulling on it. The hump peaks about a third of the way out, so
 *   the loosening is unmistakably at the root end: that is where the strain was.
 * - **drift**, along the rim normal, weighted so it is exactly zero where the
 *   relax reach begins and full at the node. That is what makes the strand keep
 *   its own line for most of its length while its far end eases outward — the two
 *   would fight if the drift were rigid.
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
 * outward relax begins.
 *
 * Walked from the tip backwards over the sampled polyline, which is exact enough:
 * the thread is 44 samples of a cubic, so a segment is a couple of pixels long and
 * the linear interpolation inside the segment the walk stops in is the same
 * approximation the ribbon is drawn with anyway.
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
 * THE WAY HOME (prd6 ruling 2) — where the lane's substance has got to.
 *
 * A stretch of the thread's own centreline, leaving the node when the withdraw
 * begins and gone into the mass when it ends. Not a pulse: pulses are light, and
 * light is what a working lane spends. This is the hypha's *matter* being
 * translocated back through the network — the honest reading of a merge, and the
 * reason the mass it arrives at is thicker afterwards (`marks/root.ts`).
 *
 * It travels on the withdraw's own clock, so nothing new is animated and nothing
 * new is budgeted: the substance comes home over the same 800 ms critically-damped
 * structural stage that the cord is parting over, under the same concurrency cap.
 * Null at both ends of that stage, so it grows out of the node rather than popping
 * into existence and is absorbed by the mass rather than blinking out.
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
 * THE STRAND A FINISHED LANE KEEPS (prd10 rulings 13–15) — the whole of it.
 *
 * **The slicing is gone, and its removal is the issue.** This function used to
 * take a severance parameter and return `span(path, from, …)`: the stretch from
 * the cut to the node, shortening on the withdraw's own spring until prd10
 * ruling 2's dissolve took even that away. Ruling 13 rescinds both, so what a
 * finished lane hands the mark builders is the strand it always had — root-mass
 * rim to node, threaded in at both ends. There is no code path left in this file
 * that can shorten or empty it.
 *
 * The strand keeps the whole thread's taper, so `thread width = work size`
 * survives the transformation intact: a big lane's strand is a visible wedge
 * where a small lane's is a hairline, the same range the living network is drawn
 * over — thinned, by `retire.ts`'s {@link PERSIST_WIDTH_SCALE}, at the point the
 * ribbon is actually built (`marks/thread.ts`). The *encoding* lives here and the
 * *hierarchy* lives there, which is what keeps a retune of one from silently
 * changing the other.
 *
 * What the release does change is the taper's *steepness*: the root end relaxes
 * {@link TAPER_RELAX} of the way toward the tip's width as the tension goes out
 * of it.
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
