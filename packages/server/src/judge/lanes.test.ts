import type { Exec } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { discoverLanes, parseLanes } from './lanes.js'

describe('parseLanes', () => {
  it('reports the first worktree as main and the rest as lanes', () => {
    const porcelain = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/feature-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature-x

worktree /repo-worktrees/feature-y
HEAD 3333333333333333333333333333333333333333
branch refs/heads/feature-y
`
    const { mainBranch, lanes } = parseLanes(porcelain)
    expect(mainBranch).toBe('main')
    expect(lanes).toEqual([
      { branch: 'feature-x', head: '2222222222222222222222222222222222222222', worktreePath: '/repo-worktrees/feature-x' },
      { branch: 'feature-y', head: '3333333333333333333333333333333333333333', worktreePath: '/repo-worktrees/feature-y' },
    ])
  })

  it('excludes a detached worktree from lanes', () => {
    const porcelain = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo-worktrees/detached
HEAD 4444444444444444444444444444444444444444
detached
`
    const { lanes } = parseLanes(porcelain)
    expect(lanes).toEqual([])
  })

  it('reports null mainBranch when the main worktree itself is detached', () => {
    const porcelain = `worktree /repo
HEAD 1111111111111111111111111111111111111111
detached
`
    const { mainBranch } = parseLanes(porcelain)
    expect(mainBranch).toBeNull()
  })

  it('handles a single-worktree repo — no lanes at all', () => {
    const porcelain = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main
`
    const { mainBranch, lanes } = parseLanes(porcelain)
    expect(mainBranch).toBe('main')
    expect(lanes).toEqual([])
  })
})

describe('discoverLanes', () => {
  it('a timed-out git names the timeout instead of an empty tail', async () => {
    // The judge runs under the poll loop's `withTimeout`-bounded exec. A kill
    // supplies neither errorMessage (#306 narrowed that to spawn errors) nor
    // stderr, so the old two-arm `errorMessage ?? stderr` rendered this
    // message as `git worktree list failed: ` — a blank tail on the reason
    // the judge collector then latches into collector.disabled.
    const execTimeout: Exec = async () => ({ stdout: '', stderr: '', code: null, failed: true })
    await expect(discoverLanes(execTimeout, '/repo')).rejects.toThrow(
      'git worktree list failed: killed with no exit code — the exec timeout',
    )
  })
})
