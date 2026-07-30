import type { DirtyFile, FileStatus } from '@observatory/core'

/** Pure parser for `git status --porcelain` (v1 format) output. */

export function parseStatusPorcelain(output: string): DirtyFile[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseStatusLine)
}

function parseStatusLine(line: string): DirtyFile {
  const indexStatus = line[0] ?? ' '
  const worktreeStatus = line[1] ?? ' '
  const rest = line.slice(3)

  if (indexStatus === '?' && worktreeStatus === '?') {
    return { path: rest, status: 'untracked', staged: false }
  }

  // dirtyFileSchema has no previousPath field, so a rename's "old -> new"
  // collapses to just the new path — collision checks only need "what's
  // touched now", not where it came from.
  let path = rest
  const renameArrow = rest.indexOf(' -> ')
  if (renameArrow !== -1) {
    path = rest.slice(renameArrow + ' -> '.length)
  }

  return {
    path,
    status: resolveStatus(indexStatus, worktreeStatus),
    staged: indexStatus !== ' ' && indexStatus !== '?',
  }
}

/**
 * Porcelain v1 gives two columns (index, worktree). We collapse them to one
 * status, preferring whichever column actually changed in the worktree since
 * that's what's on disk right now; unmerged paths always win.
 */
function resolveStatus(indexStatus: string, worktreeStatus: string): FileStatus {
  const isUnmerged =
    indexStatus === 'U' ||
    worktreeStatus === 'U' ||
    (indexStatus === 'A' && worktreeStatus === 'A') ||
    (indexStatus === 'D' && worktreeStatus === 'D')
  if (isUnmerged) return 'unmerged'
  if (indexStatus === 'R' || worktreeStatus === 'R') return 'renamed'
  if (indexStatus === 'C' || worktreeStatus === 'C') return 'copied'

  const primary = worktreeStatus !== ' ' ? worktreeStatus : indexStatus
  switch (primary) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'T':
      return 'typechange'
    default:
      return 'modified'
  }
}
