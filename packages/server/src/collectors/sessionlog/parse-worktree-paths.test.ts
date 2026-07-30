import { describe, expect, it } from 'vitest'
import { parseWorktreePaths } from './parse-worktree-paths.js'

describe('parseWorktreePaths', () => {
  it('extracts every worktree path from --porcelain output', () => {
    const output = [
      'worktree /home/operator/worktrees-challenge',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/operator/worktrees-challenge__worktrees/2-core',
      'HEAD def456',
      'branch refs/heads/2-core',
      '',
    ].join('\n')

    expect(parseWorktreePaths(output)).toEqual([
      '/home/operator/worktrees-challenge',
      '/home/operator/worktrees-challenge__worktrees/2-core',
    ])
  })

  it('handles a detached worktree record (no branch line)', () => {
    const output = ['worktree /repo', 'HEAD abc123', 'detached', ''].join('\n')
    expect(parseWorktreePaths(output)).toEqual(['/repo'])
  })

  it('returns an empty list for empty output', () => {
    expect(parseWorktreePaths('')).toEqual([])
  })
})
