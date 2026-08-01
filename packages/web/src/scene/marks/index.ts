import { ICE_400, ICE_1000, ink } from '../palette.js'
import { lightMarks } from './light.js'
import { labelMarks, nodeMarks } from './node.js'
import { rootMarks } from './root.js'
import { knotMarks, rogueMarks, threadMarks } from './thread.js'
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
 * 1. **threads and second growth** — the substrate everything else sits on;
 * 2. **rogue reaches, then the fences they went through** — the fence last, so
 *    the filament is visibly *through* it rather than behind it;
 * 3. **the root-mass** — drawn over the threads' inner ends, so they read as
 *    threaded *into* it rather than as lines that stop nearby;
 * 4. **light in flight** — above the substrate it travels on, always;
 * 5. **knots, nodes, hands, cartouches** — the states, over the light, because a
 *    summons must never be occluded by traffic;
 * 6. **labels** — last, over everything, so a name is never half-drawn.
 */
export function sceneMarks(frame: SceneFrame): Mark[] {
  const { threads } = frame.geometry
  const marks: Mark[] = []

  for (const thread of threads) marks.push(...threadMarks(frame, thread))
  for (const thread of threads) marks.push(...rogueMarks(frame, thread))
  marks.push(...rootMarks(frame))
  for (const thread of threads) marks.push(...lightMarks(frame, thread))
  for (const thread of threads) marks.push(...knotMarks(frame, thread))
  for (const thread of threads) marks.push(...nodeMarks(frame, thread))
  for (const thread of threads) marks.push(...labelMarks(frame, thread))
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
    ink: ink(ICE_400, 0.75),
  }))
}
