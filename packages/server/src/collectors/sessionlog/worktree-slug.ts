/**
 * Maps a worktree (or any cwd) path to the directory Claude Code tails
 * sessions under: `~/.claude/projects/<slug>`. The slug is the path with
 * every `/`, `_` and `.` replaced by `-` — verified against real dirs on
 * this machine, e.g. `/home/operator/worktrees-challenge__worktrees/2-core`
 * becomes `-home-operator-worktrees-challenge--worktrees-2-core`, and a
 * dotted path like `/home/operator/work/v2.0/wt` becomes
 * `-home-operator-work-v2-0-wt` (Claude Code maps `.` the same way it maps
 * `/` and `_`).
 */
export function worktreePathToProjectSlug(worktreePath: string): string {
  return worktreePath.replace(/[/_.]/g, '-')
}
