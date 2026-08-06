import type { Lane, PathologyKind } from '../../fleet/index.js'
import type { RetireState } from '../retire.js'

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
 * THE RETURN, as shape (prd10 rulings 13–15). Null for every lane still
 * working. The retirement's *timing* is `retire.ts`'s; this is what those
 * numbers do to the picture — a **strand**, not a remnant. Nothing here
 * shortens it or returns an empty path. See
 * docs/design-notes/geometry-return-as-shape.md.
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
