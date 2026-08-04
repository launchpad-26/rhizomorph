import { beforeEach, describe, expect, it } from 'vitest'
import { createEventFactory, fixtureSession } from './fixtures.js'
import { reduce, reduceAll } from './reduce.js'
import {
  MAX_ERRORS,
  initialCheckpointState,
  initialJudgeState,
  initialSessionState,
  initialTelemetryState,
  initialTraceState,
} from './state.js'

const REPO = '/repo/rhizomorph'
const WT = `${REPO}-wt/feature`

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

describe('reduce — envelope bookkeeping', () => {
  it('starts empty', () => {
    const state = initialSessionState()
    expect(state).toEqual({
      session: null,
      mainBranch: null,
      worktrees: {},
      branches: {},
      commits: {},
      commitOrder: [],
      panes: {},
      agents: {},
      collectors: {},
      errors: [],
      telemetry: initialTelemetryState(),
      traces: initialTraceState(),
      checkpoints: initialCheckpointState(),
      judge: initialJudgeState(),
      eventCount: 0,
      firstEventTs: null,
      lastEventTs: null,
    })
  })

  it('counts events and tracks first/last timestamps', () => {
    const state = reduceAll([
      f.sessionStarted({}, { ts: 500 }),
      f.paneActivity({ paneId: '%1', contentHash: 'a' }, { ts: 1500 }),
    ])
    expect(state.eventCount).toBe(2)
    expect(state.firstEventTs).toBe(500)
    expect(state.lastEventTs).toBe(1500)
  })

  it('never lets lastEventTs go backwards on an out-of-order event', () => {
    const state = reduceAll([
      f.paneActivity({ paneId: '%1', contentHash: 'a' }, { ts: 9000 }),
      f.paneActivity({ paneId: '%1', contentHash: 'b' }, { ts: 3000 }),
    ])
    expect(state.lastEventTs).toBe(9000)
    expect(state.firstEventTs).toBe(9000)
  })

  it('is pure — the input state is untouched', () => {
    const before = initialSessionState()
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown
    const after = reduce(before, f.worktreeDiscovered())
    expect(before).toEqual(snapshot)
    expect(after).not.toBe(before)
    expect(after.worktrees).not.toBe(before.worktrees)
  })

  it('folds the same log to the same state twice — replay is deterministic', () => {
    const events = fixtureSession()
    expect(reduceAll(events)).toEqual(reduceAll(events))
  })
})

