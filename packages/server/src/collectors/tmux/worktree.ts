import type { Exec } from '@observatory/core'

/**
 * Maps a pane's `pane_current_path` to the worktree that contains it, via
 * `git rev-parse --show-toplevel` run with that path as cwd. Self-contained —
 * the tmux collector never reads another collector's snapshot.
 */
export async function resolveWorktreePath(path: string, exec: Exec): Promise<string | null> {
  const result = await exec('git', ['-C', path, 'rev-parse', '--show-toplevel'])
  if (result.failed) return null
  const toplevel = result.stdout.trim()
  return toplevel.length > 0 ? toplevel : null
}
