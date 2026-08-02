import { beforeEach, describe, expect, it } from 'vitest'
import { createEventFactory, fixtureSession } from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import { selectWorktree, selectWorktreeIndex, selectWorktreeViews } from './worktrees.js'

const REPO = '/repo/rhizomorph'
const wt = (name: string) => `${REPO}-wt/${name}`

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

describe('selectWorktreeViews', () => {
  it('joins branch, dirt, panes and agent into one row', () => {
    const state = reduceAll([
      f.sessionStarted({ mainBranch: 'main' }),
      f.worktreeDiscovered({ path: REPO, branch: 'main', head: 'm0', isMain: true }, { ts: 10 }),
      f.worktreeDiscovered({ path: wt('a'), branch: 'a', head: 'm0', isMain: false }, { ts: 20 }),
      f.commitLanded({ sha: 'c1', branch: 'a', files: [{ path: 'src/a.ts', status: 'added' }] }, { ts: 30 }),
      f.branchUpdated({ branch: 'a', head: 'c1', aheadOfMain: 1 }, { ts: 31 }),
      f.worktreeDirty({ path: wt('a'), branch: 'a', files: [{ path: 'src/b.ts', status: 'modified' }] }, { ts: 40 }),
      f.paneDiscovered({ paneId: '%1', windowName: 'a', currentPath: wt('a'), worktreePath: wt('a') }, { ts: 50 }),
      f.paneActivity({ paneId: '%1', contentHash: 'h' }, { ts: 60 }),
      f.agentStatus({ handle: 'a', status: 'working', worktreePath: wt('a') }, { ts: 70 }),
    ])

    const view = selectWorktreeIndex(state)[wt('a')]
    expect(view).toMatchObject({
      path: wt('a'),
      name: 'a',
      branch: 'a',
      head: 'c1',
      isMain: false,
      present: true,
      dirtyCount: 1,
      // Committed vs main plus uncommitted, sorted.
      filesTouched: ['src/a.ts', 'src/b.ts'],
      aheadOfMain: 1,
      lastActivityTs: 60,
    })
    expect(view?.panes.map((pane) => pane.paneId)).toEqual(['%1'])
    expect(view?.agent?.status).toBe('working')
  })

  it('hides removed worktrees unless asked for them', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: REPO, branch: 'main', isMain: true }, { ts: 10 }),
      f.worktreeDiscovered({ path: wt('a'), branch: 'a', isMain: false }, { ts: 20 }),
      f.worktreeRemoved({ path: wt('a') }, { ts: 30 }),
    ])
    expect(selectWorktreeViews(state).map((v) => v.path)).toEqual([REPO])
    expect(selectWorktreeViews(state, { includeRemoved: true }).map((v) => v.path)).toEqual([
      REPO,
      wt('a'),
    ])
    // Direct lookup still finds it — the ticker may need to name a dead station.
    expect(selectWorktree(state, wt('a'))?.present).toBe(false)
    expect(selectWorktree(state, '/nowhere')).toBeNull()
  })

  it('puts the main worktree first, then sorts by name', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: wt('zeta'), branch: 'zeta', isMain: false }, { ts: 10 }),
      f.worktreeDiscovered({ path: wt('alpha'), branch: 'alpha', isMain: false }, { ts: 20 }),
      f.worktreeDiscovered({ path: REPO, branch: 'main', isMain: true }, { ts: 30 }),
    ])
    expect(selectWorktreeViews(state).map((v) => v.name)).toEqual(['rhizomorph', 'alpha', 'zeta'])
  })

  it('counts only open panes as activity', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: wt('a'), branch: 'a', isMain: false }, { ts: 10 }),
      f.paneDiscovered({ paneId: '%1', worktreePath: wt('a') }, { ts: 20 }),
      f.paneActivity({ paneId: '%1', contentHash: 'h' }, { ts: 900 }),
      f.paneClosed({ paneId: '%1' }, { ts: 901 }),
      f.paneDiscovered({ paneId: '%2', worktreePath: wt('a') }, { ts: 30 }),
    ])
    const view = selectWorktreeIndex(state)[wt('a')]
    expect(view?.panes).toHaveLength(2)
    expect(view?.lastActivityTs).toBe(30)
  })

  it('leaves a detached worktree with no branch-derived data', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: wt('d'), branch: null, head: 'abc', isMain: false }, { ts: 10 }),
    ])
    expect(selectWorktreeIndex(state)[wt('d')]).toMatchObject({
      branch: null,
      detached: true,
      filesTouched: [],
      aheadOfMain: 0,
      agent: null,
      lastActivityTs: null,
    })
  })

  it('matches an agent by branch, then by worktree name', () => {
    const byBranch = reduceAll([
      f.worktreeDiscovered({ path: wt('a'), branch: 'feature/a', isMain: false }, { ts: 10 }),
      f.agentStatus({ handle: 'whatever', status: 'waiting', branch: 'feature/a' }, { ts: 20 }),
    ])
    expect(selectWorktreeIndex(byBranch)[wt('a')]?.agent?.handle).toBe('whatever')

    const byName = reduceAll([
      f.worktreeDiscovered({ path: wt('a'), branch: 'feature/a', isMain: false }, { ts: 10 }),
      f.agentStatus({ handle: 'a', status: 'done' }, { ts: 20 }),
    ])
    expect(selectWorktreeIndex(byName)[wt('a')]?.agent?.status).toBe('done')
  })

  it('reads the fixture swarm the way a panel would', () => {
    const state = reduceAll(fixtureSession())
    const views = selectWorktreeViews(state)
    expect(views.map((v) => v.name)).toEqual(['rhizomorph', '2-core', '3-git', '7-web'])

    const core = views.find((v) => v.name === '2-core')
    expect(core).toMatchObject({ aheadOfMain: 2, dirtyCount: 0, branch: '2-core' })
    expect(core?.filesTouched).toContain('packages/core/src/reduce.ts')
    expect(core?.agent?.status).toBe('working')

    const git = views.find((v) => v.name === '3-git')
    expect(git).toMatchObject({ aheadOfMain: 1, dirtyCount: 3 })
    expect(git?.agent?.status).toBe('waiting')
  })
})
