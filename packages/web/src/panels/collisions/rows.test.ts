import { createEventFactory, initialSessionState, reduceAll, type RhizomorphEvent } from '@rhizomorph/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { selectCollisionColumns, selectCollisionRows } from './rows.js'

const REPO = '/repo/rhizomorph'
const wt = (name: string) => `${REPO}-wt/${name}`

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

function withWorktrees(...branches: string[]): RhizomorphEvent[] {
  return [
    f.sessionStarted({ mainBranch: 'main' }),
    f.worktreeDiscovered({ path: REPO, branch: 'main', head: 'sha-main-0', isMain: true }),
    ...branches.map((branch) =>
      f.worktreeDiscovered({ path: wt(branch), branch, head: 'sha-main-0', isMain: false }),
    ),
  ]
}

function fold(events: RhizomorphEvent[]) {
  return reduceAll(events, initialSessionState())
}

describe('selectCollisionColumns', () => {
  it('lists every known branch, main included', () => {
    const state = fold(withWorktrees('a', 'b'))
    expect(selectCollisionColumns(state)).toEqual(['main', 'a', 'b'])
  })
})

describe('selectCollisionRows', () => {
  it('puts the collided row first regardless of path order', () => {
    const state = fold([
      ...withWorktrees('a', 'b'),
      f.worktreeDirty({
        path: wt('a'),
        branch: 'a',
        files: [
          { path: 'shared.ts', status: 'modified' },
          { path: 'aaa-only-a.ts', status: 'added' },
        ],
      }),
      f.worktreeDirty({ path: wt('b'), branch: 'b', files: [{ path: 'shared.ts', status: 'modified' }] }),
    ])

    const rows = selectCollisionRows(state)
    expect(rows.map((row) => row.path)).toEqual(['shared.ts', 'aaa-only-a.ts'])
    expect(rows[0]).toMatchObject({ collided: true, branchCount: 2 })
    expect(rows[1]).toMatchObject({ collided: false, branchCount: 1 })
  })

  it('lets a branch with a fresher commit outrank an older one', () => {
    const state = fold([
      ...withWorktrees('a', 'b'),
      f.commitLanded({ sha: 'c-old', branch: 'a', files: [{ path: 'old.ts', status: 'modified' }] }),
      f.commitLanded({ sha: 'c-new', branch: 'b', files: [{ path: 'new.ts', status: 'modified' }] }),
    ])

    expect(selectCollisionRows(state).map((row) => row.path)).toEqual(['new.ts', 'old.ts'])
  })

  it('lets live pane activity outrank a branch only known from discovery', () => {
    // 'b' is discovered second, so its branch record alone would already read
    // newer than 'a' — attach a fresh pane activity signal to 'a' instead, so
    // this actually exercises the pane-activity path rather than coincidence.
    const state = fold([
      ...withWorktrees('b', 'a'),
      f.paneDiscovered({ paneId: '%1', windowName: 'a', currentPath: wt('a'), worktreePath: wt('a') }),
      f.worktreeDirty({ path: wt('a'), branch: 'a', files: [{ path: 'a-file.ts', status: 'modified' }] }),
      f.worktreeDirty({ path: wt('b'), branch: 'b', files: [{ path: 'b-file.ts', status: 'modified' }] }),
      f.paneActivity({ paneId: '%1', contentHash: 'h1' }),
    ])

    expect(selectCollisionRows(state).map((row) => row.path)).toEqual(['a-file.ts', 'b-file.ts'])
  })

  it('is empty for an empty log', () => {
    expect(selectCollisionRows(initialSessionState())).toEqual([])
    expect(selectCollisionColumns(initialSessionState())).toEqual([])
  })
})
