import type { DirtyFile } from '@rhizomorph/core'

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
  /**
   * True once the detached-main-HEAD gap has been voiced via `collector.error`.
   * Resets to false the moment the main worktree has a branch again, so a
   * later detach re-voices rather than staying silent forever.
   */
  mainBranchGapVoiced: boolean
  worktrees: Record<string, GitWorktreeState>
  branches: Record<string, GitBranchState>
  dirty: Record<string, DirtyFile[]>
  /**
   * Consecutive `git status --porcelain` failures per worktree path, for a
   * worktree git's own `worktree list --porcelain` does not (yet) consider
   * `prunable`. Bounds how long a stale `dirty` entry may be carried before
   * the gap becomes a voiced `collector.error` instead of a silent
   * carry-forward. Absent or reset to 0 on the next successful read; never
   * grows once a worktree is dropped as prunable (it stops being polled at
   * all).
   */
  dirtyFailures: Record<string, number>
  /**
   * Consecutive `git for-each-ref` failures — the collector-wide sibling of
   * `dirtyFailures`. One counter, not a per-path record: a single
   * `for-each-ref` call reads every branch at once, so there is exactly one
   * entity to key it against (#429's for-each-ref fix — the exact #415
   * threshold-and-latch pattern, applied to the one call site it was missing
   * from).
   */
  refsFailures: number
}
