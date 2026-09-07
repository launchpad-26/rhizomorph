import type { ThreadGeometry, WorldGeometry } from '../geometry.js'
import { ICE_1000, ink } from '../palette.js'
import { ambientScreenMarks, ambientWorldMarks } from './ambient.js'
import { dissolveMarks } from './dissolve.js'
import { lightMarks } from './light.js'
import { labelMarks, nodeMarks } from './node.js'
import { rootMarks } from './root.js'
import { loopingMarks, offFenceMarks, threadMarks } from './thread.js'
import type { Mark, MarkRole } from './types.js'
import type { SceneFrame } from './frame.js'

export * from './frame.js'
export * from './types.js'

/**
 * THE WHOLE PICTURE, as one list.
 *
 * `sceneMarks` is the only entry point: given a frame it returns every mark, in
 * paint order, and `paint.ts` executes them without making a single decision of
 * its own. Everything a test wants to know — "is the frozen lane cut?", "does
 * the expensive lane out-read the summons?" — is a query over this array.
 *
 * The order below is the picture's depth, and each layer is where it is for a
 * reason rather than by accident:
 *
 * 0. **the ambient substrate** (prd10 ruling 6) — spores in the void and flora on
 *    the fold, *underneath* everything, so a thread passes in front of a spore and
 *    the mass covers the ones behind it. Substrate drawn over the network would be
 *    decoration; substrate the network sits on top of is depth;
 * 1. **threads and second growth** — the substrate everything else sits on,
 *    **finished lanes first** ({@link byDepth}, prd10 ruling 16);
 * 2. **off-fence reaches, then the boundaries they crossed** — the victim's
 *    marking last, so the reach is visibly *through* it rather than behind it;
 * 3. **the root-mass and its anatomy** — drawn over the threads' inner ends, so
 *    they read as threaded *into* it rather than as lines that stop nearby, and
 *    carrying the heart's growth rings and hyphal fan inside its own body;
 * 4. **light in flight** — above the substrate it travels on, always;
 * 5. **matter returning** (prd10 ruling 2) — the composting drift, over the cord it
 *    is coming off and under the states, because a mote must never occlude a
 *    summons however many of them there are;
 * 6. **the states, at the nodes** — over the light, because a summons must never
 *    be occluded by traffic;
 * 7. **labels** — over everything in the world, so a name is never half-drawn;
 * 8. **the panel's own depth** (prd10 ruling 6) — fog, vignette and grain, painted
 *    in the chrome pass at screen scale, then the gap voice over them so a caveat
 *    is never dimmed by the fog laid over the picture it is about.
 */
export function sceneMarks(frame: SceneFrame): Mark[] {
  return [...colonyMarks(frame), ...screenMarks(frame)]
}

/**
 * Layers 0–7: everything belonging to **one colony**, in world space.
 *
 * Split out of {@link sceneMarks} for prd-52 ruling 1, so a world can run it
 * once per colony. The seam is the one the depth list above already draws:
 * layer 8 is "the panel's own depth", a fact about the viewport rather than
 * about any colony, and running it per colony would stack N fogs and print the
 * gap voice N times over itself.
 */
export function colonyMarks(frame: SceneFrame): Mark[] {
  const { threads } = frame.geometry
  const depth = byDepth(threads)
  const marks: Mark[] = []

  marks.push(...ambientWorldMarks(frame))
  for (const thread of depth) marks.push(...threadMarks(frame, thread))
  for (const thread of threads) marks.push(...offFenceMarks(frame, thread))
  marks.push(...rootMarks(frame))
  for (const thread of threads) marks.push(...lightMarks(frame, thread))
  for (const thread of threads) marks.push(...loopingMarks(frame, thread))
  marks.push(...dissolveMarks(frame))
  for (const thread of depth) marks.push(...nodeMarks(frame, thread))
  for (const thread of depth) marks.push(...labelMarks(frame, thread))

  return marks
}

/** Layer 8: the panel's own depth, and the scene's gap voice. Once per picture. */
function screenMarks(frame: SceneFrame): Mark[] {
  return [...ambientScreenMarks(frame), ...chromeMarks(frame)]
}

