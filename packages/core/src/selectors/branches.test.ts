import { beforeEach, describe, expect, it } from 'vitest'
import { createEventFactory } from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import { selectAheadOfMain, selectBranchIndex, selectBranches } from './branches.js'

const REPO = '/repo/rhizomorph'

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

const mainDiscovered = () => [
  f.sessionStarted({ mainBranch: 'main' }),
  f.worktreeDiscovered({ path: REPO, branch: 'main', head: 'sha-main-0', isMain: true }),
]

describe('ahead of main', () => {
  it('derives a count from the commits observed on a branch', () => {
    const state = reduceAll([
      ...mainDiscovered(),
      f.commitLanded({ sha: 'c1', branch: 'a' }),
      f.commitLanded({ sha: 'c2', branch: 'a' }),
    ])
    expect(selectAheadOfMain(state)).toEqual({ main: 0, a: 2 })
  })

  it('stops counting a commit once main has it', () => {
    const state = reduceAll([
      ...mainDiscovered(),
      f.commitLanded({ sha: 'c1', branch: 'a' }),
      f.commitLanded({ sha: 'c2', branch: 'a' }),
      f.commitLanded({ sha: 'c1', branch: 'main' }),
    ])
    expect(selectAheadOfMain(state)['a']).toBe(1)
  })

  it("prefers git's merge-base answer to our own bookkeeping", () => {
    const state = reduceAll([
      ...mainDiscovered(),
      // git says 7; we only watched one of them land.
      f.commitLanded({ sha: 'c1', branch: 'a' }),
      f.branchUpdated({ branch: 'a', head: 'c1', aheadOfMain: 7, behindMain: 2 }),
    ])
    expect(selectAheadOfMain(state)['a']).toBe(7)
    expect(selectAheadOfMain(state, { preferReported: false })['a']).toBe(1)

    const view = selectBranchIndex(state)['a']
    expect(view).toMatchObject({ aheadOfMain: 7, reportedAhead: 7, observedAhead: 1, behindMain: 2 })
  })

  it('is always zero for main itself', () => {
    const state = reduceAll([
      ...mainDiscovered(),
      f.commitLanded({ sha: 'm1', branch: 'main' }),
      f.branchUpdated({ branch: 'main', head: 'm1', aheadOfMain: 4 }),
    ])
    expect(selectAheadOfMain(state)['main']).toBe(0)
    expect(selectBranchIndex(state)['main']).toMatchObject({ isMain: true, behindMain: 0 })
  })

  it('counts everything it saw when main is unknown', () => {
    const state = reduceAll([f.commitLanded({ sha: 'c1', branch: 'a' })])
    expect(selectAheadOfMain(state)).toEqual({ a: 1 })
  })

  it('measures against an overridden main', () => {
    const state = reduceAll([
      ...mainDiscovered(),
      f.commitLanded({ sha: 'c1', branch: 'a' }),
      f.commitLanded({ sha: 'c1', branch: 'release' }),
      f.commitLanded({ sha: 'c2', branch: 'a' }),
    ])
    expect(selectAheadOfMain(state, { mainBranch: 'release' })['a']).toBe(1)
  })
})

describe('selectBranches', () => {
  it('puts main first, then sorts by name', () => {
    const state = reduceAll([
      ...mainDiscovered(),
      f.branchUpdated({ branch: 'zeta', head: 'z1' }),
      f.branchUpdated({ branch: 'alpha', head: 'a1' }),
    ])
    expect(selectBranches(state).map((b) => b.name)).toEqual(['main', 'alpha', 'zeta'])
  })

  it('reports head movement, commit count and the last landing time', () => {
    const state = reduceAll([
      ...mainDiscovered(),
      f.commitLanded({ sha: 'c1', branch: 'a' }, { ts: 100 }),
      f.commitLanded({ sha: 'c2', branch: 'a' }, { ts: 200 }),
      f.branchUpdated({ branch: 'a', head: 'c2', previousHead: 'c1', worktreePath: `${REPO}-wt/a` }, { ts: 250 }),
    ])
    expect(selectBranchIndex(state)['a']).toMatchObject({
      head: 'c2',
      previousHead: 'c1',
      worktreePath: `${REPO}-wt/a`,
      commitCount: 2,
      lastCommitTs: 200,
      updatedAt: 250,
      isMain: false,
    })
  })

  it('survives a branch whose commits were never detailed', () => {
    const state = reduceAll([...mainDiscovered(), f.branchUpdated({ branch: 'a', head: 'a1' })])
    expect(selectBranchIndex(state)['a']).toMatchObject({
      commitCount: 0,
      lastCommitTs: null,
      aheadOfMain: 0,
    })
  })
})
