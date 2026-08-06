import type { KeyboardEvent } from 'react'
import { ZOOM_STEP } from '../camera.js'

/**
 * A grabbing hand while the scene is actually being dragged, an open one while
 * space says it is about to be, and the ordinary pointer the rest of the time —
 * because the rest of the time a click on this canvas selects a lane, and a
 * canvas that permanently advertises "grab me" is a canvas nobody clicks.
 *
 * The one exception is a pointer that is actually *over* something: a hovered
 * node or the root-mass gets the hand, which is how a canvas — the one surface
 * in the instrument that cannot advertise its own targets in markup — says that
 * this pixel does something and the one beside it does not.
 */
export function cursorOf(panning: boolean, grabReady: boolean, overTarget: boolean): string {
  if (panning) return 'cursor-grabbing'
  if (grabReady) return 'cursor-grab'
  return overTarget ? 'cursor-pointer' : 'cursor-default'
}

export interface CameraKeyActions {
  fit: () => void
  home: () => void
  step: (factor: number) => void
  setGrabReady: (ready: boolean) => void
}

/**
 * The camera's keys, scoped to a focused scene.
 *
 * They have to be scoped: `1` already means "switch to the live stream"
 * everywhere else on the page (`StreamContext`'s fixture keys), and a
 * viewport control that hijacks a global one from across the page is worse
 * than a viewport control nobody found. Focus is the scope — click the scene
 * or tab to it — and the keys the camera claims stop propagating so the
 * global handler never sees them.
 */
export function onSceneKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  { fit, home, step, setGrabReady }: CameraKeyActions,
): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return

  const claimed = () => {
    event.preventDefault()
    event.stopPropagation()
  }

  switch (event.key) {
    case '1':
      claimed()
      fit()
      return
    case '0':
      claimed()
      home()
      return
    case '+':
    case '=':
      claimed()
      step(ZOOM_STEP)
      return
    case '-':
    case '_':
      claimed()
      step(1 / ZOOM_STEP)
      return
    case ' ':
      // Held space is the pan modifier everywhere else it exists; here drag
      // already pans, so all it has to do is say so — and not scroll the page
      // out from under the scene while it is being said.
      claimed()
      setGrabReady(true)
      return
    default:
      return
  }
}
