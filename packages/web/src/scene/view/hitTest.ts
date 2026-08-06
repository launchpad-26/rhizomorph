import { MAIN_SELECTION } from '../../fleet/index.js'
import { toWorld, type Camera } from '../camera.js'
import type { SceneGeometry } from '../geometry.js'

/** How close to a node a pointer must be to have picked it, in CSS pixels. */
export const HIT_RADIUS = 30

/**
 * How far outside the root-mass's own rim still counts as having clicked it, in
 * CSS pixels (prd6 ruling 5).
 *
 * Small, unlike {@link HIT_RADIUS}, and for the opposite reason: a node is a
 * ~10px lens that needs a generous catchment to be clickable at all, while the
 * mass is the largest object in the picture and needs only the slack a hand
 * aiming at an edge asks for. Both are screen quantities — divided by the scale
 * at the hit test, so the tolerance is thirty (or eight) *pixels* at 6× as much
 * as at 0.4×.
 */
export const ROOT_HIT_SLACK = 8

/**
 * What is under the pointer: the nearest node within {@link HIT_RADIUS}, the
 * root-mass ({@link MAIN_SELECTION}) when the pointer is on the mass itself,
 * or null.
 *
 * The pointer is put back into world coordinates before anything is measured,
 * and every radius is divided by the scale rather than left alone: the
 * tolerance is a property of the hand holding the mouse, so it stays thirty
 * screen pixels at 6× as much as at 0.4×.
 *
 * **Lanes first, the mass second.** They can overlap — a lane whose node has
 * not drifted out yet sits close in against the mass, and at the far end of a
 * zoom-out everything is close to everything. A node is the smaller, more
 * specific target and the one an operator aiming at it meant; the mass is
 * what is left when they were not aiming at a lane at all.
 */
export function pickAt(
  geometry: SceneGeometry | null,
  canvas: HTMLCanvasElement | null,
  camera: Camera,
  clientX: number,
  clientY: number,
): string | null {
  if (geometry === null || canvas === null) return null

  const rect = canvas.getBoundingClientRect()
  const at = toWorld(camera, { x: clientX - rect.left, y: clientY - rect.top })

  let best: string | null = null
  let bestDistance = HIT_RADIUS / camera.k
  for (const thread of geometry.threads) {
    const distance = Math.hypot(thread.node.x - at.x, thread.node.y - at.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = thread.laneId
    }
  }
  if (best !== null) return best

  // MAIN was the one thing on screen that could not be clicked (prd6 ruling
  // 5). The mass is drawn from `geometry.rootRadius` about `geometry.centre`,
  // both world quantities, so the same two numbers that draw it catch the
  // pointer — nothing here re-derives where the mass is.
  const toCentre = Math.hypot(geometry.centre.x - at.x, geometry.centre.y - at.y)
  return toCentre <= geometry.rootRadius + ROOT_HIT_SLACK / camera.k ? MAIN_SELECTION : null
}