describe('reduce — system events', () => {
  it('records the session and the main branch', () => {
    const state = reduce(
      initialSessionState(),
      f.sessionStarted({ sessionId: 's1', repoPath: REPO, repoName: 'rhizomorph', mainBranch: 'trunk' }, { ts: 42 }),
    )
    expect(state.session).toEqual({
      sessionId: 's1',
      repoPath: REPO,
      repoName: 'rhizomorph',
      startedAt: 42,
    })
    expect(state.mainBranch).toBe('trunk')
  })

  it('leaves a known main branch alone when the session does not name one', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: REPO, branch: 'main', isMain: true }),
      f.sessionStarted({ mainBranch: null }),
    ])
    expect(state.mainBranch).toBe('main')
  })

  it('accumulates collector errors', () => {
    const state = reduceAll([
      f.collectorError({ collector: 'git', message: 'boom', detail: 'exit 128' }, { ts: 10 }),
      f.collectorError({ collector: 'git', message: 'boom again' }, { ts: 20 }),
    ])
    expect(state.collectors['git']).toMatchObject({
      name: 'git',
      status: 'error',
      errorCount: 2,
      lastErrorTs: 20,
      lastErrorMessage: 'boom again',
    })
    expect(state.errors).toHaveLength(2)
    expect(state.errors[0]).toMatchObject({ collector: 'git', message: 'boom', detail: 'exit 128' })
    expect(state.errors[1]?.detail).toBeNull()
  })

  it('caps the error list and keeps the newest', () => {
    const events = Array.from({ length: MAX_ERRORS + 25 }, (_, i) =>
      f.collectorError({ collector: 'git', message: `boom ${i}` }, { ts: i }),
    )
    const state = reduceAll(events)
    expect(state.errors).toHaveLength(MAX_ERRORS)
    expect(state.errors[state.errors.length - 1]?.message).toBe(`boom ${MAX_ERRORS + 24}`)
    expect(state.collectors['git']?.errorCount).toBe(MAX_ERRORS + 25)
  })

  it('keeps a collector disabled even if it errors afterwards', () => {
    const state = reduceAll([
      f.collectorDisabled({ collector: 'workmux', reason: 'not on PATH' }, { ts: 5 }),
      f.collectorError({ collector: 'workmux', message: 'late error' }, { ts: 6 }),
    ])
    expect(state.collectors['workmux']).toMatchObject({
      status: 'disabled',
      disabledReason: 'not on PATH',
      disabledAt: 5,
      errorCount: 1,
      lastErrorMessage: 'late error',
    })
  })

  it('reports a degraded collector as retrying, not disabled', () => {
    const state = reduceAll([
      f.collectorDegraded(
        { collector: 'tmux', reason: 'tmux exited with code 1', consecutiveFailures: 1 },
        { ts: 10 },
      ),
    ])
    expect(state.collectors['tmux']).toMatchObject({
      status: 'degraded-retrying',
      consecutiveFailures: 1,
      lastErrorMessage: 'tmux exited with code 1',
      disabledReason: null,
      disabledAt: null,
    })
  })

  it('keeps a disabled collector disabled even if a retry attempt degrades again', () => {
    const state = reduceAll([
      f.collectorDisabled(
        { collector: 'tmux', reason: 'tmux exited with code 1', consecutiveFailures: 3 },
        { ts: 10 },
      ),
      f.collectorDegraded(
        { collector: 'tmux', reason: 'tmux exited with code 1', consecutiveFailures: 4 },
        { ts: 40 },
      ),
    ])
    expect(state.collectors['tmux']).toMatchObject({ status: 'disabled', disabledReason: 'tmux exited with code 1' })
  })

  it('clears a collector back to healthy on recovery', () => {
    const state = reduceAll([
      f.collectorDegraded(
        { collector: 'tmux', reason: 'tmux exited with code 1', consecutiveFailures: 1 },
        { ts: 10 },
      ),
      f.collectorDisabled(
        { collector: 'tmux', reason: 'tmux exited with code 1', consecutiveFailures: 3 },
        { ts: 30 },
      ),
      f.collectorRecovered({ collector: 'tmux', consecutiveFailures: 3 }, { ts: 60 }),
    ])
    expect(state.collectors['tmux']).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0,
      disabledReason: null,
      disabledAt: null,
    })
  })
})

