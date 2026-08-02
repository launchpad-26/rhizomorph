import { useCallback, useEffect, useRef, useState } from 'react'
import { useSelection } from '../fleet/index.js'

const STORAGE_KEY = 'rhizomorph.panelCollapsed.v1'

/**
 * Deliberate product ruling (prd1 UI section, unchanged by prd3): collisions
 * must default to expanded, not collapsed — collision warnings are the day's
 * own failure mode, made visible before merge pain, and must not be hideable by
 * default. Every other panel also defaults expanded (see the `?? false`
 * fallback below); this entry exists so the ruling survives a panel-density
 * pass instead of being silently flipped.
 *
 * prd3 note: the ids here are the *panel* ids registered in `PanelGrid`
 * (`fleet`, `ledger`, `collisions`, `feed`, and — since prd4 ruling 2 —
 * `scene`, whose own collapse toggle in `SceneSlot` was reconciled onto this
 * same store rather than keeping its own unpersisted state). The attention
 * and burn strips are deliberately absent — ruling 5 makes the strip
 * always-present, so it has no collapse state to persist, and neither has the
 * burn strip docked with it.
 */
const DEFAULT_COLLAPSED: Readonly<Record<string, boolean>> = {
  collisions: false,
}

export function isPanelCollapsed(id: string): boolean {
  const stored = readAt(STORAGE_KEY)[id]
  return typeof stored === 'boolean' ? stored : (DEFAULT_COLLAPSED[id] ?? false)
}

export function setPanelCollapsed(id: string, collapsed: boolean): void {
  writeAt(STORAGE_KEY, { ...readAt(STORAGE_KEY), [id]: collapsed })
}

/** Collapse state for one panel, persisted to localStorage under a shared key. */
export function usePanelCollapsed(id: string): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  return usePersistedFlag(STORAGE_KEY, id, DEFAULT_COLLAPSED[id] ?? false)
}

// ── the scene's own prefs ────────────────────────────────────────────────────

const SCENE_KEY = 'rhizomorph.scenePrefs.v1'

/** The scene's persisted booleans. One key, so a new one is one line here. */
export type ScenePref = 'hideFinished'

/**
 * **Scars are visible by default** (prd5 ruling 3), and this is where that
 * default lives.
 *
 * A retired lane leaves a mark near the rim rather than disappearing, because
 * invisible completion is indistinguishable from a render bug — the operator
 * cannot tell "that lane landed" from "the scene stopped drawing it". Hiding them
 * is therefore an operator's *choice*, made once and remembered, and never the
 * shipped reading. Hidden is also not gone: the fleet table and replay carry every
 * scarred lane exactly as they always did, and a cut in progress is shown either
 * way — see `scene/retire.ts`.
 *
 * Deliberately a separate store from the panel-collapse one above: a scar is not
 * a panel, and a key called `panelCollapsed` holding a scene preference is the
 * kind of small lie that makes the next person delete the wrong thing.
 */
const SCENE_DEFAULTS: Readonly<Record<ScenePref, boolean>> = {
  hideFinished: false,
}

export function isScenePref(pref: ScenePref): boolean {
  const stored = readAt(SCENE_KEY)[pref]
  return typeof stored === 'boolean' ? stored : SCENE_DEFAULTS[pref]
}

export function setScenePref(pref: ScenePref, value: boolean): void {
  writeAt(SCENE_KEY, { ...readAt(SCENE_KEY), [pref]: value })
}

/** One scene preference, persisted. Same mechanism as the panel prefs above. */
export function useScenePref(
  pref: ScenePref,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  return usePersistedFlag(SCENE_KEY, pref, SCENE_DEFAULTS[pref])
}

// ── the shared mechanism ────────────────────────────────────────────────────

function readAt(key: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeAt(key: string, store: Record<string, boolean>): void {
  try {
    localStorage.setItem(key, JSON.stringify(store))
  } catch {
    // Storage unavailable or full — the preference just won't persist this session.
  }
}

/**
 * A boolean in one of the stores above, as React state that writes through.
 *
 * The initial read is lazy so a component that never mounts never touches
 * storage, and the write happens inside the updater so a functional set (the
 * toggle case) persists the value it actually resolved to rather than the one the
 * caller last rendered with.
 */
function usePersistedFlag(
  key: string,
  field: string,
  fallback: boolean,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState(() => {
    const stored = readAt(key)[field]
    return typeof stored === 'boolean' ? stored : fallback
  })

  const set = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next
        writeAt(key, { ...readAt(key), [field]: resolved })
        return resolved
      })
    },
    [key, field],
  )

  return [value, set]
}

/**
 * Esc's precedence (ruling 6): a lane drawer/selection open consumes the
 * keystroke first (that's `SelectionProvider`'s own global handler, already
 * live for #84), and focus only gives way once nothing is selected. Pulled
 * out as a pure predicate so the rule is a fact one `it()` can pin without
 * mounting anything, and so `usePanelFocus` below has one place to call
 * rather than a condition inlined in a keydown handler.
 */
export function escapeShouldExitFocus(selectedId: string | null): boolean {
  return selectedId === null
}

export interface PanelFocusHandle {
  /** True for the one panel currently filling the view — never more than one. */
  focused: boolean
  focus: () => void
  /** Also reachable via Esc, deferring to an open drawer/selection first. */
  restore: () => void
}

/**
 * Focus state for one panel (ruling 6). Deliberately *not* routed through
 * `usePanelCollapsed`'s localStorage store — a reload must land back on the
 * curated order, never mid-focus.
 *
 * Self-contained rather than context-based: a bare `<PanelFrame>` in its own
 * unit test manages its own focus with no provider to wire up, while
 * `PanelGrid` (or any other coordinator) can still learn about the change
 * via `onChange` and use it to keep every sibling out of the way — the one
 * panel at a time invariant lives one level up, in whoever renders more than
 * one of these.
 */
export function usePanelFocus(onChange?: (focused: boolean) => void): PanelFocusHandle {
  const [focused, setFocused] = useState(false)
  const { selectedId } = useSelection()
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const focus = useCallback(() => {
    setFocused(true)
    onChangeRef.current?.(true)
  }, [])

  const restore = useCallback(() => {
    setFocused(false)
    onChangeRef.current?.(false)
  }, [])

  useEffect(() => {
    if (!focused) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (!escapeShouldExitFocus(selectedIdRef.current)) return
      restore()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focused, restore])

  return { focused, focus, restore }
}
