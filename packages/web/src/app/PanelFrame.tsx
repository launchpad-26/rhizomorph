import type { ReactNode } from 'react'
import { usePanelCollapsed, usePanelFocus } from './panelPrefs.js'

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
export function PanelFrame({ id, title, children, hidden = false, onFocusChange }: PanelFrameProps) {
  const [collapsed, setCollapsed] = usePanelCollapsed(id)
  const { focused, focus, restore } = usePanelFocus(onFocusChange)
  const contentId = `panel-frame-${id}-content`

  if (hidden) return null

  const showContent = focused || !collapsed

  return (
    <div
      className={
        focused
          ? 'fixed inset-0 z-30 flex flex-col overflow-auto bg-ice-1000 p-4'
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
            onClick={() => setCollapsed((value) => !value)}
            className="rounded border border-void-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400 hover:border-neon-cyan hover:text-neon-cyan focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan"
          >
            {collapsed ? `Expand ${title}` : `Collapse ${title}`}
          </button>
        )}
        <button
          type="button"
          aria-pressed={focused}
          onClick={focused ? restore : focus}
          className="rounded border border-void-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400 hover:border-neon-cyan hover:text-neon-cyan focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan"
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