describe('reduce — worktrees', () => {
  it('records a discovered worktree and derives its display name', () => {
    const state = reduce(
      initialSessionState(),
      f.worktreeDiscovered({ path: WT, branch: 'feature', head: 'sha1', isMain: false }, { ts: 100 }),
    )
    expect(state.worktrees[WT]).toMatchObject({
      path: WT,
      name: 'feature',
      branch: 'feature',
      head: 'sha1',
      isMain: false,
      detached: false,
      present: true,
      discoveredAt: 100,
      removedAt: null,
      dirtyFiles: [],
    })
    // Discovery also registers the branch.
    expect(state.branches['feature']).toMatchObject({ name: 'feature', head: 'sha1', worktreePath: WT })
  })

  it('treats a null branch as a detached head', () => {
    const state = reduce(
      initialSessionState(),
      f.worktreeDiscovered({ path: WT, branch: null, head: 'sha1', isMain: false }),
    )
    expect(state.worktrees[WT]).toMatchObject({ branch: null, detached: true })
    expect(Object.keys(state.branches)).toHaveLength(0)
  })

  it("takes main's identity from the primary worktree", () => {
    const state = reduce(
      initialSessionState(),
      f.worktreeDiscovered({ path: REPO, branch: 'trunk', isMain: true }),
    )
    expect(state.mainBranch).toBe('trunk')
  })

  it('keeps discovery time and dirty files across re-discovery', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: WT, branch: 'feature', head: 'sha1', isMain: false }, { ts: 100 }),
      f.worktreeDirty({ path: WT, branch: 'feature', files: [{ path: 'a.ts', status: 'modified' }] }, { ts: 150 }),
      f.worktreeDiscovered({ path: WT, branch: 'feature', head: 'sha2', isMain: false }, { ts: 200 }),
    ])
    expect(state.worktrees[WT]).toMatchObject({
      discoveredAt: 100,
      head: 'sha2',
      dirtyFiles: [{ path: 'a.ts', status: 'modified' }],
      dirtyUpdatedAt: 150,
    })
  })

  it('marks a removed worktree absent and drops its dirty set', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: WT, branch: 'feature', isMain: false }, { ts: 100 }),
      f.worktreeDirty({ path: WT, files: [{ path: 'a.ts', status: 'modified' }] }, { ts: 150 }),
      f.worktreeRemoved({ path: WT }, { ts: 300 }),
    ])
    expect(state.worktrees[WT]).toMatchObject({ present: false, removedAt: 300, dirtyFiles: [] })
  })

  it('ignores removal of a worktree it never saw', () => {
    const before = initialSessionState()
    const after = reduce(before, f.worktreeRemoved({ path: '/nope' }))
    expect(after.worktrees).toEqual({})
  })

  it('replaces the dirty set wholesale rather than merging', () => {
    const state = reduceAll([
      f.worktreeDirty({ path: WT, files: [{ path: 'a.ts', status: 'modified' }, { path: 'b.ts', status: 'added' }] }, { ts: 1 }),
      f.worktreeDirty({ path: WT, files: [{ path: 'b.ts', status: 'added' }] }, { ts: 2 }),
    ])
    expect(state.worktrees[WT]?.dirtyFiles).toEqual([{ path: 'b.ts', status: 'added' }])
  })

  it('stubs a worktree that goes dirty before it was discovered', () => {
    const state = reduce(
      initialSessionState(),
      f.worktreeDirty({ path: WT, branch: 'feature', files: [{ path: 'a.ts', status: 'untracked' }] }, { ts: 7 }),
    )
    expect(state.worktrees[WT]).toMatchObject({
      path: WT,
      branch: 'feature',
      present: true,
      isMain: false,
      discoveredAt: 7,
    })
  })
})

