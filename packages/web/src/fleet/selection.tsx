import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Fleet } from './buildFleet.js'

/**
 * The one lane selection, shared by every surface that can point at a lane: the
 * attention strip (click-to-jump, ruling 5), the fleet table (row focus), the
 * scene (the spotlight) and the chat drawer (ruling 17).
 *
 * It is one slot rather than four because "selected" is a single fact about the
 * page. Two surfaces each remembering their own selection is how a fleet table
 * ends up highlighting one lane while the scene spotlights another — the exact
 * class of disagreement the single derived fleet object exists to prevent.
 *
 * Esc clears, everywhere, always: the same key that leaves panel focus
 * (ruling 6) also drops the spotlight, so there is one way out of every
 * narrowed view.
 */

export interface SelectionValue {
  /** The selected lane's `Lane.id`, or null when nothing is selected. */
  selectedId: string | null
  select: (laneId: string | null) => void
  /** Select if not selected, clear if already selected — the row-click idiom. */
  toggle: (laneId: string) => void
  clear: () => void
  /**
   * The idle-worker jump (SC2 steal #1, prd5 ruling 1+6): moves the selection
   * to the next id in a caller-supplied worst-first order, wrapping. It calls
   * the same `select` a click does, so a jump opens the drawer, spotlights
   * the scene and highlights the table row exactly as clicking the lane
   * would — one shared selection, no state of its own to fall out of sync.
   * Returns false, and leaves the selection untouched, when `ids` is empty,
   * so the caller (the keyboard layer) can flash "all clear" instead of
   * moving a selection that has nowhere to go.
   */
  jump: (ids: readonly string[], direction: 1 | -1) => boolean
}

const NO_SELECTION: SelectionValue = {
  selectedId: null,
  select: () => {},
  toggle: () => {},
  clear: () => {},
  jump: () => false,
}

/**
 * The idle-worker jump's candidate list (SC2 steal #1): every distinct lane
 * the ladder is already unhappy about, in the ladder's own worst-rung-then-
 * oldest order (`buildFleet.ts`'s `buildLadder` sort — rank desc, then
 * `forMs` desc). A lane carrying two pathologies contributes one id, not two:
 * jumping moves between lanes, not between alarms. Items with no lane at all
 * (a collision, a broken collector) are skipped — there is nowhere to jump.
 */
export function needsYouLaneIds(fleet: Fleet): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const item of fleet.ladder.items) {
    if (item.laneId === null || seen.has(item.laneId)) continue
    seen.add(item.laneId)
    ids.push(item.laneId)
  }
  return ids
}

/**
 * The jump's pure cycle step: given the candidate order and where the
 * selection currently sits, returns the next id, wrapping at either end.
 * A current id absent from `ids` (nothing selected, or the selected lane no
 * longer needs you) is treated the same as "start of the list" — forward
 * lands on the worst lane, backward on the last (oldest-tied) one.
 */
export function nextJumpTarget(
  ids: readonly string[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (ids.length === 0) return null
  const index = currentId === null ? -1 : ids.indexOf(currentId)
  const nextIndex =
    index === -1 ? (direction === 1 ? 0 : ids.length - 1) : (index + direction + ids.length) % ids.length
  return ids[nextIndex] ?? null
}

/**
 * Outside a provider (most panel unit tests) selection is simply inert rather
 * than an exception: a panel that renders without a selection is a legitimate
 * thing to test, and a throw here would make every such test carry a wrapper.
 */
const SelectionContext = createContext<SelectionValue>(NO_SELECTION)

export interface SelectionProviderProps {
  children: ReactNode
  /** Test-only seed, so a selected-state render needs no click to set up. */
  initialSelectedId?: string | null
}

export function SelectionProvider({ children, initialSelectedId = null }: SelectionProviderProps) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)

  const select = useCallback((laneId: string | null) => setSelectedId(laneId), [])
  const clear = useCallback(() => setSelectedId(null), [])
  const toggle = useCallback(
    (laneId: string) => setSelectedId((current) => (current === laneId ? null : laneId)),
    [],
  )
  const jump = useCallback((ids: readonly string[], direction: 1 | -1): boolean => {
    if (ids.length === 0) return false
    setSelectedId((current) => nextJumpTarget(ids, current, direction) ?? current)
    return true
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const value = useMemo<SelectionValue>(
    () => ({ selectedId, select, toggle, clear, jump }),
    [selectedId, select, toggle, clear, jump],
  )

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

export function useSelection(): SelectionValue {
  return useContext(SelectionContext)
}
