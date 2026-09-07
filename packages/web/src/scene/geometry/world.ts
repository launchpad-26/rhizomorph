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
   * Top-left of this colony's allocated box, in world coordinates. Add it to
   * any point in {@link geometry} to place that point in the world.
   * `{ x: 0, y: 0 }` for the single-colony case, by construction.
   */
  origin: Point
  /** The colony's own geometry, in colony-local coordinates. */
  geometry: SceneGeometry
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
 * How many columns to break `count` colonies into so the cells come out as
 * square as the box allows.
 *
 * Square-ish matters because a colony is a radial mass: it fills a circle
 * inscribed in its cell, so a long thin cell wastes the difference and the
 * masses read as smaller than the space they were given. Choosing the column
 * count by cell aspect rather than by a fixed grid is what lets 3 colonies
 * sit in a row on a wide viewport and stack on a narrow one.
 *
 * The *arrangement* — grid versus a radial ring versus packing by mass size —
 * is an open question on prd-52 and deliberately not ruled here. This is a
 * defensible default, not a decision; it is one function, and replacing it
 * does not reach any other file.
 */
export function colonyColumns(count: number, width: number, height: number): number {
  if (count <= 1) return 1
  let best = 1
  let bestPenalty = Number.POSITIVE_INFINITY
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const aspect = width / cols / (height / rows)
    // Distance from square, measured on a log scale so that 2:1 and 1:2 are
    // equally bad. A linear |aspect - 1| would quietly prefer tall cells.
    const penalty = Math.abs(Math.log(aspect))
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      best = cols
    }
  }
  return best
}

/**
 * Lay out a world of colonies.
 *
 * At one colony this is `layoutScene` with the options it was handed and an
 * origin of zero — see the note at the top of this file, and ruling 2.
 */
export function layoutWorld(
  sources: readonly ColonySource[],
  options: LayoutOptions,
): WorldGeometry {
  const { width, height } = options
  const cols = colonyColumns(sources.length, width, height)
  const rows = Math.max(1, Math.ceil(sources.length / cols))
  const single = sources.length <= 1
  // At one colony the options are passed through untouched rather than
  // recomputed as `width / 1`. The arithmetic agrees, but ruling 2 is a
  // byte-identity claim and the cheapest way to keep a claim like that true
  // is to leave no arithmetic between it and the thing it claims about.
  const cellWidth = single ? width : width / cols
  const cellHeight = single ? height : height / rows

  const colonies: ColonyGeometry[] = []
  let threadCount = 0

  for (const [i, { id, fleet }] of sources.entries()) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const geometry = single
      ? layoutScene(fleet, options)
      : layoutScene(fleet, { ...options, width: cellWidth, height: cellHeight })
    colonies.push({
      id,
      origin: single ? ORIGIN : { x: col * cellWidth, y: row * cellHeight },
      geometry,
    })
    threadCount += geometry.threads.length
  }

  return { width, height, colonies, threadCount }
}

const ORIGIN: Point = { x: 0, y: 0 }
