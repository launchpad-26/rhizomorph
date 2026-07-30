import type { ReactNode } from 'react'
import { usePanelCollapsed } from './panelPrefs.js'

export interface PanelFrameProps {
  /** Storage key and aria id root — stable per panel, e.g. `worktrees`. */
  id: string
  /** Shown in the frame's own header strip and in the toggle's accessible name. */
  title: string
  children: ReactNode
}

/**
 * Grid-level collapse/expand chrome shared by every panel (prd1: "All panels
 * collapsible (persisted)"). Wraps a panel without touching its internals —
 * collapsing just stops rendering `children`, so the wrapped panel keeps
 * owning its own header, empty states, and styling.
 */
export function PanelFrame({ id, title, children }: PanelFrameProps) {
  const [collapsed, setCollapsed] = usePanelCollapsed(id)
  const contentId = `panel-frame-${id}-content`

  return (
    <div className={collapsed ? 'flex flex-col self-start' : 'flex h-full flex-col'}>
      <div className="mb-1 flex justify-end px-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={() => setCollapsed((value) => !value)}
          className="rounded border border-void-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400 hover:border-neon-cyan hover:text-neon-cyan focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan"
        >
          {collapsed ? `Expand ${title}` : `Collapse ${title}`}
        </button>
      </div>
      {!collapsed && (
        <div id={contentId} className="min-h-0 flex-1">
          {children}
        </div>
      )}
    </div>
  )
}
