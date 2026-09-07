/**
 * THE WORLD THAT HOLDS THE COLONIES (prd-52 ruling 1).
 *
 * `layoutScene` lays out one colony and centres it in the box it is handed.
 * This file is the layer above: it decides *where each colony's box is* and
 * calls `layoutScene` once per colony. prd-33 ruling 7 said the scene was
 * "composed as a world that holds several colonies" and that no redesign
 * would be required when the team layer landed — true of the architecture,
 * and this file is the code that was never written to match it.
 *
 * **A colony's geometry is colony-local, and `origin` is what places it.**
 * The alternative — passing a centre offset down and having `layoutScene`
 * emit world coordinates — would put a translation term inside every
 * geometric fact the layout produces, and every law that reads one would
 * then be reading a sum. Keeping the translation *here* is what makes
 * ruling 2 provable rather than argued: at one colony this layer hands
 * `layoutScene` the identical options it gets today, so the geometry that
 * comes back is not merely equivalent, it is the same object graph the
 * single-colony path produces. `world.test.ts` pins that.
 *
 * Nothing in this file reads where a fleet came from. prd-52 ruling 6: the
 * world takes fleets as an argument and has no mechanism to fetch one, which
 * is how the team server's first law — nothing comes back down onto anyone's
 * laptop — is satisfied here by construction rather than by care.
 */
import type { Fleet } from '../../fleet/index.js'
import { layoutScene } from './layout.js'
import type { LayoutOptions, Point, SceneGeometry } from './types.js'

/**
 * One colony to lay out: a fleet, and the name the caller knows it by.
 *
 * **The order of sources is the world's arrangement, and it must be stable.**
 * Slot 0 is the centre and slots 1.. are the ring, so the caller's order IS
 * where people stand. Keep it as arrival order and append new colonies at the
 * end: then a colony joining moves nobody, and `world.test.ts` holds that as a
 * law. Never re-sort it — and in particular never reorder it to put the viewer
 * first. Which colony is the viewer's is the camera's business, found by id; a
 * world whose geography depended on who was looking would not be shared, it
 * would be N private worlds that happened to hold the same people.
 *
 * The id is the caller's to supply and is deliberately not derived here.
 * `RootMass` carries `repoName`, `mainBranch` and `worktreePath`, and none of
 * them identifies a colony: **several people working one repository is the
 * case this whole layer exists for**, so `repoName` collides exactly when it
 * matters most, and a teammate's `worktreePath` is a path on a machine that
 * is not this one. Naming a colony is the caller's act — which is also
 * ruling 6 holding: this file does not infer whose work it is drawing.
 */
export interface ColonySource {
  id: string
  fleet: Fleet
}

/** One colony's placed geometry. */
export interface ColonyGeometry {
  /** The id the caller supplied for this colony. */
  id: string
  /**
   * Top-left of this colony's allocated box, in world coordinates, and the
   * origin {@link geometry} was **laid out with** — not an offset still owed to
   * it. `{ x: 0, y: 0 }` for the single-colony case, by construction.
   *
   * Kept on the colony because the placement is a fact worth reading back (the
   * camera frames by it, and a test asserts the boxes tile), not because
   * anything downstream has to apply it.
   */
  origin: Point
  /** The colony's geometry, already placed in world coordinates. */
  geometry: SceneGeometry
  /**
   * The fleet this geometry was laid out from. Carried because the mark
   * builders read the fleet as well as the geometry — the gap voice asks it
   * whether a lane manifest arrived — so composing a world means composing a
   * frame per colony, and a colony that could not answer for its own fleet
   * would have to borrow its neighbour's.
   */
  fleet: Fleet
}

export interface WorldGeometry {
  width: number
  height: number
  colonies: ColonyGeometry[]
  /**
   * Threads across every colony. This is the input prd-52 ruling 5's detail
   * substitution keys off — the world's size, not one colony's, because the
   * frame budget is spent by the whole picture.
   */
  threadCount: number
}

