import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Fleet } from '@rhizomorph/core'

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
 *
 * The slot holds one more thing than a lane id: {@link MAIN_SELECTION}, the
 * root-mass. See its own note for why that is a value here rather than a Lane
 * in the fleet.
 */

/**
 * THE ROOT-MASS, SELECTED (prd6 ruling 5) — the one thing on screen that used
 * to be unclickable.
 *
 * It is a **pseudo-lane**: a value this slot can hold, and deliberately *not* a
 * `Lane` in the derived fleet. Fabricating one would have been the shorter
 * diff and the wrong model — main is not a worker. It has no fence, no
 * pathologies, no rung on the ladder, and every panel that walks `fleet.lanes`
 * (the table, the attention strip, the ladder, the scene's threads) would have
 * had to learn to skip it. Keeping it out of that array means they skip it by
 * construction: the fleet table grows no MAIN row because there is no MAIN lane
 * to grow one from, and `selectedId === lane.id` is simply false for every row.
 *
 * The three surfaces that *do* have to know:
 *
 * - **the scene** hit-tests the root-mass and writes this value, and the
 *   contrast budget then spotlights it for free — `salienceOf` takes the
 *   selection as the spotlight, no lane matches, so every lane recedes around a
 *   root-mass that stays at full brightness (`scene/salience.ts`);
 * - **the drawer** branches on {@link isMainSelected} and shows the conductor;
 * - **the feed** narrows to entries attributed to this id, of which there are
 *   none: no feed kind is conductor-attributed today (commits, landings, lane
 *   starts and collector events are all worker or global facts). So the feed
 *   reads "Nothing matches this filter" with its clear button beside it, which
 *   is the honest answer — it says the filter is on and that nothing in *this*
 *   feed belongs to main, rather than quietly dropping the filter and implying
 *   these were the conductor's commits. When a conductor-attributed feed kind
 *   exists, it will land here with no change to this file.
 *
 * The value is `main` because that is what the scene already calls the
 * root-mass and what the transcript route already answers to
 * (`packages/server/src/api/transcript.ts`). A worker lane can never collide
 * with it: `buildFleet` skips the main worktree and books every penny spent on
 * the main branch to the root-mass, so no lane is ever built with this id.
 */
export const MAIN_SELECTION = 'main'

/**
 * True when the selection is a root-mass rather than a worker lane.
 *
 * Reads the selection's colony-local part, so it answers for the bare `main`
 * and for any colony's own mass in a world (prd-52 ruling 1). A world of one
 * colony uses the bare form, so this is unchanged for every existing caller.
 */
export function isMainSelected(selectedId: string | null): boolean {
  return withinColony(selectedId) === MAIN_SELECTION
}

// ── selection in a world of colonies (prd-52 ruling 1) ─────────────────────

/**
 * The separator between a colony's name and what is selected inside it.
 *
 * A colony id comes from whoever composed the world; a lane id is a
 * branch-derived slug, and branch names ordinarily contain `/` — `feat/thing`
 * is nothing unusual. That asymmetry is the whole design: the split takes the
 * **first** separator only, and a colony id may not contain one at all, which
 * {@link colonySelection} refuses rather than silently mis-parsing later.
 */
const COLONY_SEP = '/'

/**
 * Name a selection inside a colony.
 *
 * The bare {@link MAIN_SELECTION} is one hardcoded id for the root-mass, and a
 * world holds one mass per colony — so in a world of more than one colony that
 * id resolves to N different masses. This is the form that does not.
 *
 * A world of one colony keeps the bare form, which is prd-52 ruling 2 applied
 * to identity rather than to geometry: nothing about a solo picture changes,
 * down to the strings its surfaces pass around. That is what lets the eleven
 * consumers of the bare id keep working untouched until #319 moves them
 * together.
 */
export function colonySelection(colonyId: string | null, withinId: string): string {
  if (colonyId === null || colonyId === '') return withinId
  if (colonyId.includes(COLONY_SEP)) {
    throw new Error(`a colony id may not contain "${COLONY_SEP}": ${colonyId}`)
  }
  return `${colonyId}${COLONY_SEP}${withinId}`
}

/** The colony a selection belongs to, or `null` for the bare single-colony form. */
export function colonyOf(selectedId: string | null): string | null {
  if (selectedId === null) return null
  const at = selectedId.indexOf(COLONY_SEP)
  return at === -1 ? null : selectedId.slice(0, at)
}

/**
 * What is selected *inside* its colony — a `Lane.id` or {@link MAIN_SELECTION}.
 *
 * Splits on the **first** separator, never the last: a lane id can contain
 * one, so `alpha/feat/thing` is colony `alpha` and lane `feat/thing`, and
 * splitting on the last would answer `thing`.
 */
export function withinColony(selectedId: string | null): string | null {
  if (selectedId === null) return null
  const at = selectedId.indexOf(COLONY_SEP)
  return at === -1 ? selectedId : selectedId.slice(at + 1)
}

export interface SelectionValue {
  /**
   * The selected lane's `Lane.id`, {@link MAIN_SELECTION} for the root-mass, or
   * null when nothing is selected.
   */
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
  /**
   * The repo the fold currently describes (`app/streamState.ts`'s
   * `foldedRepoPath`). Supplying it makes the selection **repo-scoped**: it
   * drops when the dashboard is retargeted at a different repository, because
   * a lane id belongs to the repo it was selected in (#390 review).
   *
   * Optional because this provider is deliberately mountable on its own — most
   * panel tests render it with no stream in the tree at all — and a selection
   * with no repo behind it is simply never scoped. `App.tsx` is what wires the
   * real one.
   */
  repoPath?: string | null
}

export function SelectionProvider({
  children,
  initialSelectedId = null,
  repoPath,
}: SelectionProviderProps) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)

  // Adjusted during render rather than in an effect, which is React's own
  // pattern for "reset state when a prop changes" and the only version with no
  // wrong frame: an effect would commit one paint in which the NEW repo's
  // fleet wears the OLD repo's spotlight. This codebase has fixed that exact
  // shape of one-frame lie before (prd-19 ruling 6, the provenance bar pairing
  // `source='fleet20'` with a string beginning "live"), so it is not worth
  // reintroducing for a selection.
  const [scopedTo, setScopedTo] = useState<string | null | undefined>(repoPath)
  if (repoPath !== scopedTo) {
    setScopedTo(repoPath)
    // Only a move BETWEEN two named repos drops the selection. Learning the
    // first repo (`undefined`/`null` → a path) is a boot, not a retarget —
    // clearing there would wipe a seed the caller deliberately set, and there
    // is nothing stale to drop anyway.
    if (scopedTo !== null && scopedTo !== undefined && repoPath !== null && repoPath !== undefined) {
      setSelectedId(null)
    }
  }

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
