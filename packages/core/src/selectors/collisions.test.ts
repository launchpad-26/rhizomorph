import { beforeEach, describe, expect, it } from 'vitest'
import { createEventFactory } from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import { initialSessionState } from '../state.js'
import {
  selectCollidingBranches,
  selectCollisionMap,
  selectCollisionPairs,
  selectCollisions,
} from './collisions.js'
import { selectFilesTouchedByBranch, selectMainShas, selectTouchesByBranch } from './touches.js'

const REPO = '/repo/rhizomorph'
const wt = (name: string) => `${REPO}-wt/${name}`

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

/** main worktree on `main`, plus a worktree per named branch. */
function withWorktrees(...branches: string[]) {
  return [
    f.sessionStarted({ mainBranch: 'main' }),
    f.worktreeDiscovered({ path: REPO, branch: 'main', head: 'sha-main-0', isMain: true }),
    ...branches.map((branch) =>
      f.worktreeDiscovered({ path: wt(branch), branch, head: 'sha-main-0', isMain: false }),
    ),
  ]
}

describe('selectTouchesByBranch', () => {
  it('is empty for an empty log', () => {
    expect(selectTouchesByBranch(initialSessionState())).toEqual({})
  })

  it('records uncommitted work — the early warning', () => {
    const state = reduceAll([
      ...withWorktrees('a'),
      f.worktreeDirty({
        path: wt('a'),
        branch: 'a',
        files: [
          { path: 'src/z.ts', status: 'modified' },
          { path: 'src/a.ts', status: 'untracked' },
        ],
      }),
    ])
    expect(selectTouchesByBranch(state)['a']).toEqual([
      { branch: 'a', path: 'src/a.ts', dirty: true, committed: false },
      { branch: 'a', path: 'src/z.ts', dirty: true, committed: false },
    ])
  })

  it('records committed work that main does not have yet', () => {
    const state = reduceAll([
      ...withWorktrees('a'),
      f.commitLanded({
        sha: 'c1',
        branch: 'a',
        files: [{ path: 'src/a.ts', status: 'added' }],
      }),
    ])
    expect(selectTouchesByBranch(state)['a']).toEqual([
      { branch: 'a', path: 'src/a.ts', dirty: false, committed: true },
    ])
  })

  it('merges the two reasons for the same file', () => {
    const state = reduceAll([
      ...withWorktrees('a'),
      f.commitLanded({ sha: 'c1', branch: 'a', files: [{ path: 'src/a.ts', status: 'modified' }] }),
      f.worktreeDirty({ path: wt('a'), branch: 'a', files: [{ path: 'src/a.ts', status: 'modified' }] }),
    ])
    expect(selectTouchesByBranch(state)['a']).toEqual([
      { branch: 'a', path: 'src/a.ts', dirty: true, committed: true },
    ])
  })

  it('drops a commit once main has absorbed it', () => {
    const merged = reduceAll([
      ...withWorktrees('a'),
      f.commitLanded({ sha: 'c1', branch: 'a', files: [{ path: 'src/a.ts', status: 'added' }] }),
      f.commitLanded({ sha: 'c1', branch: 'main', files: [{ path: 'src/a.ts', status: 'added' }] }),
    ])
    expect(selectMainShas(merged)).toEqual(new Set(['c1']))
    expect(selectTouchesByBranch(merged)['a']).toBeUndefined()
  })

  it("never counts main's own commits as work in flight", () => {
    const state = reduceAll([
      ...withWorktrees(),
      f.commitLanded({ sha: 'm1', branch: 'main', files: [{ path: 'src/a.ts', status: 'added' }] }),
    ])
    expect(selectTouchesByBranch(state)).toEqual({})
  })

  it("does count main's uncommitted changes — those really can collide", () => {
    const state = reduceAll([
      ...withWorktrees('a'),
      f.worktreeDirty({ path: REPO, branch: 'main', files: [{ path: 'src/a.ts', status: 'modified' }] }),
    ])
    expect(selectTouchesByBranch(state)['main']).toEqual([
      { branch: 'main', path: 'src/a.ts', dirty: true, committed: false },
    ])
  })

  it('forgets the dirty set of a worktree that has been removed', () => {
    const state = reduceAll([
      ...withWorktrees('a'),
      f.worktreeDirty({ path: wt('a'), branch: 'a', files: [{ path: 'src/a.ts', status: 'modified' }] }),
      f.worktreeRemoved({ path: wt('a') }),
    ])
    expect(selectTouchesByBranch(state)).toEqual({})
  })

  it('counts every observed commit when main is unknown', () => {
    const state = reduceAll([
      f.commitLanded({ sha: 'c1', branch: 'a', files: [{ path: 'src/a.ts', status: 'added' }] }),
    ])
    expect(state.mainBranch).toBeNull()
    expect(selectFilesTouchedByBranch(state, 'a')).toEqual(['src/a.ts'])
  })

  it('honours a main-branch override', () => {
    const state = reduceAll([
      ...withWorktrees('a'),
      f.commitLanded({ sha: 'c1', branch: 'a', files: [{ path: 'src/a.ts', status: 'added' }] }),
    ])
    // Measuring against 'a' itself means 'a' has nothing outstanding.
    expect(selectTouchesByBranch(state, { mainBranch: 'a' })['a']).toBeUndefined()
  })
})

