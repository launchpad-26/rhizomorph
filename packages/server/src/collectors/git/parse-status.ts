import type { DirtyFile, FileStatus } from '@rhizomorph/core'
import { unquotePath } from './unquote-path.js'

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
    return { path: unquotePath(rest), status: 'untracked', staged: false }
  }

  return {
    path: renameTarget(rest),
    status: resolveStatus(indexStatus, worktreeStatus),
    staged: indexStatus !== ' ' && indexStatus !== '?',
  }
}

// dirtyFileSchema has no previousPath field, so a rename's "old -> new"
// collapses to just the new path — collision checks only need "what's
// touched now", not where it came from. A quoted old path can itself
// contain the literal substring " -> ", so the arrow must be found after a
// whole (possibly quoted) field, not by a bare indexOf.
function renameTarget(rest: string): string {
  const first = consumeField(rest, 0)
  if (rest.slice(first.end, first.end + 4) === ' -> ') {
    return unquotePath(consumeField(rest, first.end + 4).raw)
  }
  return unquotePath(rest)
}

function consumeField(s: string, start: number): { raw: string; end: number } {
  if (s[start] === '"') {
    let i = start + 1
    while (i < s.length) {
      if (s[i] === '\\') {
        i += 2
        continue
      }
      if (s[i] === '"') {
        i += 1
        break
      }
      i += 1
    }
    return { raw: s.slice(start, i), end: i }
  }
  const arrow = s.indexOf(' -> ', start)
  const end = arrow === -1 ? s.length : arrow
  return { raw: s.slice(start, end), end }
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