describe('reduce — branches and commits', () => {
  it('tracks head movement and remembers the previous head', () => {
    const state = reduceAll([
      f.branchUpdated({ branch: 'feature', head: 'sha1' }, { ts: 10 }),
      f.branchUpdated({ branch: 'feature', head: 'sha2' }, { ts: 20 }),
    ])
    expect(state.branches['feature']).toMatchObject({
      head: 'sha2',
      previousHead: 'sha1',
      updatedAt: 20,
      firstSeenAt: 10,
    })
  })

  it('prefers an explicitly reported previous head', () => {
    const state = reduce(
      initialSessionState(),
      f.branchUpdated({ branch: 'feature', head: 'sha2', previousHead: 'sha0' }),
    )
    expect(state.branches['feature']?.previousHead).toBe('sha0')
  })

  it('keeps reported ahead/behind counts until they are restated', () => {
    const state = reduceAll([
      f.branchUpdated({ branch: 'feature', head: 'sha1', aheadOfMain: 3, behindMain: 1 }),
      f.branchUpdated({ branch: 'feature', head: 'sha2' }),
    ])
    expect(state.branches['feature']).toMatchObject({ aheadOfMain: 3, behindMain: 1 })

    const cleared = reduce(
      state,
      f.branchUpdated({ branch: 'feature', head: 'sha3', aheadOfMain: null }),
    )
    expect(cleared.branches['feature']?.aheadOfMain).toBeNull()
  })

  it("moves the worktree's head along with its branch", () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: WT, branch: 'feature', head: 'sha1', isMain: false }),
      f.branchUpdated({ branch: 'feature', head: 'sha2' }),
    ])
    expect(state.worktrees[WT]?.head).toBe('sha2')
  })

  it('records a landed commit once, in order, against its branch', () => {
    const state = reduceAll([
      f.commitLanded({ sha: 'c1', branch: 'feature', message: 'first' }, { ts: 10 }),
      f.commitLanded({ sha: 'c2', branch: 'feature', message: 'second' }, { ts: 20 }),
    ])
    expect(state.commitOrder).toEqual(['c1', 'c2'])
    expect(state.branches['feature']?.commits).toEqual(['c1', 'c2'])
    expect(state.commits['c1']).toMatchObject({
      sha: 'c1',
      branches: ['feature'],
      message: 'first',
      landedAt: 10,
      authoredAt: 10,
    })
  })

  it('uses the author date when git reported one', () => {
    const state = reduce(
      initialSessionState(),
      f.commitLanded({ sha: 'c1', authoredAt: 5 }, { ts: 900 }),
    )
    expect(state.commits['c1']).toMatchObject({ authoredAt: 5, landedAt: 900 })
  })

  it('adds a branch to an existing commit when the same sha lands again', () => {
    const state = reduceAll([
      f.commitLanded({ sha: 'c1', branch: 'feature' }, { ts: 10 }),
      f.commitLanded({ sha: 'c1', branch: 'main' }, { ts: 20 }),
      f.commitLanded({ sha: 'c1', branch: 'main' }, { ts: 30 }),
    ])
    expect(state.commits['c1']?.branches).toEqual(['feature', 'main'])
    expect(state.commits['c1']?.landedAt).toBe(10)
    expect(state.commitOrder).toEqual(['c1'])
    expect(state.branches['main']?.commits).toEqual(['c1'])
  })

  it('does not lose a known file list to a later fileless sighting', () => {
    const state = reduceAll([
      f.commitLanded({ sha: 'c1', branch: 'feature', files: [{ path: 'a.ts', status: 'added' }] }),
      f.commitLanded({ sha: 'c1', branch: 'main', files: [] }),
    ])
    expect(state.commits['c1']?.files).toEqual([{ path: 'a.ts', status: 'added' }])
  })

  it('drops a removed branch from state.branches entirely, keeping its commits', () => {
    const state = reduceAll([
      f.branchUpdated({ branch: 'feature', head: 'sha1' }, { ts: 10 }),
      f.commitLanded({ sha: 'c1', branch: 'feature' }, { ts: 20 }),
      f.branchRemoved({ branch: 'feature' }, { ts: 300 }),
    ])
    expect(state.branches['feature']).toBeUndefined()
    expect(Object.keys(state.branches)).toHaveLength(0)
    // The work still happened — commit history is not removal's business.
    expect(state.commits['c1']).toMatchObject({ sha: 'c1', branches: ['feature'] })
    expect(state.commitOrder).toEqual(['c1'])
  })

  it('ignores removal of a branch it never saw', () => {
    const before = initialSessionState()
    const after = reduce(before, f.branchRemoved({ branch: 'nope' }))
    expect(after.branches).toEqual({})
  })

  it('is unaffected by branch.removed events an old log never recorded', () => {
    // A log from before this event type existed has no `branch.removed` at
    // all — replaying it must land on exactly the branches it always did.
    const events = fixtureSession()
    expect(events.some((event) => event.type === 'branch.removed')).toBe(false)
    const state = reduceAll(events)
    expect(Object.keys(state.branches).sort()).toEqual(['2-core', '3-git', '7-web', 'main'])
  })
})