describe('selectCollisionMap / selectCollisions', () => {
  it('lists every touched file but flags only the contended ones', () => {
    const state = reduceAll([
      ...withWorktrees('a', 'b'),
      f.worktreeDirty({
        path: wt('a'),
        branch: 'a',
        files: [{ path: 'shared.ts', status: 'modified' }, { path: 'only-a.ts', status: 'added' }],
      }),
      f.worktreeDirty({ path: wt('b'), branch: 'b', files: [{ path: 'shared.ts', status: 'modified' }] }),
    ])

    const map = selectCollisionMap(state)
    expect(Object.keys(map).sort()).toEqual(['only-a.ts', 'shared.ts'])
    expect(map['only-a.ts']?.branchCount).toBe(1)
    expect(map['shared.ts']).toEqual({
      path: 'shared.ts',
      branches: ['a', 'b'],
      branchCount: 2,
      sources: [
        { branch: 'a', dirty: true, committed: false },
        { branch: 'b', dirty: true, committed: false },
      ],
    })

    expect(selectCollisions(state).map((entry) => entry.path)).toEqual(['shared.ts'])
  })

  it('catches a commit on one branch against uncommitted work on another', () => {
    const state = reduceAll([
      ...withWorktrees('a', 'b'),
      f.commitLanded({ sha: 'c1', branch: 'a', files: [{ path: 'docs/architecture.md', status: 'modified' }] }),
      f.worktreeDirty({
        path: wt('b'),
        branch: 'b',
        files: [{ path: 'docs/architecture.md', status: 'modified' }],
      }),
    ])
    expect(selectCollisions(state)).toEqual([
      {
        path: 'docs/architecture.md',
        branches: ['a', 'b'],
        branchCount: 2,
        sources: [
          { branch: 'a', dirty: false, committed: true },
          { branch: 'b', dirty: true, committed: false },
        ],
      },
    ])
  })

  it('sorts by how contended a file is, then by path', () => {
    const state = reduceAll([
      ...withWorktrees('a', 'b', 'c'),
      f.worktreeDirty({
        path: wt('a'),
        branch: 'a',
        files: [{ path: 'hot.ts', status: 'modified' }, { path: 'warm.ts', status: 'modified' }],
      }),
      f.worktreeDirty({
        path: wt('b'),
        branch: 'b',
        files: [{ path: 'hot.ts', status: 'modified' }, { path: 'warm.ts', status: 'modified' }],
      }),
      f.worktreeDirty({
        path: wt('c'),
        branch: 'c',
        files: [{ path: 'hot.ts', status: 'modified' }, { path: 'also.ts', status: 'modified' }],
      }),
    ])
    expect(selectCollisions(state).map((entry) => [entry.path, entry.branchCount])).toEqual([
      ['hot.ts', 3],
      ['warm.ts', 2],
    ])
  })

  it('does not call one branch a collision with itself', () => {
    const state = reduceAll([
      ...withWorktrees('a'),
      f.commitLanded({ sha: 'c1', branch: 'a', files: [{ path: 'x.ts', status: 'modified' }] }),
      f.worktreeDirty({ path: wt('a'), branch: 'a', files: [{ path: 'x.ts', status: 'modified' }] }),
    ])
    expect(selectCollisions(state)).toEqual([])
    expect(selectCollidingBranches(state)).toEqual([])
  })
})

describe('selectCollisionPairs', () => {
  it('expands a three-way collision into every pair', () => {
    const state = reduceAll([
      ...withWorktrees('a', 'b', 'c'),
      ...['a', 'b', 'c'].map((branch) =>
        f.worktreeDirty({
          path: wt(branch),
          branch,
          files: [{ path: 'hot.ts', status: 'modified' }],
        }),
      ),
    ])
    expect(selectCollisionPairs(state)).toEqual([
      { branches: ['a', 'b'], files: ['hot.ts'] },
      { branches: ['a', 'c'], files: ['hot.ts'] },
      { branches: ['b', 'c'], files: ['hot.ts'] },
    ])
    expect(selectCollidingBranches(state)).toEqual(['a', 'b', 'c'])
  })

  it('ranks the pair arguing over the most files first', () => {
    const state = reduceAll([
      ...withWorktrees('a', 'b', 'c'),
      f.worktreeDirty({
        path: wt('a'),
        branch: 'a',
        files: [{ path: 'one.ts', status: 'modified' }, { path: 'two.ts', status: 'modified' }],
      }),
      f.worktreeDirty({
        path: wt('b'),
        branch: 'b',
        files: [{ path: 'one.ts', status: 'modified' }, { path: 'two.ts', status: 'modified' }],
      }),
      f.worktreeDirty({ path: wt('c'), branch: 'c', files: [{ path: 'one.ts', status: 'modified' }] }),
    ])
    const pairs = selectCollisionPairs(state)
    expect(pairs[0]).toEqual({ branches: ['a', 'b'], files: ['one.ts', 'two.ts'] })
    expect(pairs).toHaveLength(3)
  })
})
