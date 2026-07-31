import { useCallback, useState } from 'react'

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
 * (`fleet`, `ledger`, `collisions`, `feed`). The attention and burn strips are
 * deliberately absent — ruling 5 makes the strip always-present, so it has no
 * collapse state to persist, and neither has the burn strip docked with it.
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
