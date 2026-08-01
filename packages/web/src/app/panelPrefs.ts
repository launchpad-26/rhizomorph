import { useCallback, useEffect, useRef, useState } from 'react'
import { useSelection } from '../fleet/index.js'

const STORAGE_KEY = 'observatory.panelCollapsed.v1'

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

function readStore(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeStore(store: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Storage unavailable or full — collapse state just won't persist this session.
  }
}

export function isPanelCollapsed(id: string): boolean {
  const stored = readStore()[id]
  return typeof stored === 'boolean' ? stored : (DEFAULT_COLLAPSED[id] ?? false)
}

export function setPanelCollapsed(id: string, collapsed: boolean): void {
  writeStore({ ...readStore(), [id]: collapsed })
}

/** Collapse state for one panel, persisted to localStorage under a shared key. */
export function usePanelCollapsed(id: string): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [collapsed, setCollapsedState] = useState(() => isPanelCollapsed(id))

  const setCollapsed = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setCollapsedState((prev) => {
        const value = typeof next === 'function' ? next(prev) : next
        setPanelCollapsed(id, value)
        return value
      })
    },
    [id],
  )

  return [collapsed, setCollapsed]
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