/**
 * THE WHOLE WORLD, as one list (prd-52 ruling 1).
 *
 * Each colony's marks are already in world coordinates — `layoutScene` was
 * handed that colony's `origin` and put it into the mass's centre — so
 * composing is a **concatenation, not a walk**. That is the whole reason the
 * origin lives in `LayoutOptions`: a translator over the composed list would
 * need a case per mark kind, and every kind added afterwards would be a silent
 * miss that drew one colony in the wrong place.
 *
 * Depth layers **within** each colony rather than across them. Colonies occupy
 * disjoint boxes, so a finished strand in one cannot be crossed by a living one
 * in another; interleaving nine builders across N colonies would reorder marks
 * that never overlap.
 *
 * `frame` supplies the screen pass — fog, vignette, grain and the gap voice —
 * which belongs to the panel, once, however many colonies it holds.
 */
export function worldMarks(world: WorldGeometry, frame: SceneFrame): Mark[] {
  const marks: Mark[] = []
  for (const colony of world.colonies) {
    marks.push(
      ...colonyMarks({
        ...frame,
        fleet: colony.fleet,
        geometry: colony.geometry,
        // The material ceiling is keyed on the WORLD's size, not this
        // colony's (prd-52 ruling 5) — the frame budget is spent by the whole
        // picture, and a colony that judged itself would thin at N times the
        // fleet size the ruling means.
        worldThreads: world.threadCount,
      }),
    )
  }
  marks.push(...screenMarks(frame))
  return marks
}

/**
 * DEPTH LAYERING (prd10 ruling 16) — finished lanes behind living ones.
 *
 * The third of the three channels ruling 14's hierarchy is bought in, and the one
 * that only exists at scale: a thin, dim strand still crosses a bright one
 * somewhere on a thirty-lane field, and *which of them is in front* is the whole
 * difference between a network with living work on top of its own history and a
 * mesh where the two are the same kind of thing. The ruling's own words: density
 * is managed by thinness, stillness and **depth layering**, never by removal.
 *
 * It costs one partition of an array a frame and no marks at all, which is why it
 * is spent here rather than as a per-mark z-order the painter would have to sort.
 * Stable within each group, so slot order — graft g7's whole subject — survives:
 * this re-layers the picture, it never re-spaces the fleet.
 *
 * Applied to the nodes and the labels as well as to the strands, and for the same
 * reason at the same scale: a living lane's name must win an overlap with a
 * finished one's, because the finished one can wait.
 */
export function byDepth(threads: readonly ThreadGeometry[]): ThreadGeometry[] {
  const finished: ThreadGeometry[] = []
  const living: ThreadGeometry[] = []
  for (const thread of threads) (thread.retire === null ? living : finished).push(thread)
  return finished.length === 0 ? [...threads] : [...finished, ...living]
}

/** The void the network hangs in — the one mark that is not about a lane. */
export const BACKDROP = ink(ICE_1000, 1)

/**
 * The scene's own gap voice (law 12). Two things can make the picture less than
 * the truth, and both say so on the canvas rather than being swallowed:
 *
 * - **traffic the pulse cap refused.** A hard ceiling that silently ate events
 *   would make the flow a guess about the fleet rather than a report on it.
 * - **a pathology that cannot be judged.** Without `/api/lanes` there is no
 *   fence to cross, so OFF-FENCE is declared *unavailable* — never guessed from
 *   a lane name (ruling 19), and never left looking like "all clear".
 */
function chromeMarks(frame: SceneFrame): Mark[] {
  const lines: string[] = []
  if (!frame.fleet.hasLaneManifest) lines.push('NO LANE MANIFEST — off-fence unavailable')

  const dropped = frame.field.dropped()
  if (dropped > 0) lines.push(`${dropped} pulses dropped at the cap`)

  return lines.map((text, i) => ({
    kind: 'text' as const,
    role: 'gap' as const satisfies MarkRole,
    laneId: null,
    alarm: false,
    at: { x: 8, y: frame.geometry.height - 8 - i * 12 },
    text,
    font: 'mono' as const,
    size: 9,
    weight: 500,
    align: 'left' as const,
    // Body-copy brightness, not footnote brightness: the gap voice is the scene
    // telling the truth about itself, and a caveat nobody can read is a caveat
    // that was not made (law 12).
    ink: ink(frame.palette.register.body, 0.85),
  }))
}
