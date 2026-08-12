import type { DirtyFile } from '../events/index.js'
import type { AgentState, PaneState, SessionState, WorktreeState } from '../state.js'
import { type AheadOptions, aheadOfMain } from './branches.js'
import { compareStrings, selectTouchesByBranch } from './touches.js'

/** The worktree table: one row per station, everything it needs already joined. */

export interface WorktreeViewOptions extends AheadOptions {
  /** Keep worktrees that have been removed. Off by default. */
  includeRemoved?: boolean
}

export interface WorktreeView {
  path: string
  name: string
  branch: string | null
  head: string | null
  isMain: boolean
  detached: boolean
  present: boolean
  discoveredAt: number
  removedAt: number | null
  dirtyFiles: DirtyFile[]
  dirtyCount: number
  /** Distinct files this worktree's branch has touched vs main, sorted. */
  filesTouched: string[]
  aheadOfMain: number
  panes: PaneState[]
  agent: AgentState | null
  /** Latest sign of life across its open panes; null when none are mapped. */
  lastActivityTs: number | null
}

export function selectWorktreeViews(
  state: SessionState,
  options: WorktreeViewOptions = {},
): WorktreeView[] {
  const touches = selectTouchesByBranch(state, options)
  const panesByWorktree = groupPanesByWorktree(state)

  return Object.values(state.worktrees)
    .filter((worktree) => options.includeRemoved === true || worktree.present)
    .map((worktree) => {
      const branchState = worktree.branch === null ? undefined : state.branches[worktree.branch]
      const panes = panesByWorktree.get(worktree.path) ?? []
      const openPanes = panes.filter((pane) => pane.present)
      const lastActivityTs = openPanes.reduce<number | null>(
        (latest, pane) => (latest === null ? pane.lastActivityTs : Math.max(latest, pane.lastActivityTs)),
        null,
      )

      return {
        path: worktree.path,
        name: worktree.name,
        branch: worktree.branch,
        head: worktree.head,
        isMain: worktree.isMain,
        detached: worktree.detached,
        present: worktree.present,
        discoveredAt: worktree.discoveredAt,
        removedAt: worktree.removedAt,
        dirtyFiles: worktree.dirtyFiles,
        dirtyCount: worktree.dirtyFiles.length,
        filesTouched:
          worktree.branch === null
            ? []
            : (touches[worktree.branch] ?? []).map((touch) => touch.path),
        aheadOfMain:
          branchState === undefined ? 0 : aheadOfMain(state, branchState, options),
        panes,
        agent: findAgent(state, worktree),
        lastActivityTs,
      }
    })
    .sort(
      (a, b) =>
        Number(b.isMain) - Number(a.isMain) ||
        Number(b.present) - Number(a.present) ||
        compareStrings(a.name, b.name) ||
        compareStrings(a.path, b.path),
    )
}

/** Path → row. The index every other panel joins against. */
export function selectWorktreeIndex(
  state: SessionState,
  options: WorktreeViewOptions = {},
): Record<string, WorktreeView> {
  const index: Record<string, WorktreeView> = {}
  for (const view of selectWorktreeViews(state, options)) index[view.path] = view
  return index
}

export function selectWorktree(
  state: SessionState,
  path: string,
  options: WorktreeViewOptions = {},
): WorktreeView | null {
  return selectWorktreeIndex(state, { ...options, includeRemoved: true })[path] ?? null
}

function groupPanesByWorktree(state: SessionState): Map<string, PaneState[]> {
  const grouped = new Map<string, PaneState[]>()
  for (const pane of Object.values(state.panes)) {
    if (pane.worktreePath === null) continue
    const panes = grouped.get(pane.worktreePath) ?? []
    panes.push(pane)
    grouped.set(pane.worktreePath, panes)
  }
  for (const panes of grouped.values()) {
    panes.sort((a, b) => compareStrings(a.paneId, b.paneId))
  }
  return grouped
}

/**
 * workmux names agents after the thing they are working on, so match on path
 * first, then branch, then the worktree's own name.
 */
function findAgent(state: SessionState, worktree: WorktreeState): AgentState | null {
  const agents = Object.values(state.agents).filter((agent) => agent.present)
  return (
    agents.find((agent) => agent.worktreePath === worktree.path) ??
    agents.find((agent) => worktree.branch !== null && agent.branch === worktree.branch) ??
    agents.find((agent) => agent.handle === worktree.name) ??
    null
  )
}
