import { useCallback, useEffect, useRef, useState } from 'react'
import { useSelection } from '../fleet/index.js'
import {
  fallbackRecord,
  readFlag,
  readRecordOverlay,
  subscribeToPreferences,
  writePreference,
} from '../settings/registry.js'

/**
 * MIGRATED ONTO THE PREFERENCE REGISTRY (prd-35, #550).
 *
 * This file used to own two `localStorage` keys and the read/write mechanism
 * under them, and it was the whole of prd-35's evidence that the instrument had
 * preferences nobody could see: two keys, no surface, no enumeration. The keys
 * are now declared in `settings/registry.ts` — `appearance.panelsCollapsed`
 * (repo-scoped, ruling 3) and `appearance.hideFinished` (machine) — and every
 * read and write below goes through it, so a preference cannot exist without
 * being surveyed on the settings page.
 *
 * **Nothing an operator had is lost.** The registry keeps the old keys as a
 * declared legacy fallback rather than as a one-shot migration, so a stored
 * `rhizomorph.panelCollapsed.v1` still answers until the first write supersedes
 * it (see `registry.ts`'s `Legacy`).
 *
 * The defaults, and the rulings they carry, stay stated where they always were
 * — one paragraph down — because the registry declares the *fallback* and this
 * file is where the panels themselves are named.
 */
const PANELS_COLLAPSED = 'appearance.panelsCollapsed'
const HIDE_FINISHED = 'appearance.hideFinished'

/**
 * Deliberate product ruling (prd1 UI section, unchanged by prd3): collisions
 * must default to expanded, not collapsed — collision warnings are the day's
 * own failure mode, made visible before merge pain, and must not be hideable by
 * default. Every other panel also defaults expanded (see the `?? false`
 * fallback below); this entry exists so the ruling survives a panel-density
 * pass instead of being silently flipped. Since #550 the two values themselves
 * live in `settings/registry.ts`'s `appearance.panelsCollapsed` fallback (one
 * place for every default, so the settings page can show a person what they
 * have changed *from*), and this paragraph stays here, where the panels are
 * named, because the ruling is about these panels rather than about storage.
 *
 * prd3 note: the ids here are the *panel* ids registered in `PanelGrid`
 * (`fleet`, `ledger`, `collisions`, `feed`, and — since prd4 ruling 2 —
 * `scene`, whose own collapse toggle in `SceneSlot` was reconciled onto this
 * same store rather than keeping its own unpersisted state). The attention
 * and burn strips are deliberately absent — ruling 5 makes the strip
 * always-present, so it has no collapse state to persist, and neither has the
 * burn strip docked with it.
 *
 * prd9 legibility round: `feed` defaults collapsed, the opposite of every
 * other panel's default. It is a stream of history, never the day's own
 * failure mode the way collisions is, so a header-and-latest-line peek costs
 * an operator nothing they need at a glance — and the row it used to take at
 * full height was some of the "crowded" the operator's ruling names. Unlike
 * every other panel here, `feed`'s own collapsed reading isn't just "gone":
 * see `PanelFrame`'s controlled-collapse mode and `panels/feed/index.tsx`'s
 * own peek render.
 */
function defaultCollapsed(id: string): boolean {
  return fallbackRecord(PANELS_COLLAPSED)[id] ?? false
}

export function isPanelCollapsed(id: string): boolean {
  const stored = readRecordOverlay(PANELS_COLLAPSED)[id]
  return typeof stored === 'boolean' ? stored : defaultCollapsed(id)
}

export function setPanelCollapsed(id: string, collapsed: boolean): void {
  writePreference(PANELS_COLLAPSED, { ...readRecordOverlay(PANELS_COLLAPSED), [id]: collapsed })
}

/** Collapse state for one panel, persisted under the registry's repo-scoped `appearance.panelsCollapsed`. */
export function usePanelCollapsed(id: string): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  return usePersistedFlag(
    () => isPanelCollapsed(id),
    (resolved) => setPanelCollapsed(id, resolved),
  )
}

// ── the scene's own prefs ────────────────────────────────────────────────────

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
 * Deliberately a separate key from the panel-collapse one above: a scar is not
 * a panel, and a key called `panelCollapsed` holding a scene preference is the
 * kind of small lie that makes the next person delete the wrong thing. Since
 * #550 they are separate registry entries in different SCOPES as well as under
 * different names — hiding scars is a preference about how you like to read a
 * picture (machine), and which panels you have folded belongs to the repo whose
 * panels they are (ruling 3).
 */
const SCENE_PREF_IDS: Readonly<Record<ScenePref, string>> = { hideFinished: HIDE_FINISHED }

export function isScenePref(pref: ScenePref): boolean {
  return readFlag(SCENE_PREF_IDS[pref])
}

export function setScenePref(pref: ScenePref, value: boolean): void {
  writePreference(SCENE_PREF_IDS[pref], value)
}

/** One scene preference, persisted. Same mechanism as the panel prefs above. */
export function useScenePref(
  pref: ScenePref,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  return usePersistedFlag(
    () => isScenePref(pref),
    (resolved) => setScenePref(pref, resolved),
  )
}

// ── the shared mechanism ────────────────────────────────────────────────────

/**
 * One registry-backed boolean, as React state that writes through.
 *
 * The initial read is lazy so a component that never mounts never touches
 * storage, and the write happens inside the updater so a functional set (the
 * toggle case) persists the value it actually resolved to rather than the one
 * the caller last rendered with.
 *
 * It also SUBSCRIBES now, which it did not need to before: the settings page can
 * restore a group's defaults (prd-35 ruling 4) or the watched repo can be
 * adopted into a different bucket (ruling 3) while a panel is mounted, and a
 * component holding a copy of a value the store has since thrown away would show
 * a person a collapse state nothing persists.
 */
function usePersistedFlag(
  read: () => boolean,
  write: (resolved: boolean) => void,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState(read)
  const readRef = useRef(read)
  readRef.current = read
  const writeRef = useRef(write)
  writeRef.current = write

  useEffect(() => subscribeToPreferences(() => setValue(readRef.current())), [])

  const set = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setValue((previous) => {
      const resolved = typeof next === 'function' ? next(previous) : next
      writeRef.current(resolved)
      return resolved
    })
  }, [])

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
/**
 * FOCUS TRACE's own trigger (prd9 B1a): the drawer's `FOCUS ↗` affordance and
 * the panel it focuses are siblings under `Shell`, not parent/child, so there
 * is no prop path between "the button was clicked" and "this panel's own
 * `usePanelFocus` should flip on". This is that path — a request by panel id,
 * heard by whichever `usePanelFocus` owner is listening for it — rather than
 * a second, competing focus mechanism. Deliberately not persisted (unlike the
 * stores above): a reload must land back on the curated order, same as every
 * other focus, never mid-request.
 */
const focusRequestListeners = new Map<string, Set<() => void>>()

/** Ask whichever panel is listening for `id` to focus itself. */
export function requestPanelFocus(id: string): void {
  for (const listener of focusRequestListeners.get(id) ?? []) listener()
}

/** Hear `requestPanelFocus(id)` calls from elsewhere in the tree. */
export function useFocusRequest(id: string, onRequest: () => void): void {
  const onRequestRef = useRef(onRequest)
  onRequestRef.current = onRequest

  useEffect(() => {
    const listener = () => onRequestRef.current()
    const listeners = focusRequestListeners.get(id) ?? new Set()
    listeners.add(listener)
    focusRequestListeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
    }
  }, [id])
}

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
