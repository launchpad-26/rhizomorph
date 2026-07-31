import type { DirtyFile } from '@observatory/core'

/** Internal snapshot shape for the git collector — opaque to the poll loop. */

export interface GitWorktreeState {
  path: string
  branch: string | null
  head: string | null
  isMain: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
}

export interface GitBranchState {
  head: string
  aheadOfMain: number | null
  behindMain: number | null
}

export interface GitSnapshot {
  /** Set once `git worktree list` fails (e.g. not a git directory). Every later poll is a no-op. */
  disabled: boolean
  /** Branch of the main worktree, or null when it's detached. */
  mainBranch: string | null
  worktrees: Record<string, GitWorktreeState>
  branches: Record<string, GitBranchState>
  dirty: Record<string, DirtyFile[]>
}
