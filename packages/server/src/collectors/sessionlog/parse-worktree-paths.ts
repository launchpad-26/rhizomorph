/**
 * Pure parser for `git worktree list --porcelain`, trimmed to just the paths
 * — sessionlog only needs to know which directories exist, not their branch
 * or lock state (the git collector owns that fuller parse).
 */
export function parseWorktreePaths(output: string): string[] {
  return output
    .split(/\r?\n\r?\n/)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const worktreeLine = record.split(/\r?\n/).find((line) => line.startsWith('worktree '))
      return worktreeLine ? worktreeLine.slice('worktree '.length) : null
    })
    .filter((path): path is string => path !== null)
}