/**
 * How far out the ring of other colonies sits, as a multiple of the box.
 *
 * Every colony is laid out at the FULL box — nothing shrinks to make room —
 * so two colonies overlap unless they are at least a box apart in one axis.
 * A ring offset of `(cos θ · width, sin θ · height) · k` is at least a box
 * apart in some axis when `k ≥ 1 / max(|cos θ|, |sin θ|)`, whose worst case is
 * 45° and `√2`. 1.5 clears it with margin, and `world.test.ts` proves the
 * content bounds stay disjoint up to nine colonies rather than trusting the
 * arithmetic. Past eight or so on one ring the neighbours start to crowd; a
 * second ring is the follow-up when a team that size exists.
 */
export const RING_SPACING = 1.5

/**
 * Where the `i`-th ring colony sits, for `count` on the ring.
 *
 * The first slot is due east so a two-person world reads left to right; the
 * rest are spaced evenly. Elliptical in the box's own aspect, because the
 * colonies are: a wide panel gives a wide ring.
 */
export function ringOrigin(i: number, count: number, width: number, height: number): Point {
  const angle = (i / count) * Math.PI * 2
  return {
    x: Math.cos(angle) * width * RING_SPACING,
    y: Math.sin(angle) * height * RING_SPACING,
  }
}

/**
 * Lay out a world of colonies — **one surface, one arrangement, whoever is
 * looking** (prd-52, placement ruled 2026-09-07, amended the same day).
 *
 * Not a grid. One continuous surface: `sources[0]` is laid out exactly where
 * a solo colony is laid out today and the rest take slots on a ring around it,
 * each at the full box size and each byte-identical to how it would draw
 * alone. Only the origin differs between colonies. Three things follow, and
 * each is a law in `world.test.ts`:
 *
 * - **a solo colony is unchanged** (ruling 2) — with one source this is
 *   `layoutScene(fleet, options)` and nothing else;
 * - **a colony joining moves nobody** — append a source and every existing
 *   colony's origin and geometry are the same object graph they were;
 * - **every colony looks the way its owner sees it** — no colony is shrunk,
 *   so its mass radius and rim half-axes are the solo values. Thread width is
 *   a locked channel meaning work size, and a colony drawn smaller to signal
 *   distance would be lying about its fleet. Perspective is the camera's job.
 *
 * **This layout does not know who is looking, and must not.** The viewer is
 * not slot 0; the viewer is whichever colony the camera finds by id, and most
 * of the time that is somewhere on the ring, because most of the time someone
 * else arrived first. A world that put the viewer at the origin would give
 * every teammate a different map of the same repository. Slot 0 is simply
 * the first colony in the caller's stable order — in practice whoever started
 * work first — and that carries no meaning beyond arrival, stated here so it
 * is not read as one (prd-37 ruling 5: never rank people). Placing colonies
 * by what they are touching would make the landscape mean something; it waits
 * on cross-colony data that nothing can carry yet.
 */
export function layoutWorld(
  sources: readonly ColonySource[],
  options: LayoutOptions,
): WorldGeometry {
  const { width, height } = options
  const colonies: ColonyGeometry[] = []
  let threadCount = 0

  for (const [i, { id, fleet }] of sources.entries()) {
    // The first source is handed the options untouched rather than an origin
    // of `{0,0}` folded in. The arithmetic agrees, but ruling 2 is a
    // byte-identity claim, and the cheapest way to keep one true is to leave
    // no arithmetic between it and the thing it claims about.
    const origin = i === 0 ? ORIGIN : ringOrigin(i - 1, sources.length - 1, width, height)
    const geometry = i === 0 ? layoutScene(fleet, options) : layoutScene(fleet, { ...options, origin })
    colonies.push({ id, origin, geometry, fleet })
    threadCount += geometry.threads.length
  }

  return { width, height, colonies, threadCount }
}

const ORIGIN: Point = { x: 0, y: 0 }

