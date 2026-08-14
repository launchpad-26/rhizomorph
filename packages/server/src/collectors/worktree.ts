import type { Exec } from '@rhizomorph/core'

/**
 * Resolves the git worktree root that contains `path`, via
 * `git rev-parse --show-toplevel` run with `path` as cwd. Shared by the
 * tmux collector (called with a pane's `pane_current_path`) and the
 * workmux collector (called with a status row's `workdir`) — neither
 * reads the other's snapshot; they independently resolve the same kind
 * of fact from their own path.
 */
export async function resolveWorktreePath(path: string, exec: Exec): Promise<string | null> {
  const result = await exec('git', ['-C', path, 'rev-parse', '--show-toplevel'])
  if (result.failed) return null
  const toplevel = result.stdout.trim()
  return toplevel.length > 0 ? toplevel : null
}
