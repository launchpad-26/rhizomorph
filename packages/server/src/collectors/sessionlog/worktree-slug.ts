/**
 * Maps a worktree (or any cwd) path to the directory Claude Code tails
 * sessions under: `~/.claude/projects/<slug>`. Verified against real dirs on
 * this machine — the slug is the path with every `/` and `_` replaced by
 * `-`, e.g. `/home/operator/worktrees-challenge__worktrees/2-core` becomes
 * `-home-operator-worktrees-challenge--worktrees-2-core`.
 */
export function worktreePathToProjectSlug(worktreePath: string): string {
  return worktreePath.replace(/[/_]/g, '-')
}
