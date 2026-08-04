import type { Exec } from '@rhizomorph/core'

/**
 * prd11 ruling 6b, phase 1 — the judge organ's own read of which branches are
 * live lanes right now. Deliberately NOT shared with the git collector
 * (`packages/server/src/collectors/git/`): the spike's independence
 * requirement (research §3 — "independence is the active ingredient") says
 * the structural judge organ must stay a separately-computed signal from the
 * file-collision organ, so it runs its own read-only `git worktree list
 * --porcelain` rather than importing the other collector's internals or
 * reading its folded state.
 */

export interface Lane {
  branch: string
  head: string
  worktreePath: string
}

export interface LaneDiscovery {
  mainBranch: string | null
  /** Every non-main worktree with a real (non-detached) branch — a "lane" the judge can compare. */
  lanes: Lane[]
}

/** `git worktree list --porcelain` is blocks of `key value` lines separated by a blank line, first block always the main worktree. */
export function parseLanes(porcelain: string): LaneDiscovery {
  const blocks = porcelain
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0)

  let mainBranch: string | null = null
  const lanes: Lane[] = []

  blocks.forEach((block, index) => {
    const lines = block.split('\n')
    const worktreeLine = lines.find((line) => line.startsWith('worktree '))
    const headLine = lines.find((line) => line.startsWith('HEAD '))
    const branchLine = lines.find((line) => line.startsWith('branch '))
    if (worktreeLine === undefined || headLine === undefined) return

    const worktreePath = worktreeLine.slice('worktree '.length).trim()
    const head = headLine.slice('HEAD '.length).trim()
    const branch =
      branchLine === undefined ? null : branchLine.slice('branch '.length).replace(/^refs\/heads\//, '').trim()

    if (index === 0) {
      mainBranch = branch
      return
    }
    if (branch === null) return // detached HEAD — not a lane the judge can compare by name

    lanes.push({ branch, head, worktreePath })
  })

  return { mainBranch, lanes }
}

/** Runs the real discovery. Throws on a git failure — the caller decides how to degrade. */
export async function discoverLanes(exec: Exec, repoPath: string): Promise<LaneDiscovery> {
  const result = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath })
  if (result.failed) {
    throw new Error(`git worktree list failed: ${result.errorMessage ?? result.stderr}`)
  }
  return parseLanes(result.stdout)
}
