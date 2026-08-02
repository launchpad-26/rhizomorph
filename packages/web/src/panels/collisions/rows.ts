import {
  compareStrings,
  selectBranches,
  selectCollisionMap,
  selectWorktreeViews,
  type CollisionEntry,
  type SessionState,
} from '@rhizomorph/core'

/**
 * Row ordering for the matrix: collided files first (worst contention first,
 * matching `selectCollisions`), then the rest by how recently their branch
 * was active — built from `selectBranches`/`selectWorktreeViews` since the
 * touch selectors carry no per-file timestamp of their own.
 */

export interface CollisionRow extends CollisionEntry {
  collided: boolean
}

/** Cap so a long session can't grow the panel's DOM without bound; the rest scrolls. */
export const MAX_VISIBLE_ROWS = 50

export function selectCollisionColumns(state: SessionState): string[] {
  return selectBranches(state).map((branch) => branch.name)
}

export function selectCollisionRows(state: SessionState): CollisionRow[] {
  const map = selectCollisionMap(state)
  const branchRecency = buildBranchRecency(state)

  const recencyOf = (entry: CollisionEntry) =>
    entry.branches.reduce((latest, branch) => Math.max(latest, branchRecency.get(branch) ?? 0), 0)

  return Object.values(map)
    .map((entry) => ({ ...entry, collided: entry.branchCount > 1 }))
    .sort(
      (a, b) =>
        Number(b.collided) - Number(a.collided) ||
        b.branchCount - a.branchCount ||
        recencyOf(b) - recencyOf(a) ||
        compareStrings(a.path, b.path),
    )
}

function buildBranchRecency(state: SessionState): Map<string, number> {
  const recency = new Map<string, number>()
  const bump = (branch: string, ts: number | null) => {
    if (ts === null) return
    recency.set(branch, Math.max(recency.get(branch) ?? 0, ts))
  }

  for (const branch of selectBranches(state)) bump(branch.name, branch.updatedAt)
  for (const worktree of selectWorktreeViews(state)) {
    if (worktree.branch !== null) bump(worktree.branch, worktree.lastActivityTs)
  }

  return recency
}