describe('reduce — panes and agents', () => {
  it('records a discovered pane as alive from discovery', () => {
    const state = reduce(
      initialSessionState(),
      f.paneDiscovered({ paneId: '%1', windowName: 'feature', currentPath: WT, worktreePath: WT }, { ts: 100 }),
    )
    expect(state.panes['%1']).toMatchObject({
      paneId: '%1',
      windowName: 'feature',
      worktreePath: WT,
      present: true,
      discoveredAt: 100,
      lastActivityTs: 100,
      lastContentChangeTs: null,
      activityCount: 0,
    })
  })

  it('advances last activity on each content delta', () => {
    const state = reduceAll([
      f.paneDiscovered({ paneId: '%1' }, { ts: 100 }),
      f.paneActivity({ paneId: '%1', contentHash: 'h1', preview: 'npm test' }, { ts: 200 }),
      f.paneActivity({ paneId: '%1', contentHash: 'h2' }, { ts: 300 }),
    ])
    expect(state.panes['%1']).toMatchObject({
      contentHash: 'h2',
      lastActivityTs: 300,
      lastContentChangeTs: 300,
      activityCount: 2,
      preview: 'npm test',
    })
  })

  it('stubs a pane that shows activity before discovery', () => {
    const state = reduce(initialSessionState(), f.paneActivity({ paneId: '%9', contentHash: 'h' }, { ts: 12 }))
    expect(state.panes['%9']).toMatchObject({ paneId: '%9', present: true, activityCount: 1, lastActivityTs: 12 })
  })

  it('closes a pane without forgetting it, and ignores unknown closes', () => {
    const state = reduceAll([
      f.paneDiscovered({ paneId: '%1' }, { ts: 100 }),
      f.paneClosed({ paneId: '%1' }, { ts: 400 }),
      f.paneClosed({ paneId: '%404' }, { ts: 500 }),
    ])
    expect(state.panes['%1']).toMatchObject({ present: false, closedAt: 400 })
    expect(state.panes['%404']).toBeUndefined()
  })

  it('re-discovering a pane revives it and keeps its history', () => {
    const state = reduceAll([
      f.paneDiscovered({ paneId: '%1' }, { ts: 100 }),
      f.paneActivity({ paneId: '%1', contentHash: 'h1' }, { ts: 200 }),
      f.paneClosed({ paneId: '%1' }, { ts: 300 }),
      f.paneDiscovered({ paneId: '%1' }, { ts: 400 }),
    ])
    expect(state.panes['%1']).toMatchObject({
      present: true,
      closedAt: null,
      discoveredAt: 100,
      lastActivityTs: 200,
      activityCount: 1,
    })
  })

  it('tracks agent status transitions', () => {
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'working', worktreePath: WT, branch: 'feature' }, { ts: 10 }),
      f.agentStatus({ handle: 'feature', status: 'waiting', elapsedSeconds: 90 }, { ts: 20 }),
    ])
    expect(state.agents['feature']).toMatchObject({
      handle: 'feature',
      status: 'waiting',
      previousStatus: 'working',
      // Carried forward from the first sighting.
      worktreePath: WT,
      branch: 'feature',
      elapsedSeconds: 90,
      firstSeenAt: 10,
      updatedAt: 20,
    })
  })
})

describe('reduce — the fixture session', () => {
  const state = reduceAll(fixtureSession())

  it('builds the whole picture in one fold', () => {
    expect(state.session?.repoName).toBe('rhizomorph')
    expect(state.mainBranch).toBe('main')
    expect(Object.keys(state.worktrees)).toHaveLength(4)
    expect(Object.keys(state.panes)).toHaveLength(3)
    expect(Object.keys(state.agents)).toHaveLength(3)
    expect(state.commitOrder).toEqual(['sha-core-1', 'sha-core-2', 'sha-git-1'])
    expect(state.branches['2-core']?.commits).toEqual(['sha-core-1', 'sha-core-2'])
    expect(state.collectors['tmux']?.status).toBe('error')
    expect(state.eventCount).toBe(fixtureSession().length)
  })
})

