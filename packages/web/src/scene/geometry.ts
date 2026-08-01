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
 * THE CUT, as shape (prd5 ruling 3). Null for every lane still in the network.
 *
 * The retirement's *timing* is `retire.ts`'s; this is what those numbers do to
 * the picture, and it is kept beside the living geometry rather than replacing it
 * on purpose. {@link ThreadGeometry.path} stays whole through the whole cut, so
 * the light already in flight along it — a landing packet takes 2.8 s to reach
 * the mass and the cut takes 1.4 — finishes the real journey it was on while the
 * thread behind it lets go. The remnant is what gets *drawn*; the full path is
 * what is still true.
 */
export interface RetireGeometry extends RetireState {
  /** What is left of the thread: severed end → node. The mark actually drawn. */
  path: Point[]
  /** Where the severance sits along the parent path. 0 while still attached. */
  from: number
  /** The remnant's widths, with the released taper already relaxed into them. */
  widthRoot: number
  widthTip: number
  /**
   * THE WAY HOME (prd6 ruling 2). The stretch of the lane's own thread that is
   * currently travelling down it into the root-mass — real mycelium reabsorbs a
   * spent hypha and translocates its substance back through the network, which is
   * what a merge is. Null whenever nothing is in transit: before the retract
   * begins, after it has arrived, and for every scar that was never watched
   * leaving (history, replay, reduced motion) — a journey nobody saw start is a
   * journey that did not happen on this screen.
   *
   * It runs the **full** path rather than the remnant, for the same reason the
   * light already in flight does: the whole thread is still true while the mark
   * being drawn is only what is left of it.
   */
  homeward: Point[] | null
  /**
   * The operator's hide-finished toggle applies to this lane, so it draws
   * nothing at all. Only ever true of a *settled* scar — a cut in progress is
   * news and is always shown, because the one thing worse than a scar you did
   * not want is a completion you never saw.
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
  rootRadius: number
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
 * The pin reads {@link RetireState.drift} rather than the retract, which is the
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
 * {@link RADIAL_BORN}, pushed out far enough that a newborn node clears the mass
 * on this panel. Measured against the *smaller* half-axis, because that is the
 * direction the rim runs closest to the mass in — a lane born at the top of a
 * letterbox ellipse must clear it as surely as one born at the side.
 */
export function bornRadial(rootRadius: number, rx: number, ry: number): number {
  const smaller = Math.max(1, Math.min(rx, ry))
  return Math.min(0.9, Math.max(RADIAL_BORN, (rootRadius + BORN_CLEARANCE_PX) / smaller))
}

/**
 * How far through its life a lane is, 0–1. `homecoming` is the retract of its
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
  // The pin closes whatever distance is left, over the cut's own retract, so a
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
 * How much of its own thread a scar keeps, **in px of arc length**.
 *
 * A length rather than a fraction, and that half of #102 stands: the rim is a wide
 * ellipse, so a lane at three o'clock has a thread three times as long as one at
 * noon, and keeping a fixed *fraction* of it made a scar's size a fact about the
 * panel's aspect ratio. Nothing means that.
 *
 * What prd6 ruling 1 overrules is the other half — "a scar is a mark, so it is the
 * same size for every lane". The rim is where the session's finished work is on
 * display, and a rim that shows nine identical stubs is a rim that has thrown away
 * the only thing it had to say about them. So the mark is sized by the lane's own
 * work on the same absolute scale everything else is ({@link seedSize}), between a
 * floor that still reads as a tapering ribbon and a ceiling that still reads as a
 * stub rather than as a thread left floating.
 */
export const SCAR_LENGTH_MIN_PX = 22
export const SCAR_LENGTH_MAX_PX = 46

/** The scar length a lane of this work-size keeps, in px of arc. */
export function scarLengthPx(sizeFrac: number): number {
  return SCAR_LENGTH_MIN_PX + (SCAR_LENGTH_MAX_PX - SCAR_LENGTH_MIN_PX) * clamp01(sizeFrac)
}

/**
 * …but never more than this much of a short thread. On a cramped panel a lane's
 * whole thread can be shorter than the mark, and a scar that consumed it would
 * have severed nothing.
 */
const SCAR_MAX_FRACTION = 0.4

/**
 * How far a retiring lane's *freed tip* relaxes outward, on top of the journey to
 * the rim the lifecycle pin is already carrying it on. A local bend, not a
 * translation: it is what makes the released end ease out while the severance
 * travels the other way.
 */
const RETIRE_DRIFT_PX = 9

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
   * The frame's clock. Both continuous facts in the layout are carried forward
   * from the fleet snapshot with it rather than read straight off it — the
   * lifecycle's age term against `lane.firstSeenAt`, and recency's `ageFrac`
   * by `now - fleet.now` — because otherwise every lane in the picture would
   * step forward together once a second as the derived model is rebuilt. Ruling
   * 32 blesses the glide.
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

export function layoutScene(fleet: Fleet, options: LayoutOptions): SceneGeometry {
  const { width, height, now } = options
  const centre: Point = { x: width / 2, y: height / 2 }
  // Big enough to read as the *mass* the threads are threaded into, rather than
  // as one more node that happens to sit in the middle.
  const rootRadius = Math.max(26, Math.min(width, height) * 0.11)

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

  const born = bornRadial(rootRadius, rx, ry)

  const sinceSnapshot = Math.max(0, now - fleet.now)

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
    // last stretch — the part that becomes the scar — outward. Its retract is also
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
      x: centre.x + rx * 0.32 * Math.cos(bundleAngle),
      y: centre.y + ry * 0.32 * Math.sin(bundleAngle),
    }

