import type { SessionState } from '../state.js'

/**
 * "Which branch has its hands on which file" — the shared substrate under both
 * the collision matrix and the worktree table's files-touched column.
 *
 * Two sources of a touch, and the early one is the point:
 * - `worktree.dirty` — uncommitted work, visible *before* a commit exists;
 * - `commit.landed` — but only for commits not already on main, which is what
 *   makes this "vs main" rather than "the whole history".
 */

export interface MainBranchOption {
  /** Override the branch everything is measured against. */
  mainBranch?: string | null
}

export interface BranchTouch {
  branch: string
  path: string
  /** Touched by uncommitted changes in a worktree on this branch. */
  dirty: boolean
  /** Touched by a commit on this branch that main does not have. */
  committed: boolean
}

/** The branch to measure against: explicit override, else whatever the log said. */
export function selectMainBranch(
  state: SessionState,
  options: MainBranchOption = {},
): string | null {
  return options.mainBranch !== undefined ? options.mainBranch : state.mainBranch
}

/** Shas already on main — the ones that no longer count as anyone's work. */
export function selectMainShas(state: SessionState, options: MainBranchOption = {}): Set<string> {
  const main = selectMainBranch(state, options)
  if (main === null) return new Set()
  return new Set(state.branches[main]?.commits ?? [])
}

/** Touches grouped by branch, each file listed once with its reasons merged. */
export function selectTouchesByBranch(
  state: SessionState,
  options: MainBranchOption = {},
): Record<string, BranchTouch[]> {
  const main = selectMainBranch(state, options)
  const mainShas = selectMainShas(state, options)
  const byBranch = new Map<string, Map<string, BranchTouch>>()

  const touch = (branch: string, path: string, kind: 'dirty' | 'committed') => {
    let files = byBranch.get(branch)
    if (files === undefined) {
      files = new Map()
      byBranch.set(branch, files)
    }
    const existing = files.get(path)
    if (existing === undefined) {
      files.set(path, { branch, path, dirty: kind === 'dirty', committed: kind === 'committed' })
    } else if (kind === 'dirty') {
      existing.dirty = true
    } else {
      existing.committed = true
    }
  }

  // Uncommitted work in every worktree that still exists — including main's own.
  for (const worktree of Object.values(state.worktrees)) {
    if (!worktree.present || worktree.branch === null) continue
    for (const file of worktree.dirtyFiles) touch(worktree.branch, file.path, 'dirty')
  }

  // Committed work that main has not absorbed yet.
  for (const branch of Object.values(state.branches)) {
    if (branch.name === main) continue
    for (const sha of branch.commits) {
      if (mainShas.has(sha)) continue
      const commit = state.commits.bySha[sha]
      if (commit === undefined) continue
      for (const file of commit.files) touch(branch.name, file.path, 'committed')
    }
  }

  const result: Record<string, BranchTouch[]> = {}
  for (const [branch, files] of byBranch) {
    result[branch] = [...files.values()].sort((a, b) => compareStrings(a.path, b.path))
  }
  return result
}

/** Distinct file paths a branch has its hands on. */
export function selectFilesTouchedByBranch(
  state: SessionState,
  branch: string,
  options: MainBranchOption = {},
): string[] {
  return (selectTouchesByBranch(state, options)[branch] ?? []).map((touch) => touch.path)
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
