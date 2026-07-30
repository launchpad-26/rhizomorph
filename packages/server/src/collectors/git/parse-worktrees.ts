/** Pure parser for `git worktree list --porcelain` output. */

export interface ParsedWorktree {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  locked: boolean
  lockedReason?: string
  prunable: boolean
  prunableReason?: string
}

/**
 * Records are blank-line separated; the first record is always the main
 * worktree (the one that owns `.git` rather than `.git/worktrees/<id>`).
 */
export function parseWorktreeList(output: string): ParsedWorktree[] {
  return output
    .split(/\r?\n\r?\n/)
    .map((record) => record.trim())
    .filter(Boolean)
    .map(parseRecord)
}

function parseRecord(record: string): ParsedWorktree {
  const worktree: ParsedWorktree = {
    path: '',
    head: null,
    branch: null,
    detached: false,
    locked: false,
    prunable: false,
  }

  for (const line of record.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      worktree.path = line.slice('worktree '.length)
    } else if (line.startsWith('HEAD ')) {
      worktree.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      worktree.branch = shortenRef(line.slice('branch '.length))
    } else if (line === 'detached') {
      worktree.detached = true
    } else if (line === 'locked' || line.startsWith('locked ')) {
      worktree.locked = true
      const reason = line.slice('locked'.length).trim()
      if (reason) worktree.lockedReason = reason
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      worktree.prunable = true
      const reason = line.slice('prunable'.length).trim()
      if (reason) worktree.prunableReason = reason
    }
  }

  return worktree
}

function shortenRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}
