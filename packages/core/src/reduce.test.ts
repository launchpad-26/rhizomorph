import { beforeEach, describe, expect, it } from 'vitest'
import { eraCorpusEntry } from './eras/corpus.js'
import { canonicalStateJson, foldEraRecording } from './eras/fold.js'
import type { EventOf, RhizomorphEvent } from './events/index.js'
import { observeUpcast, upcast } from './events/upcast.js'
import { createEventFactory, fixtureSession } from './fixtures.js'
import { reduce, reduceAll } from './reduce.js'
import type { SessionState, SpanRecord } from './state.js'
import {
  MAX_ERRORS,
  initialCheckpointState,
  initialForkState,
  initialJudgeState,
  initialSessionState,
  initialTelemetryState,
  initialTraceState,
  traceStateOf,
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
      forks: initialForkState(),
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

describe('reduce — fork.dispatched (prd12 ruling 3)', () => {
  it('an old log with no fork.dispatched events folds forks to its initial value — additive, unchanged replay', () => {
    const state = reduceAll(fixtureSession())
    expect(state.forks).toEqual(initialForkState())
  })

  it('appends an arm and indexes it by fork and by lane', () => {
    const state = reduceAll([
      f.forkDispatched(
        { forkId: 'fork-1', parentLane: 'feature', arm: 1, laneHandle: 'fork-1-arm-1' },
        { ts: 100 },
      ),
    ])
    expect(state.forks.dispatches).toHaveLength(1)
    expect(state.forks.dispatches[0]).toMatchObject({
      forkId: 'fork-1',
      parentLane: 'feature',
      arm: 1,
      laneHandle: 'fork-1-arm-1',
      model: 'opus',
      ts: 100,
    })
    expect(state.forks.byFork['fork-1']).toEqual([0])
    expect(state.forks.byLane['fork-1-arm-1']).toEqual([0])
  })

  it('groups three arms of one fork under one forkId, in arm order', () => {
    const state = reduceAll(
      [1, 2, 3].map((arm) =>
        f.forkDispatched({ forkId: 'fork-1', arm, laneHandle: `fork-1-arm-${arm}` }, { ts: 100 + arm }),
      ),
    )
    expect(state.forks.byFork['fork-1']).toEqual([0, 1, 2])
    expect(state.forks.dispatches.map((d) => d.arm)).toEqual([1, 2, 3])
  })

  it('marks a lane that appears AFTER the dispatch synthetic — the forward direction', () => {
    const state = reduceAll([
      f.forkDispatched({ forkId: 'fork-1', laneHandle: 'fork-1-arm-1' }, { ts: 100 }),
      f.agentStatus({ handle: 'fork-1-arm-1', status: 'working' }, { ts: 200 }),
      f.llmUsage({ lane: 'fork-1-arm-1' }, { ts: 300 }),
    ])
    expect(state.agents['fork-1-arm-1']?.synthetic).toBe(true)
    expect(state.telemetry.lanes['fork-1-arm-1']?.synthetic).toBe(true)
  })

  it('marks a lane that appeared BEFORE the dispatch synthetic too — the fold is order-independent', () => {
    const state = reduceAll([
      f.agentStatus({ handle: 'fork-1-arm-1', status: 'working' }, { ts: 100 }),
      f.llmUsage({ lane: 'fork-1-arm-1' }, { ts: 150 }),
      f.forkDispatched({ forkId: 'fork-1', laneHandle: 'fork-1-arm-1' }, { ts: 200 }),
    ])
    expect(state.agents['fork-1-arm-1']?.synthetic).toBe(true)
    expect(state.telemetry.lanes['fork-1-arm-1']?.synthetic).toBe(true)
  })

  it('never unsets the mark — a later status poll cannot un-fork a lane', () => {
    const state = reduceAll([
      f.forkDispatched({ forkId: 'fork-1', laneHandle: 'fork-1-arm-1' }, { ts: 100 }),
      f.agentStatus({ handle: 'fork-1-arm-1', status: 'working' }, { ts: 200 }),
      f.agentStatus({ handle: 'fork-1-arm-1', status: 'done' }, { ts: 300 }),
    ])
    expect(state.agents['fork-1-arm-1']?.synthetic).toBe(true)
  })

  it('leaves the parent lane and every other lane exactly as they were — no key added', () => {
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'working' }, { ts: 100 }),
      f.llmUsage({ lane: 'feature' }, { ts: 150 }),
      f.forkDispatched({ forkId: 'fork-1', parentLane: 'feature', laneHandle: 'fork-1-arm-1' }, { ts: 200 }),
    ])
    expect(state.agents['feature']).not.toHaveProperty('synthetic')
    expect(state.telemetry.lanes['feature']).not.toHaveProperty('synthetic')
  })

  it('is pure — folding a dispatch does not mutate the prior state', () => {
    const before = initialSessionState()
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown
    const after = reduce(before, f.forkDispatched())
    expect(before).toEqual(snapshot)
    expect(after.forks).not.toBe(before.forks)
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

/**
 * #179 gave the usage fold a lookup table so it stops re-scanning a growing
 * array once per telemetry event. The table is derived, not recorded — it is
 * keyed by the identity of the array it describes and lives beside the reducer,
 * not in `SessionState` (the argument is on `UsageIndex` in `reduce.ts`).
 *
 * Which makes these the laws that matter: not "the table has the right
 * contents" — no surface can see it — but **the fold cannot tell the table is
 * there**. Every test below folds one log two ways and demands the same bytes.
 */
describe('reduce — the usage index is an accelerator, never an input (#179)', () => {
  /**
   * A log that walks every branch of the usage fold, several times each: the
   * cross-collector dedup (both arrival orders), the request-less OTel
   * retirement that shifts every position in the array, an OTel-only session
   * that must keep counting in full, and dollars that land both before and
   * after the usage that says where their session ran.
   */
  function indexStress(): RhizomorphEvent[] {
    const events: RhizomorphEvent[] = []
    const push = (event: RhizomorphEvent): number => events.push(event)

    // Session A — sessionlog leads, OTel repeats the same ids afterwards.
    for (let i = 0; i < 8; i += 1) {
      push(f.llmUsage(
        { lane: 'a', requestId: `req-a-${i}`, sessionId: 'sess-a', worktreePath: `${REPO}-wt/a`, branch: 'a' },
        { source: 'sessionlog' },
      ))
    }
    for (let i = 0; i < 8; i += 1) {
      push(f.llmUsage(
        { lane: 'a-otel', requestId: `req-a-${i}`, sessionId: 'sess-a', worktreePath: null, branch: null },
        { source: 'otel' },
      ))
    }

    // Session B — dollars first, then request-less OTel usage, then the
    // sessionlog record that retires it and places everything retroactively.
    push(f.llmCost({ lane: 'b-otel', sessionId: 'sess-b', worktreePath: null, branch: null }, { source: 'otel' }))
    for (let i = 0; i < 5; i += 1) {
      push(f.llmUsage(
        { lane: 'b-otel', requestId: null, sessionId: 'sess-b', worktreePath: null, branch: null },
        { source: 'otel' },
      ))
    }
    push(f.llmUsage(
      { lane: 'b', requestId: 'req-b-0', sessionId: 'sess-b', worktreePath: `${REPO}-wt/b`, branch: 'b' },
      { source: 'sessionlog' },
    ))
    // Covered now: these fold away instead of appending.
    for (let i = 0; i < 3; i += 1) {
      push(f.llmUsage(
        { lane: 'b-otel', requestId: null, sessionId: 'sess-b', worktreePath: null, branch: null },
        { source: 'otel' },
      ))
    }

    // Session C — OTel alone, forever. Nothing here may ever be folded away.
    for (let i = 0; i < 4; i += 1) {
      push(f.llmUsage(
        { lane: 'c-otel', requestId: null, sessionId: 'sess-c', worktreePath: null, branch: null },
        { source: 'otel' },
      ))
    }

    // OTel leading a dedup pair, the other arrival order, plus the quiet
    // telemetry that makes `withTelemetry` run without teaching it anything.
    push(f.llmUsage({ lane: 'd-otel', requestId: 'req-d-0', sessionId: 'sess-d', worktreePath: null, branch: null }, { source: 'otel' }))
    push(f.toolActivity({ lane: 'd', tool: 'Bash', sessionId: 'sess-d', worktreePath: `${REPO}-wt/d`, branch: 'd' }))
    push(f.llmUsage({ lane: 'd', requestId: 'req-d-0', sessionId: 'sess-d', worktreePath: `${REPO}-wt/d`, branch: 'd' }, { source: 'sessionlog' }))
    push(f.agentActiveTime({ lane: 'd', sessionId: 'sess-d', worktreePath: `${REPO}-wt/d`, branch: 'd' }, { source: 'otel' }))
    push(f.llmCost({ lane: 'd', sessionId: 'sess-d', worktreePath: null, branch: null }, { source: 'otel' }))
    // A record with no session at all — the branch that skips the join whole.
    push(f.llmUsage({ lane: 'e', requestId: null, sessionId: null, worktreePath: null, branch: null }, { source: 'otel' }))

    return events
  }

  /**
   * The same fold with the table defeated: handing `reduce` a *copy* of the
   * usage array every event means the array it is keyed by is one nothing has
   * ever indexed, so every event rebuilds from scratch. If a carried-forward
   * table ever disagreed with a rebuilt one, this is where it would show.
   */
  function foldWithColdIndex(events: readonly RhizomorphEvent[]): SessionState {
    let state = initialSessionState()
    for (const event of events) {
      const cold: SessionState = {
        ...state,
        telemetry: { ...state.telemetry, usage: [...state.telemetry.usage] },
      }
      state = reduce(cold, event)
    }
    return state
  }

  it('folds to the same bytes whether its table is carried forward or rebuilt every event', () => {
    const events = indexStress()
    expect(JSON.stringify(foldWithColdIndex(events))).toBe(JSON.stringify(reduceAll(events)))
  })

  it('hands its table to one future only — two folds off one state stay independent', () => {
    const events = indexStress()
    const base = reduceAll(events)

    // Both of these fold off `base`, and they are a *dedup pair*: whichever
    // goes first records an id the other would match on. Neither may see the
    // other's record — they are two futures of one past, not a sequence — so
    // each must append, and each must equal its own from-scratch fold.
    const left = f.llmUsage(
      { lane: 'a', requestId: 'req-fork', sessionId: 'sess-a', worktreePath: `${REPO}-wt/a`, branch: 'a' },
      { source: 'sessionlog' },
    )
    const right = f.llmUsage(
      { lane: 'a-otel', requestId: 'req-fork', sessionId: 'sess-a', worktreePath: null, branch: null },
      { source: 'otel' },
    )

    const viaLeft = reduce(base, left)
    const viaRight = reduce(base, right)
    const leftAgain = reduce(base, left)

    expect(JSON.stringify(viaLeft)).toBe(JSON.stringify(reduceAll([...events, left])))
    expect(JSON.stringify(viaRight)).toBe(JSON.stringify(reduceAll([...events, right])))
    expect(JSON.stringify(leftAgain)).toBe(JSON.stringify(viaLeft))

    // Said as facts too, so a future reader can see what the bytes assert:
    // each branch appended its own record, neither folded into the other's.
    const grew = base.telemetry.usage.length + 1
    expect(viaLeft.telemetry.usage).toHaveLength(grew)
    expect(viaRight.telemetry.usage).toHaveLength(grew)
    expect(viaLeft.telemetry.usage[grew - 1]).toMatchObject({ requestId: 'req-fork', origin: 'sessionlog' })
    expect(viaRight.telemetry.usage[grew - 1]).toMatchObject({ requestId: 'req-fork', origin: 'otel' })
  })

  it('folds into the FIRST record carrying the id from the other collector, as the scan did', () => {
    // One collector re-emitting its own id is not deduped (that law is in
    // `reduce.telemetry.test.ts`), so this leaves two same-id OTel records for
    // the sessionlog copy to choose between. It must take the earlier one.
    const state = reduceAll([
      f.llmUsage(
        { lane: 'x', requestId: 'req_x', sessionId: null, worktreePath: null, branch: null, durationMs: 111 },
        { source: 'otel', ts: 1_000 },
      ),
      f.llmUsage(
        { lane: 'x', requestId: 'req_x', sessionId: null, worktreePath: null, branch: null, durationMs: 222 },
        { source: 'otel', ts: 1_100 },
      ),
      f.llmUsage(
        { lane: 'x', requestId: 'req_x', sessionId: null, worktreePath: null, branch: null, durationMs: 333 },
        { source: 'sessionlog', ts: 1_200 },
      ),
    ])
    expect(state.telemetry.usage).toHaveLength(2)
    expect(state.telemetry.usage[0]).toMatchObject({ origin: 'sessionlog', durationMs: 333 })
    expect(state.telemetry.usage[1]).toMatchObject({ origin: 'otel', durationMs: 222 })
  })

  it('still finds a duplicate whose position a retirement has shifted', () => {
    const state = reduceAll([
      f.llmUsage({ lane: 'y-otel', requestId: 'req_keep', sessionId: 'sess-y', worktreePath: null, branch: null }, { source: 'otel' }),
      // Retired by the sessionlog record below — every position after it moves.
      f.llmUsage({ lane: 'y-otel', requestId: null, sessionId: 'sess-y', worktreePath: null, branch: null }, { source: 'otel' }),
      f.llmUsage({ lane: 'y', requestId: 'req_other', sessionId: 'sess-y', worktreePath: `${WT}`, branch: 'feature' }, { source: 'sessionlog' }),
      // The dedup that has to land on `req_keep` at its new position, not its old one.
      f.llmUsage({ lane: 'y', requestId: 'req_keep', sessionId: 'sess-y', worktreePath: `${WT}`, branch: 'feature' }, { source: 'sessionlog' }),
    ])
    expect(state.telemetry.usage.map((record) => record.requestId)).toEqual(['req_keep', 'req_other'])
    expect(state.telemetry.usage[0]?.origin).toBe('sessionlog')
  })
})

/**
 * The other half of #179: the cost/lane join used to re-map every cost and
 * walk every lane on every telemetry event, to fill in nothing. It now runs
 * when the session's place actually moves — so these are the laws that the
 * catching-up still catches up.
 */
describe('reduce — the place join runs when there is something to join (#179)', () => {
  it('places a lane that first appears long after its session was placed', () => {
    const state = reduceAll([
      f.llmUsage({ lane: 'sl', sessionId: 'sess-p', worktreePath: WT, branch: 'feature' }, { source: 'sessionlog' }),
      ...Array.from({ length: 12 }, () =>
        f.llmUsage({ lane: 'sl', sessionId: 'sess-p', worktreePath: WT, branch: 'feature' }, { source: 'sessionlog' }),
      ),
      // The OTel side of the same session, under its own handle and with no
      // place of its own: the join is all it will ever have.
      f.toolActivity({ lane: 'otel-late', tool: 'Bash', sessionId: 'sess-p', worktreePath: null, branch: null }, { source: 'otel' }),
    ])
    expect(state.telemetry.lanes['otel-late']).toMatchObject({ worktreePath: WT, branch: 'feature' })
  })

  it('catches up dollars when their place is learned long after they landed', () => {
    const state = reduceAll([
      f.llmCost({ lane: 'q-otel', sessionId: 'sess-q', worktreePath: null, branch: null }, { source: 'otel' }),
      ...Array.from({ length: 12 }, () =>
        f.toolActivity({ lane: 'q-otel', tool: 'Bash', sessionId: 'sess-q', worktreePath: null, branch: null }, { source: 'otel' }),
      ),
      f.llmUsage({ lane: 'q', sessionId: 'sess-q', worktreePath: WT, branch: 'feature' }, { source: 'sessionlog' }),
    ])
    expect(state.telemetry.costs[0]).toMatchObject({
      worktreePath: WT,
      branch: 'feature',
      placeSource: 'session-join',
    })
  })

  it('completes a half-known place learned one half at a time, with traffic in between', () => {
    const state = reduceAll([
      f.llmCost({ lane: 'r-otel', sessionId: 'sess-r', worktreePath: null, branch: null }, { source: 'otel' }),
      f.llmUsage({ lane: 'r', sessionId: 'sess-r', worktreePath: null, branch: 'feature' }, { source: 'sessionlog' }),
      ...Array.from({ length: 8 }, () =>
        f.llmUsage({ lane: 'r', sessionId: 'sess-r', worktreePath: null, branch: 'feature' }, { source: 'sessionlog' }),
      ),
      f.llmUsage({ lane: 'r', sessionId: 'sess-r', worktreePath: WT, branch: 'feature' }, { source: 'sessionlog' }),
    ])
    expect(state.telemetry.costs[0]).toMatchObject({ worktreePath: WT, branch: 'feature' })
  })

  it('folds to the same facts whichever order the place and the dollars arrive in', () => {
    const usage = f.llmUsage({ lane: 'z', sessionId: 'sess-z', worktreePath: WT, branch: 'feature' }, { source: 'sessionlog', ts: 1_000 })
    const cost = f.llmCost({ lane: 'z-otel', sessionId: 'sess-z', worktreePath: null, branch: null }, { source: 'otel', ts: 2_000 })
    const usageFirst = reduceAll([usage, cost])
    const costFirst = reduceAll([cost, usage])
    // Compared as facts, not as bytes: records and map keys keep *observation*
    // order, so two arrival orders write the same two lanes in two different
    // orders. Byte-equality is the law for one log folded twice (above); this
    // is the law for one log's two arrival orders, and it is the same law
    // `reduce.telemetry.test.ts` states for the pair.
    expect(costFirst.telemetry.costs).toEqual(usageFirst.telemetry.costs)
    expect(costFirst.telemetry.lanes).toEqual(usageFirst.telemetry.lanes)
    expect(costFirst.telemetry.sessions).toEqual(usageFirst.telemetry.sessions)
  })

  it('leaves a lane sharing no placed session exactly as bare as it was', () => {
    const state = reduceAll([
      f.llmUsage({ lane: 'placed', sessionId: 'sess-here', worktreePath: WT, branch: 'feature' }, { source: 'sessionlog' }),
      f.llmCost({ lane: 'bare', sessionId: 'sess-elsewhere', worktreePath: null, branch: null }, { source: 'otel' }),
      f.llmUsage({ lane: 'placed', sessionId: 'sess-here', worktreePath: WT, branch: 'feature' }, { source: 'sessionlog' }),
    ])
    expect(state.telemetry.lanes['bare']).toMatchObject({ worktreePath: null, branch: null })
    expect(state.telemetry.costs[0]).toMatchObject({ worktreePath: null, branch: null, placeSource: null })
  })
})

/**
 * #184 gave the trace fold the same treatment #179 gave the usage fold, one
 * lane further on. The line it removed —
 * `{ ...traces.byTrace, [traceId]: [...] }` — copied every key of a Record
 * that gains one per trace, once per span event; standalone it cost 8,866 ms
 * at a 55k-event fold, ~90% of what #179 left behind.
 *
 * Two things replaced it, and the laws below are one per thing:
 *
 * - `byTrace`/`bySession` became a **projection of `spans`**, materialised on
 *   demand ({@link traceStateOf}). So the first law is that the projection is
 *   *exactly* the accumulation it replaced — same keys, same order, same
 *   bytes — checked against the removed line itself, run as a reference
 *   implementation, at every prefix of a log.
 * - The fold's own question ("has this trace already delivered this span id?")
 *   moved to a table carried forward beside the reducer (`TraceIndex` in
 *   `reduce.ts`), derived and identity-keyed. So the rest are #179's laws in
 *   prd9's slice: the fold's output cannot tell whether that table was
 *   inherited or rebuilt, and a table is handed to one future only.
 */
describe('reduce — the trace index is an accelerator, never an input (#184)', () => {
  /**
   * A log that walks every branch of the trace fold several times: many spans
   * in one trace, many traces in one session, a session that owns spans in
   * traces it does not lead, spans with no session at all (indexed by trace
   * and by nothing else), the same span id reused under another trace, and
   * re-deliveries — the branch that takes the table and gives it back without
   * appending — landing both mid-log and last.
   */
  function spanStress(): RhizomorphEvent[] {
    const events: RhizomorphEvent[] = []
    const span = (
      traceId: string,
      spanId: string,
      sessionId: string | null,
      lane = '2-core',
    ): EventOf<'trace.span'> =>
      f.traceSpan({ traceId, spanId, parentSpanId: null, sessionId, lane, worktreePath: WT, branch: 'feature' })

    // One long trace, one session.
    for (let i = 0; i < 6; i += 1) events.push(span('trace-long', `span-long-${i}`, 'sess-a'))
    // The same session spread across traces of its own — the background
    // requests the capture found landing outside the interaction's trace.
    for (let i = 0; i < 4; i += 1) events.push(span(`trace-bg-${i}`, `span-bg-${i}`, 'sess-a'))
    // A second session interleaved into a trace the first one leads.
    events.push(span('trace-long', 'span-shared-b', 'sess-b'))
    // Spans with no session: indexed by trace, absent from `bySession`.
    events.push(span('trace-long', 'span-anon-1', null))
    events.push(span('trace-anon', 'span-anon-2', null, '3-git'))
    // The same span id under another trace is another span (the pair is the
    // identity), and a re-delivery of one that already landed is not.
    events.push(span('trace-other', 'span-long-0', 'sess-b', '3-git'))
    events.push(span('trace-long', 'span-long-0', 'sess-a'))
    // More traffic after the no-op, so a table mishandled there is visible.
    for (let i = 0; i < 3; i += 1) events.push(span('trace-tail', `span-tail-${i}`, 'sess-c'))
    events.push(span('trace-tail', 'span-tail-0', 'sess-c'))
    return events
  }

  /**
   * The line #184 removed, kept here as the oracle it now has to match:
   * `byTrace`/`bySession` accumulated one immutable Record insert at a time,
   * exactly as the fold used to. Nothing here reads the projection.
   */
  function accumulatedTraceIndexes(spans: readonly SpanRecord[]): {
    byTrace: Record<string, number[]>
    bySession: Record<string, number[]>
  } {
    let byTrace: Record<string, number[]> = {}
    let bySession: Record<string, number[]> = {}
    spans.forEach((span, at) => {
      byTrace = { ...byTrace, [span.traceId]: [...(byTrace[span.traceId] ?? []), at] }
      if (span.sessionId !== null) {
        bySession = { ...bySession, [span.sessionId]: [...(bySession[span.sessionId] ?? []), at] }
      }
    })
    return { byTrace, bySession }
  }

  it('projects exactly what the removed accumulation accumulated, at every prefix', () => {
    const events = spanStress()
    for (let cut = 0; cut <= events.length; cut += 1) {
      const traces = reduceAll(events.slice(0, cut)).traces
      const { byTrace, bySession } = accumulatedTraceIndexes(traces.spans)
      // Bytes, not `toEqual`: key order is part of the answer, and it is the
      // half a `Map`-backed rewrite would be most likely to get wrong.
      expect(JSON.stringify(traces.byTrace), `byTrace at ${cut}`).toBe(JSON.stringify(byTrace))
      expect(JSON.stringify(traces.bySession), `bySession at ${cut}`).toBe(JSON.stringify(bySession))
    }
  })

  it('serialises the whole slice to the bytes the accumulating fold wrote', () => {
    const traces = reduceAll(spanStress()).traces
    expect(JSON.stringify(traces)).toBe(
      JSON.stringify({ spans: traces.spans, ...accumulatedTraceIndexes(traces.spans) }),
    )
  })

  /**
   * The same fold with the table defeated: handing `reduce` a *copy* of the
   * spans array every event means the array it is keyed by is one nothing has
   * ever indexed, so every event rebuilds from scratch. If a carried-forward
   * table ever disagreed with a rebuilt one, this is where it would show.
   */
  function foldWithColdIndex(events: readonly RhizomorphEvent[]): SessionState {
    let state = initialSessionState()
    for (const event of events) {
      state = reduce({ ...state, traces: traceStateOf([...state.traces.spans]) }, event)
    }
    return state
  }

  it('folds to the same bytes whether its table is carried forward or rebuilt every event', () => {
    const events = spanStress()
    expect(JSON.stringify(foldWithColdIndex(events))).toBe(JSON.stringify(reduceAll(events)))
  })

  it('hands its table to one future only — two folds off one state stay independent', () => {
    const events = spanStress()
    const base = reduceAll(events)

    // Two futures of one past, and they collide on purpose: `left` is a span
    // the base already holds (a re-delivery, which folds to nothing) and
    // `right` is a new span in the same trace. Neither may see the other's
    // table, and taking one future must not spend the past's.
    const left = f.traceSpan({ traceId: 'trace-long', spanId: 'span-long-0', parentSpanId: null, sessionId: 'sess-a' })
    const right = f.traceSpan({ traceId: 'trace-long', spanId: 'span-fork', parentSpanId: null, sessionId: 'sess-a' })

    const viaLeft = reduce(base, left)
    const viaRight = reduce(base, right)
    const rightAgain = reduce(base, right)

    expect(JSON.stringify(viaLeft)).toBe(JSON.stringify(reduceAll([...events, left])))
    expect(JSON.stringify(viaRight)).toBe(JSON.stringify(reduceAll([...events, right])))
    expect(JSON.stringify(rightAgain)).toBe(JSON.stringify(viaRight))

    // Said as facts too: the re-delivery appended nothing and kept the very
    // same array, the new span appended exactly one.
    expect(viaLeft.traces.spans).toBe(base.traces.spans)
    expect(viaRight.traces.spans).toHaveLength(base.traces.spans.length + 1)
    expect(viaRight.traces.byTrace['trace-long']?.length).toBe(
      (base.traces.byTrace['trace-long'] as number[]).length + 1,
    )
  })

  /**
   * The staleness law, and the reason the projection is computed from `spans`
   * rather than from the fold's own table: that table is mutable and moves on
   * with the fold, so a slice reading it would answer for a future its spans
   * never saw. An index carried as a live, shared object fails the same way,
   * which is what the second half is for — a past whose indexes nobody had
   * asked for until *after* the future's had been read is where a shared one
   * shows, and reading the past first would hide it behind its own memo.
   */
  it('answers for the spans it holds, never for the spans a later fold added', () => {
    const events = spanStress()
    const later = f.traceSpan({
      traceId: 'trace-later',
      spanId: 'span-later',
      parentSpanId: null,
      sessionId: 'sess-a',
    })

    const past = reduceAll(events)
    const expected = JSON.stringify(past.traces)
    const future = reduce(past, later)
    expect(JSON.stringify(future.traces)).not.toBe(expected)
    expect(JSON.stringify(past.traces)).toBe(expected)

    // The same two states, read in the order that hides nothing: the future
    // first, the past never until now.
    const unread = reduceAll(events)
    const grown = reduce(unread, later)
    expect(JSON.stringify(grown.traces)).toBe(JSON.stringify(future.traces))
    expect(JSON.stringify(unread.traces)).toBe(expected)
  })

  it('keeps re-delivery keyed on the pair, and keyed on it after the reshape', () => {
    const state = reduceAll([
      f.traceSpan({ traceId: 'trace-a', spanId: 'span-1', parentSpanId: null, sessionId: 'sess-a' }),
      f.traceSpan({ traceId: 'trace-b', spanId: 'span-1', parentSpanId: null, sessionId: 'sess-a' }),
      f.traceSpan({ traceId: 'trace-a', spanId: 'span-1', parentSpanId: null, sessionId: 'sess-a' }),
    ])
    expect(state.traces.spans).toHaveLength(2)
    expect(state.traces.byTrace).toEqual({ 'trace-a': [0], 'trace-b': [1] })
    expect(state.traces.bySession).toEqual({ 'sess-a': [0, 1] })
    // The event still happened; it is the span that is not duplicated.
    expect(state.eventCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// prd17 ruling 3, item 3 — the upcast chokepoint
// ---------------------------------------------------------------------------

/**
 * The LIVE path's fold, spelled exactly as the live stream spells it: one
 * `reduce(state, event)` per arrival, in arrival order, no sorting
 * (`packages/web/src/app/streamState.ts`, and the server recorder's own fold).
 */
function foldLive(events: readonly RhizomorphEvent[]): SessionState {
  let state = initialSessionState()
  for (const event of events) state = reduce(state, event)
  return state
}

/**
 * The REPLAY path's fold, spelled exactly as replay spells it: `ts`-ascending
 * first, then folded (`packages/web/src/replay/replayFold.ts`'s `sortEvents`
 * feeding `buildSessionIndex`/`foldFrom`).
 */
function foldReplay(events: readonly RhizomorphEvent[]): SessionState {
  return reduceAll([...events].sort((a, b) => a.ts - b.ts))
}

describe('reduce — every event flows through upcast(), in both paths (prd17 ruling 3.3)', () => {
  /** Installs the observer and always disposes it, so a leak can't reach the next test. */
  function watching<T>(body: (seen: RhizomorphEvent[]) => T): { seen: RhizomorphEvent[]; result: T } {
    const seen: RhizomorphEvent[] = []
    const dispose = observeUpcast((event) => seen.push(event))
    try {
      return { seen, result: body(seen) }
    } finally {
      dispose()
    }
  }

  const log = (): RhizomorphEvent[] => [
    f.sessionStarted({}, { ts: 3_000 }),
    f.paneActivity({ paneId: '%1', contentHash: 'h1' }, { ts: 1_000 }),
    f.agentStatus({ handle: 'a', status: 'working' }, { ts: 2_000 }),
  ]

  it('is an identity function — it returns the very event it was handed', () => {
    const event = f.sessionStarted()
    expect(upcast(event)).toBe(event)
  })

  it('the LIVE fold puts every event through it, in arrival order', () => {
    const events = log()
    const { seen } = watching(() => foldLive(events))
    expect(seen).toEqual(events)
    expect(seen.map((event) => event.id)).toEqual(events.map((event) => event.id))
  })

  it('the REPLAY fold puts every event through it, in ts order', () => {
    const events = log()
    const sorted = [...events].sort((a, b) => a.ts - b.ts)
    const { seen } = watching(() => foldReplay(events))
    expect(seen).toEqual(sorted)
  })

  it('reduceAll routes through it too — no fold shape bypasses the chokepoint', () => {
    const events = log()
    const { seen } = watching(() => reduceAll(events))
    expect(seen).toHaveLength(events.length)
  })

  it('is reached once per event, not once per fold — a 40-event log upcasts 40 times', () => {
    const events = Array.from({ length: 40 }, (_, at) =>
      f.paneActivity({ paneId: `%${at}`, contentHash: `h${at}` }),
    )
    const { seen } = watching(() => foldLive(events))
    expect(seen).toHaveLength(40)
  })

  it('refuses a second observer rather than shadowing the first', () => {
    const dispose = observeUpcast(() => {})
    try {
      expect(() => observeUpcast(() => {})).toThrow(/already has an observer/)
    } finally {
      dispose()
    }
  })

  it('leaves the fold untouched — observing it cannot change what it folds', () => {
    const events = log()
    const watched = watching(() => foldLive(events)).result
    expect(JSON.stringify(foldLive(events))).toBe(JSON.stringify(watched))
  })
})

// ---------------------------------------------------------------------------
// prd17 ruling 3, item 4 — the fold-order law
// ---------------------------------------------------------------------------

/**
 * THE FOLD-ORDER LAW, and the divergence it found.
 *
 * The systems chair's verified finding: **live folds arrival order while replay
 * folds `ts`-sorted, through an order-sensitive reducer.** This block is the
 * fixture that pins what each path does today. It does not change either one.
 *
 * The reducer is order-sensitive in three distinct ways, each exercised below:
 * last-write-wins on a keyed record (`agent.status`), create-vs-delete on a key
 * (`branch.updated` / `branch.removed`), and first-sighting sequence
 * (`commitOrder`, `firstEventTs`). For a log whose own append order disagrees
 * with its timestamps — which real logs do, see `foldOrderEvidence` below —
 * the two paths therefore fold the SAME log to DIFFERENT state.
 *
 * **What order is the reducer owed?** The repo has already written this down
 * once, for the merge: `docs/record-format.md` says "order per-actor
 * append-only … never reorder two events that came from the *same* actor
 * relative to each other — even if that actor's own timestamps aren't perfectly
 * monotonic (collectors can report a source's own clock, and a tail line can
 * occasionally be older than the line above it)". By that law the log's own
 * append order is the truth and replay's `ts`-sort violates it.
 *
 * That is a ruling to make, not a change to smuggle in here: `sortEvents` also
 * feeds the scrubber's binary search (`boundaryIndex`), which *requires* a
 * `ts`-ascending array, so honouring append order in replay is a change to how
 * scrubbing addresses time, not a one-line swap. This lane therefore documents
 * and pins the divergence and prints `BLOCKED` for the conductor, per the
 * issue's own instruction.
 */
describe('reduce — the fold-order law: what order is the reducer owed? (prd17 ruling 3.4)', () => {
  /**
   * One log whose ARRIVAL order deliberately disagrees with its TIMESTAMP order
   * — the shape `packages/server/src/log/session-log.ts` warns about, where a
   * tailed line can be older than the line above it.
   */
  function interleaved(): RhizomorphEvent[] {
    return [
      f.sessionStarted({}, { ts: 2_000 }),
      // Last-write-wins on one key, the two writes out of order.
      f.agentStatus({ handle: 'a', status: 'working' }, { ts: 5_000 }),
      f.agentStatus({ handle: 'a', status: 'done' }, { ts: 3_000 }),
      // Create-then-delete vs delete-then-create on one key.
      f.branchUpdated({ branch: 'lane-a', head: 'sha-a' }, { ts: 6_000 }),
      f.branchRemoved({ branch: 'lane-a' }, { ts: 4_000 }),
      // First-sighting sequence.
      f.commitLanded({ sha: 'sha-2', branch: 'main' }, { ts: 8_000 }),
      f.commitLanded({ sha: 'sha-1', branch: 'main' }, { ts: 7_000 }),
      // Order-independent arithmetic, for the invariants below.
      f.llmUsage({ lane: 'a', requestId: 'req-1' }, { ts: 9_000 }),
      f.llmUsage({ lane: 'a', requestId: 'req-2' }, { ts: 1_000 }),
    ]
  }

  it('the fixture really is interleaved — this whole block is vacuous otherwise', () => {
    const events = interleaved()
    const arrival = events.map((event) => event.ts)
    const sorted = [...arrival].sort((a, b) => a - b)
    expect(arrival).not.toEqual(sorted)
  })

  describe('what BOTH paths owe — no ordering may change these', () => {
    it('counts every event exactly once', () => {
      const events = interleaved()
      expect(foldLive(events).eventCount).toBe(events.length)
      expect(foldReplay(events).eventCount).toBe(events.length)
    })

    it('reports the same last-seen timestamp — a max, not a sequence', () => {
      const events = interleaved()
      expect(foldLive(events).lastEventTs).toBe(9_000)
      expect(foldReplay(events).lastEventTs).toBe(9_000)
    })

    it('holds the same set of commits, whatever order they were sighted in', () => {
      const events = interleaved()
      expect(Object.keys(foldLive(events).commits).sort()).toEqual(['sha-1', 'sha-2'])
      expect(Object.keys(foldReplay(events).commits).sort()).toEqual(['sha-1', 'sha-2'])
    })

    it('counts the same tokens — spend is a sum, and a sum has no order', () => {
      const events = interleaved()
      const tokensOf = (state: SessionState) =>
        state.telemetry.usage.reduce((sum, record) => sum + record.totalTokens, 0)
      expect(tokensOf(foldLive(events))).toBe(tokensOf(foldReplay(events)))
      expect(tokensOf(foldLive(events))).toBeGreaterThan(0)
    })
  })

  describe('where the two paths DIVERGE today — pinned, not fixed (see BLOCKED)', () => {
    it('disagrees about a keyed record\'s latest value: live takes the last ARRIVAL, replay the latest TIMESTAMP', () => {
      const events = interleaved()
      // Live: `working` then `done` arrived, so `done` is the last write.
      expect(foldLive(events).agents.a?.status).toBe('done')
      expect(foldLive(events).agents.a?.previousStatus).toBe('working')
      // Replay: sorted, `done` (ts 3000) precedes `working` (ts 5000).
      expect(foldReplay(events).agents.a?.status).toBe('working')
      expect(foldReplay(events).agents.a?.previousStatus).toBe('done')
    })

    it('disagrees about whether a branch still EXISTS — the sharpest form of the divergence', () => {
      const events = interleaved()
      // Live: created, then removed. Gone.
      expect(foldLive(events).branches['lane-a']).toBeUndefined()
      // Replay: the removal sorts FIRST and no-ops on a branch that isn't there
      // yet; the update then creates it. Present, with a head.
      expect(foldReplay(events).branches['lane-a']?.head).toBe('sha-a')
    })

    it('disagrees about the commit ticker\'s order', () => {
      const events = interleaved()
      expect(foldLive(events).commitOrder).toEqual(['sha-2', 'sha-1'])
      expect(foldReplay(events).commitOrder).toEqual(['sha-1', 'sha-2'])
    })

    it('disagrees about when the session began: live takes the first ARRIVAL, replay the earliest TIMESTAMP', () => {
      const events = interleaved()
      expect(foldLive(events).firstEventTs).toBe(2_000)
      expect(foldReplay(events).firstEventTs).toBe(1_000)
    })

    it('so the two paths fold one log to two different states — stated once, plainly', () => {
      const events = interleaved()
      expect(JSON.stringify(foldLive(events))).not.toBe(JSON.stringify(foldReplay(events)))
    })
  })

  describe('this is not a synthetic worry — a REAL recording diverges too', () => {
    /**
     * The era-1 corpus recording (`eras/era-1/recording.jsonl`) is a contiguous
     * slice of a log this instrument actually wrote, and it is not monotonic in
     * `ts`: a `sessionlog` tail line lands beside a `tmux` poll seconds older.
     * So the divergence above is what the live dashboard and a replay of the
     * same recording ALREADY disagree about, today, on real data.
     */
    const recording = eraCorpusEntry('era-1').recordingText

    it('era-1 is genuinely out of order in its own log', () => {
      const { events } = foldEraRecording(recording)
      const arrival = events.map((event) => event.ts)
      expect(arrival).not.toEqual([...arrival].sort((a, b) => a - b))
    })

    it('and the two paths fold it to two different states', () => {
      const { events } = foldEraRecording(recording)
      expect(canonicalStateJson(foldLive(events))).not.toBe(canonicalStateJson(foldReplay(events)))
    })

    it('the committed era snapshot is the LOG ORDER fold — the corpus takes no side the ruling has not taken', () => {
      const { events, state } = foldEraRecording(recording)
      expect(canonicalStateJson(state)).toBe(canonicalStateJson(foldLive(events)))
    })
  })
})
