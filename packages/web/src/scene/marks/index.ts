import { ICE_300, ICE_1000, ink } from '../palette.js'
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
 * 1. **threads and second growth** — the substrate everything else sits on;
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
  const { threads } = frame.geometry
  const marks: Mark[] = []

  marks.push(...ambientWorldMarks(frame))
  for (const thread of threads) marks.push(...threadMarks(frame, thread))
  for (const thread of threads) marks.push(...offFenceMarks(frame, thread))
  marks.push(...rootMarks(frame))
  for (const thread of threads) marks.push(...lightMarks(frame, thread))
  for (const thread of threads) marks.push(...loopingMarks(frame, thread))
  marks.push(...dissolveMarks(frame))
  for (const thread of threads) marks.push(...nodeMarks(frame, thread))
  for (const thread of threads) marks.push(...labelMarks(frame, thread))
  marks.push(...ambientScreenMarks(frame))
  marks.push(...chromeMarks(frame))

  return marks
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
    ink: ink(ICE_300, 0.85),
  }))
}
