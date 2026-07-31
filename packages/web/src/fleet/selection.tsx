import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

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
}

const NO_SELECTION: SelectionValue = {
  selectedId: null,
  select: () => {},
  toggle: () => {},
  clear: () => {},
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const value = useMemo<SelectionValue>(
    () => ({ selectedId, select, toggle, clear }),
    [selectedId, select, toggle, clear],
  )

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

export function useSelection(): SelectionValue {
  return useContext(SelectionContext)
}
