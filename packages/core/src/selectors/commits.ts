import type { CommitRecord, SessionState } from '../state.js'

/** The commit ticker's view of the log. */

/**
 * Newest first. Ordered by *observation*, not author date: several commits
 * seen in one poll share a timestamp, and reversing the observed order keeps
 * that deterministic where a sort by ts would not.
 */
export function selectCommits(state: SessionState): CommitRecord[] {
  const { bySha, order } = state.commits
  const commits: CommitRecord[] = []
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const sha = order[i]
    if (sha === undefined) continue
    const commit = bySha[sha]
    if (commit !== undefined) commits.push(commit)
  }
  return commits
}

export function selectRecentCommits(state: SessionState, limit = 20): CommitRecord[] {
  return selectCommits(state).slice(0, Math.max(0, limit))
}

export function selectCommitsForBranch(state: SessionState, branch: string): CommitRecord[] {
  return selectCommits(state).filter((commit) => commit.branches.includes(branch))
}

export interface DiffStat {
  files: number
  insertions: number
  deletions: number
}

/** Totals for a commit, falling back to summing its files when git was terse. */
export function commitDiffStat(commit: CommitRecord): DiffStat {
  const insertions =
    commit.insertions ?? commit.files.reduce((sum, file) => sum + (file.insertions ?? 0), 0)
  const deletions =
    commit.deletions ?? commit.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  return { files: commit.files.length, insertions, deletions }
}
