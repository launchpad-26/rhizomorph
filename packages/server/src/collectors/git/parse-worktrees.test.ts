import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseWorktreeList } from './parse-worktrees.js'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/worktree-list/${name}`, import.meta.url), 'utf8')
}

describe('parseWorktreeList', () => {
  it('parses a mix of branch, detached and locked worktrees', () => {
    const worktrees = parseWorktreeList(fixture('all.txt'))

    expect(worktrees).toEqual([
      {
        path: '/home/dev/rhizomorph-demo',
        head: 'd129e8d9ede5050302a93cd9d66ccadad0f2713d',
        branch: 'main',
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/home/dev/rhizomorph-demo-worktrees/alpha',
        head: '6e164406fdc3e92168183601862506dbce13cec4',
        branch: 'feature/alpha',
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/home/dev/rhizomorph-demo-worktrees/beta',
        head: 'd129e8d9ede5050302a93cd9d66ccadad0f2713d',
        branch: 'feature/beta',
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/home/dev/rhizomorph-demo-worktrees/detached',
        head: 'd129e8d9ede5050302a93cd9d66ccadad0f2713d',
        branch: null,
        detached: true,
        locked: false,
        prunable: false,
      },
      {
        path: '/home/dev/rhizomorph-demo-worktrees/locked',
        head: 'd129e8d9ede5050302a93cd9d66ccadad0f2713d',
        branch: 'feature/locked',
        detached: false,
        locked: true,
        lockedReason: 'in use by agent',
        prunable: false,
      },
    ])
  })

  it('the main worktree is always the first record, per git', () => {
    const [main] = parseWorktreeList(fixture('all.txt'))
    expect(main?.path).toBe('/home/dev/rhizomorph-demo')
    expect(main?.branch).toBe('main')
  })

  it('handles the no-extra-worktrees case (only the main worktree)', () => {
    const worktrees = parseWorktreeList(fixture('single.txt'))
    expect(worktrees).toEqual([
      {
        path: '/home/dev/rhizomorph-demo',
        head: 'd129e8d9ede5050302a93cd9d66ccadad0f2713d',
        branch: 'main',
        detached: false,
        locked: false,
        prunable: false,
      },
    ])
  })

  it('returns an empty array for empty output', () => {
    expect(parseWorktreeList('')).toEqual([])
  })
})