describe('reduce — fork.checkpoint (prd12)', () => {
  it('an old log with no fork.checkpoint events folds checkpoints to its initial value — additive, unchanged replay', () => {
    const state = reduceAll(fixtureSession())
    expect(state.checkpoints).toEqual(initialCheckpointState())
  })

  it('appends a checkpoint record and indexes it by lane', () => {
    const state = reduceAll([
      f.forkCheckpoint({ lane: '148-lab-checkpoint', checkpointId: 'ckpt-1' }, { ts: 100 }),
    ])
    expect(state.checkpoints.records).toHaveLength(1)
    expect(state.checkpoints.records[0]).toMatchObject({
      lane: '148-lab-checkpoint',
      checkpointId: 'ckpt-1',
      ts: 100,
    })
    expect(state.checkpoints.byLane['148-lab-checkpoint']).toEqual([0])
  })

  it('indexes multiple checkpoints for the same lane in observation order', () => {
    const state = reduceAll([
      f.forkCheckpoint({ lane: 'a', checkpointId: 'ckpt-1' }, { ts: 100 }),
      f.forkCheckpoint({ lane: 'b', checkpointId: 'ckpt-2' }, { ts: 200 }),
      f.forkCheckpoint({ lane: 'a', checkpointId: 'ckpt-3' }, { ts: 300 }),
    ])
    expect(state.checkpoints.records.map((r) => r.checkpointId)).toEqual(['ckpt-1', 'ckpt-2', 'ckpt-3'])
    expect(state.checkpoints.byLane['a']).toEqual([0, 2])
    expect(state.checkpoints.byLane['b']).toEqual([1])
  })

  it('is pure — folding a checkpoint does not mutate the prior state', () => {
    const before = initialSessionState()
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown
    const after = reduce(before, f.forkCheckpoint())
    expect(before).toEqual(snapshot)
    expect(after.checkpoints).not.toBe(before.checkpoints)
  })
})

describe('reduce — judge.finding (prd11 ruling 6b)', () => {
  it('an old log with no judge.finding events folds judge to its initial value — additive, unchanged replay', () => {
    const state = reduceAll(fixtureSession())
    expect(state.judge).toEqual(initialJudgeState())
  })

  it('appends a finding and indexes it under BOTH of its lanes', () => {
    const state = reduceAll([
      f.judgeFinding({ lanes: ['2-core', '3-git'] }, { ts: 100 }),
    ])
    expect(state.judge.findings).toHaveLength(1)
    expect(state.judge.findings[0]).toMatchObject({
      kind: 'symbol-overlap',
      lanes: ['2-core', '3-git'],
      severity: 'log',
      ts: 100,
    })
    expect(state.judge.byLane['2-core']).toEqual([0])
    expect(state.judge.byLane['3-git']).toEqual([0])
  })

  it('indexes multiple findings for the same lane in observation order', () => {
    const state = reduceAll([
      f.judgeFinding({ lanes: ['2-core', '3-git'] }, { ts: 100 }),
      f.judgeFinding({ lanes: ['3-git', '7-web'] }, { ts: 200 }),
      f.judgeFinding({ lanes: ['2-core', '7-web'] }, { ts: 300 }),
    ])
    expect(state.judge.byLane['2-core']).toEqual([0, 2])
    expect(state.judge.byLane['3-git']).toEqual([0, 1])
    expect(state.judge.byLane['7-web']).toEqual([1, 2])
  })

  it('is pure — folding a finding does not mutate the prior state', () => {
    const before = initialSessionState()
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown
    const after = reduce(before, f.judgeFinding())
    expect(before).toEqual(snapshot)
    expect(after.judge).not.toBe(before.judge)
  })
})
