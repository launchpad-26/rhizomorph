import { useEffect, useRef } from 'react'
import { needsYouLaneIds, useSelection } from '../fleet/selection.js'
import { useFleet } from '../fleet/FleetContext.js'

/**
 * THE PAGE'S GLOBAL KEYS (prd5 ruling 1+6) — the idle-worker jump only.
 *
 * The split this file documents, per the direction: `0`, `1`, `+`, `-` are
 * #100's camera keys and are SCENE-SCOPED — they act on the canvas and only
 * make sense while it has the pointer/focus, so they live entirely in
 * `scene/**` and this file never touches them. `n` / `Shift+n` below are
 * GLOBAL — a lane needing you does not care which panel happens to have
 * focus, so this hook listens on `window` regardless of what is on screen.
 * `f` and `a` (the fleet table's own k9s-style verbs) are a third register,
 * TABLE-SCOPED to a focused/selected row — those live in
 * `panels/fleet/index.tsx`, not here, because they need a lane in hand
 * before either does anything.
 */

/** How long the "all clear" flash on the attention strip region lasts. */
export const ALL_CLEAR_FLASH_MS = 220

/**
 * The standard typing guard: a key bound to the page must not fire while an
 * operator is typing into a field the keystroke belongs to instead.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * Nothing needs you: a brief, layout-stable flash on the attention strip's
 * own DOM region rather than a new piece of state. `panels/attention/**` is
 * #103's fence, so this reaches it the same way any outside code would —
 * through the region it already marks with `data-panel="attention"` — and
 * never renders anything of its own there.
 */
function flashAllClear(): void {
  const el = document.querySelector('[data-panel="attention"]')
  if (!(el instanceof HTMLElement)) return
  el.style.transition = `background-color ${ALL_CLEAR_FLASH_MS}ms ease-out`
  el.style.backgroundColor = 'rgba(255, 255, 255, 0.08)'
  window.setTimeout(() => {
    el.style.backgroundColor = ''
  }, ALL_CLEAR_FLASH_MS)
}

/**
 * The idle-worker jump (SC2 steal #1): `n` cycles the shared selection to
 * the next lane that needs a human, worst rung then oldest first —
 * `needsYouLaneIds` reads that order straight off the ladder. `Shift+n`
 * walks backwards. Jumping calls the very `select`/`jump` every other
 * surface calls, so it opens the drawer, spotlights the scene and
 * highlights the table row exactly as a click would (ruling 1: "no new
 * state"). When there is nowhere to jump, the selection is left alone and
 * the attention strip flashes instead of nothing visibly happening at all.
 */
export function useIdleWorkerJump(): void {
  const fleet = useFleet()
  const { jump } = useSelection()
  const fleetRef = useRef(fleet)
  fleetRef.current = fleet

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key.toLowerCase() !== 'n') return

      event.preventDefault()
      const direction = event.shiftKey ? -1 : 1
      const moved = jump(needsYouLaneIds(fleetRef.current), direction)
      if (!moved) flashAllClear()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [jump])
}