    // It leaves the mass already leaning toward its bundle.
    const exitAngle = angle + angleDelta(angle, bundleAngle) * 0.6
    const root: Point = {
      x: centre.x + rootRadius * 0.94 * Math.cos(exitAngle),
      y: centre.y + rootRadius * 0.94 * Math.sin(exitAngle),
    }

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
    const wander =
      Math.sign(lean || 1) * (0.3 + Math.abs(lean) * 1.4) * Math.min(rx, ry) * 0.45
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

    const growth = clamp01(options.growth?.get(lane.id) ?? 1)
    const full = smoothSpine(waypoints, THREAD_SAMPLES)
    const grown = growth >= 1 ? full : truncate(full, easeOut(growth))

    const slack = Math.min(SLACK_MAX_PX, Math.max(SLACK_MIN_PX, Math.min(rx, ry) * SLACK_FRACTION))
    // Measured on the thread as it *was*, so the resting place of the severance —
    // and the stretch of thread the drift is allowed to bend — do not shift under
    // the deformation they are about to be used to compute.
    const rest = cut === null ? 1 : scarRest(grown, scarLengthPx(sizeFrac))
    const path =
      cut === null
        ? grown
        : released(grown, {
            along: perp,
            side: Math.sign(lean || 1),
            slack: slack * cut.tension,
            outward,
            drift: RETIRE_DRIFT_PX * cut.drift,
            from: rest,
          })
    const node = path[path.length - 1] as Point

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
      path,
      node,
      outward,
      widthRoot,
      widthTip,
      sizeFrac,
      ageFrac,
      lifeFrac,
      germinatedFrom: seed ?? null,
      growth,
      filaments: layoutFilaments(lane, path, widthTip, perp),
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
          : severance(cut, path, rest, widthRoot, widthTip, options.hideFinished === true),
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

// ── the cut, as shape ───────────────────────────────────────────────────────

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
  /** Where the severance comes to rest — the stretch of thread the drift bends. */
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
 * - **drift**, along the rim normal, weighted so it is exactly zero at the point
 *   the severance will reach and full at the node. That is what makes the freed
 *   end trace the thread's own path while the node still eases outward — the two
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

/** Zero everywhere but the stretch that becomes the scar, easing in and out. */
function driftWeight(t: number, from: number): number {
  const span = 1 - from
  if (span <= 0) return clamp01(t) >= 1 ? 1 : 0
  const into = (clamp01(t) - from) / span
  return into <= 0 ? 0 : smooth(into)
}

/**
 * The path parameter `lengthPx` of arc length back from the node — where the freed
 * end comes to rest.
 *
 * Walked from the tip backwards over the sampled polyline, which is exact enough:
 * the thread is 44 samples of a cubic, so a segment is a couple of pixels long and
 * the linear interpolation inside the segment the walk stops in is the same
 * approximation the ribbon is drawn with anyway.
 */
function scarRest(path: readonly Point[], lengthPx: number): number {
  const last = path.length - 1
  if (last < 1) return 0

  let total = 0
  for (let i = last; i > 0; i -= 1) {
    const a = path[i] as Point
    const b = path[i - 1] as Point
    const step = Math.hypot(a.x - b.x, a.y - b.y)
    if (total + step >= lengthPx) {
      const within = step === 0 ? 0 : (lengthPx - total) / step
      return Math.max(1 - SCAR_MAX_FRACTION, (i - within) / last)
    }
    total += step
  }
  // The whole thread is shorter than the mark: keep the tail fraction instead.
  return 1 - SCAR_MAX_FRACTION
}

/**
 * THE WAY HOME (prd6 ruling 2) — where the lane's substance has got to.
 *
 * A stretch of the thread's own centreline, leaving the node when the retract
 * begins and gone into the mass when it ends. Not a pulse: pulses are light, and
 * light is what a working lane spends. This is the hypha's *matter* being
 * translocated back through the network — the honest reading of a merge, and the
 * reason the mass it arrives at is thicker afterwards (`marks/root.ts`).
 *
 * It travels on the retract's own clock, so nothing new is animated and nothing
 * new is budgeted: the substance comes home over the same 800 ms critically-damped
 * structural stage that the cord is parting over, under the same concurrency cap.
 * Null at both ends of that stage, so it grows out of the node rather than popping
 * into existence and is absorbed by the mass rather than blinking out.
 */
function homewardFlow(path: readonly Point[], retract: number): Point[] | null {
  if (retract <= 0 || retract >= 1) return null

  // Measured in arc length rather than in path parameter: the samples of a cubic
  // are not evenly spaced along it, so a fixed *parameter* span would send three
  // times as much substance home from one end of the ellipse as from the other.
  const cumulative = arcTable(path)
  const total = cumulative[cumulative.length - 1] ?? 0
  if (total <= 0) return null

  const parcel = Math.min(HOMEWARD_LENGTH_PX, total * 0.5)
  // The leading (rootward) edge, from the node at `total` to one parcel-length
  // past the mass — which is where the last of it disappears under the mass.
  const lead = total - (total + parcel) * retract
  const from = Math.max(0, lead)
  const to = Math.min(total, lead + parcel)
  if (to - from < 0.5) return null

  return between(path, paramAtArc(cumulative, from), paramAtArc(cumulative, to), 12)
}

/**
 * What is left of a thread mid-cut: the stretch from the severance to the node,
 * resampled at its own resolution, with the released taper folded into its
 * widths.
 *
 * The remnant keeps the **whole thread's** taper, gathered into whatever length is
 * left, rather than being sliced out of it at the severance point. A cord that
 * springs back is gathering up, not evaporating — and sliced widths would have the
 * mark grow thinner and thinner as it retracted, which reads as the thread fading
 * out at exactly the moment the ruling says it must not. It also keeps the whole
 * of `thread width = work size` in the scar: a big lane's mark is a visible wedge
 * where a small lane's is a hairline, the same range the living network is drawn
 * over.
 *
 * What the release does change is the taper's *steepness*: the root end relaxes
 * {@link TAPER_RELAX} of the way toward the tip's width as the tension goes out
 * of it.
 */
function severance(
  cut: RetireState,
  path: readonly Point[],
  rest: number,
  widthRoot: number,
  widthTip: number,
  hideFinished: boolean,
): RetireGeometry {
  const from = cut.retract * rest
  const relaxed = widthRoot + (widthTip - widthRoot) * TAPER_RELAX * cut.tension

  return {
    ...cut,
    from,
    // Enough samples that a remnant still reads as a curve at every length it
    // passes through — the full count while it is still nearly a whole thread,
    // a floor once it is a stub.
    path: span(path, from, Math.max(10, Math.ceil(THREAD_SAMPLES * (1 - from)))),
    widthRoot: relaxed,
    widthTip,
    homeward: homewardFlow(path, cut.retract),
    // Only a *settled* scar is hideable. A cut in progress is news, and the one
    // thing worse than a scar the operator asked not to see is a completion they
    // never saw at all.
    hidden: hideFinished && cut.stage === 'scar',
  }
}

/** The stretch of a path from `from` to its end, resampled to `steps` segments. */
function span(path: readonly Point[], from: number, steps: number): Point[] {
  return between(path, from, 1, steps)
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
