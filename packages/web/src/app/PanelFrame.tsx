import type { ReactNode } from 'react'
import { useFocusRequest, usePanelCollapsed, usePanelFocus } from './panelPrefs.js'

export interface PanelFrameProps {
  /** Storage key and aria id root — stable per panel, e.g. `worktrees`. */
  id: string
  /** Shown in the frame's own header strip and in the toggle's accessible name. */
  title: string
  children: ReactNode
  /**
   * True while a *different* panel is focused and this one should get out of
   * the way entirely — ruling 6's "one panel at a time". A bare `<PanelFrame>`
   * with no coordinator (every unit test in this file) has no siblings to
   * yield to, so it defaults to false.
   */
  hidden?: boolean
  /**
   * Told when this panel's own focus state flips, so a coordinator (
   * `PanelGrid`) can track which single id is focused and hide the rest.
   * Optional — a standalone frame manages focus with no listener at all.
   */
  onFocusChange?: (focused: boolean) => void
  /**
   * Controlled collapse (prd9's feed peek): pass this and `onCollapsedChange`
   * together when `children` should stay mounted through a collapse and draw
   * its own compact reading, rather than disappearing the way every
   * uncontrolled panel's does. Omit both for the default behaviour untouched
   * below — the frame owns `usePanelCollapsed(id)` itself and collapsing
   * simply stops rendering `children`.
   */
  collapsed?: boolean
  onCollapsedChange?: (next: boolean) => void
}

/**
 * Grid-level collapse/expand/focus chrome shared by every panel (prd1: "All
 * panels collapsible (persisted)"; prd3 ruling 6 adds focus). Wraps a panel
 * without touching its internals — collapsing or hiding just stops rendering
 * `children`, so the wrapped panel keeps owning its own header, empty states,
 * and styling.
 *
 * Focus and collapse interact without either remembering the other: while
 * focused, content renders regardless of `collapsed` (a collapsed panel that
 * gets focused expands for the duration), but the persisted collapsed value
 * itself is never touched — restoring lands back on whatever it already was,
 * with no round-trip needed.
 */
/**
 * THE GRID'S OWN CONTROLS — one idiom, shared with the scene's (#117).
 *
 * Three things changed and none of them is a new hue:
 *
 * - **it is ice, not cyan.** Cyan is NOTICE in this instrument and means
 *   "something changed; nobody is needed" (law 9a). A collapse button that
 *   borrowed it to get itself noticed was spending a colour the fleet needs, and
 *   spending it on furniture. It is also the exact reason the scene's own
 *   controls are ice and say so in `SceneView` — this is that decision, applied
 *   where it had been missed.
 * - **it has a fold.** A single border and a single fill at one radius is the
 *   shape of a rectangle, not of a control. A top edge one step up the ramp from
 *   the other three reads as a lit lip, which is the cheapest thing in the world
 *   and the difference between a considered shell and a generated one.
 * - **the hover and the press mean something.** The border and the ink come up
 *   together on hover, and the press scales by 3% over 150 ms — the same
 *   `active:scale-[0.97]` the scene's buttons already answer with, so a control
 *   feels the same wherever the hand finds one.
 *
 * The focused state borrows the pause control's emphasis rather than inventing
 * a second vocabulary for "this control is currently changing what you see".
 */
export const CHROME_BUTTON =
  'focus-ring rounded border border-(--line-hair) border-t-(--line-strong) bg-(--surface-panel)/70 px-2 py-0.5 heading tracking-wide text-(--ink-dim) transition-[transform,color,border-color] duration-(--duration-touch) ease-out hover:border-(--ink-dim) hover:text-(--ink-body) active:scale-[0.97]'

export function PanelFrame({
  id,
  title,
  children,
  hidden = false,
  onFocusChange,
  collapsed: collapsedProp,
  onCollapsedChange,
}: PanelFrameProps) {
  const [internalCollapsed, setInternalCollapsed] = usePanelCollapsed(id)
  const { focused, focus, restore } = usePanelFocus(onFocusChange)
  // A panel's own surface may ask for its frame's focus by id rather than
  // growing a second full-view mechanism inside itself — the fleet table's `f`
  // verb is the one caller (prd5 ruling 1+6). Before #562 the table drew its own
  // `fixed inset-0` frame on `f`, so a focused table sat inside a *frame that
  // did not know it was focused*: two headings, two borders, and the grid's own
  // "one panel at a time" invariant blind to it. This is the same channel the
  // retired FOCUS TRACE panel used, with the panel that had no home removed and
  // the ids that do have one kept.
  useFocusRequest(id, focus)
  const contentId = `panel-frame-${id}-content`

  if (hidden) return null

  const controlled = collapsedProp !== undefined
  const collapsed = controlled ? collapsedProp : internalCollapsed
  const toggleCollapsed = () =>
    controlled ? onCollapsedChange?.(!collapsed) : setInternalCollapsed((value) => !value)

  // A controlled panel keeps `children` mounted through a collapse and draws
  // its own compact reading (the feed's peek); every uncontrolled panel keeps
  // the plain rule above — collapsing just stops rendering it.
  const showContent = controlled || focused || !collapsed

  return (
    <div
      className={
        focused
          ? 'fixed inset-0 z-(--z-focus) flex flex-col overflow-auto bg-(--surface-floor) p-4 [scrollbar-gutter:stable]'
          : collapsed
            ? 'flex flex-col self-start'
            : 'flex h-full flex-col'
      }
    >
      <div className="mb-1 flex justify-end gap-2 px-1">
        {!focused && (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={contentId}
            onClick={toggleCollapsed}
            className={CHROME_BUTTON}
          >
            {collapsed ? `Expand ${title}` : `Collapse ${title}`}
          </button>
        )}
        <button
          type="button"
          aria-pressed={focused}
          onClick={focused ? restore : focus}
          className={focused ? `${CHROME_BUTTON} border-(--ink-dim) bg-(--surface-raised) text-(--ink-primary)` : CHROME_BUTTON}
        >
          {focused ? `Restore ${title}` : `Focus ${title}`}
        </button>
      </div>
      {showContent && (
        <div id={contentId} className="min-h-0 flex-1">
          {children}
        </div>
      )}
    </div>
  )
}
