import { beforeEach, describe, expect, it } from 'vitest'
import { eraCorpusEntry } from './eras/corpus.js'
import { canonicalStateJson, foldEraRecording } from './eras/fold.js'
import type { EventOf, PayloadOf, RhizomorphEvent } from './events/index.js'
import { createEventFactory, fixtureSession } from './fixtures.js'
import { reduce, reduceAll } from './reduce.js'
import type { SessionState, SpanRecord } from './state.js'
import {
  armKey,
  initialCheckpointState,
  initialCommitsState,
  initialForkState,
  initialJudgeState,
  initialRefusalState,
  initialSessionState,
  initialTelemetryState,
  initialTraceState,
  MAX_ERRORS,
  refusalIndexOf,
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
      commits: initialCommitsState(),
      panes: {},
      agents: {},
      collectors: {},
      errors: [],
      telemetry: initialTelemetryState(),
      traces: initialTraceState(),
      checkpoints: initialCheckpointState(),
      forks: initialForkState(),
      judge: initialJudgeState(),
      refusals: initialRefusalState(),
      declared: {},
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
    expect(state.errors[0]).toMatchObject({ collector: 'git', message: 'boom', detail: 'exit 128', count: 1 })
    expect(state.errors[1]?.detail).toBeNull()
    expect(state.errors[1]?.count).toBe(1)
  })

  it('folds a coalesced count into errorCount, not one per recorded event', () => {
    const state = reduceAll([
      f.collectorError({ collector: 'otel', message: 'malformed OTLP request body', count: 12 }, { ts: 10 }),
      f.collectorError({ collector: 'otel', message: 'malformed OTLP request body', count: 5 }, { ts: 20 }),
    ])
    expect(state.collectors['otel']).toMatchObject({ errorCount: 17 })
    // The event log still records one row per recorded event, not per occurrence.
    expect(state.errors).toHaveLength(2)
  })

  it("carries a coalesced event's own count onto its ErrorRecord too — the same fact errorCount folds, one layer up (#588)", () => {
    // #530 fixed exactly this asymmetry one layer down (errorCount); this
    // pins that ErrorRecord — the record `state.errors` actually holds, and
    // what a future reader of that list would render — doesn't repeat it.
    const state = reduceAll([
      f.collectorError({ collector: 'otel', message: 'malformed OTLP request body', count: 12 }, { ts: 10 }),
      f.collectorError({ collector: 'otel', message: 'malformed OTLP request body', count: 5 }, { ts: 20 }),
    ])
    expect(state.errors[0]?.count).toBe(12)
    expect(state.errors[1]?.count).toBe(5)
    // Mirrors RefusalRecord.count's own shape exactly, not a lookalike field.
    expect(state.errors[0]).toHaveProperty('count', 12)
  })

  it('keeps counting as one for an emitter that never coalesces and carries no count', () => {
    const state = reduceAll([f.collectorError({ collector: 'git', message: 'boom' }, { ts: 10 })])
    expect(state.collectors['git']?.errorCount).toBe(1)
    expect(state.errors[0]?.count).toBe(1)
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

/**
 * #592 — THE ROTATION BOUNDARY.
 *
 * The operator pressed **end session · start fresh**, the recorder closed one
 * log and opened another, `/api/stream` duly began delivering the new
 * session's events — and the instrument carried on exactly as before: the
 * scene did not change, the elapsed figures did not reset, a refresh changed
 * nothing. One cause: `session.started` for a DIFFERENT session was folded as
 * nothing but a new value for `state.session`, so the whole of the ended
 * recording stayed underneath it and every "elapsed" figure went on being
 * measured from the session the operator had just ended.
 *
 * 5,200 passing tests did not catch it, because every one of them folds a
 * single session. This block folds two.
 *
 * It lives here, on `reduce`, rather than in the web shell, because ADR-0002
 * says one reducer serves both live and replay: a fix spelled in
 * `StreamContext` would have been true of the live stream and false of a
 * replayed log carrying the same boundary. `packages/web/src/replay/
 * replayFold.test.ts` proves the replay half over this same shape.
 */
describe('reduce — a new session.started is a new recording (#592)', () => {
  const FIRST = 'session-one'
  const SECOND = 'session-two'

  /**
   * A session with a fact in every slice the fold carries, so a reset that
   * missed one says which. Deliberately not `fixtureSession()`: this has to
   * reach the telemetry, trace, lab, judge and refusal slices too, which are
   * exactly the ones a partial reset would leave behind.
   */
  function busySession(sessionId: string): RhizomorphEvent[] {
    const g = createEventFactory({ idPrefix: sessionId, startTs: 1_000, stepMs: 10 })
    g.sessionStarted({ sessionId, repoPath: REPO, repoName: 'rhizomorph', mainBranch: 'trunk' })
    g.worktreeDiscovered({ path: WT, branch: 'feature', head: 'sha-1', isMain: false })
    g.worktreeDirty({ path: WT, branch: 'feature', files: [{ path: 'a.ts', status: 'modified' }] })
    g.branchUpdated({ branch: 'feature', head: 'sha-1' })
    g.commitLanded({ sha: 'sha-1', branch: 'feature', message: 'work' })
    g.paneDiscovered({ paneId: '%1', windowName: 'feature', currentPath: WT })
    g.paneActivity({ paneId: '%1', contentHash: 'hash-1' })
    g.agentStatus({ handle: 'lane-a', status: 'working', worktreePath: WT })
    g.collectorError({ collector: 'git', message: 'boom' })
    g.llmUsage({ lane: 'lane-a', sessionId, requestId: 'req-1' })
    g.llmCost({ lane: 'lane-a', sessionId, requestId: 'req-1' })
    g.toolActivity({ lane: 'lane-a', tool: 'Bash', sessionId })
    g.agentActiveTime({ lane: 'lane-a', sessionId, activeSeconds: 12 })
    g.traceSpan({ lane: 'lane-a', traceId: 'trace-1', spanId: 'span-1', sessionId })
    g.forkCheckpoint({ lane: 'lane-a', checkpointId: 'cp-1' })
    g.forkDispatched({ forkId: 'fork-1', parentLane: 'lane-a', checkpointId: 'cp-1', laneHandle: 'arm-1' })
    g.judgeFinding({ lanes: ['arm-1', 'lane-a'] })
    g.make('telemetry.refused', { instance: 'somebody-else', expectedInstance: sessionId, count: 1 })
    return g.all()
  }

  const first = busySession(FIRST)
  const opensSecond = createEventFactory({ idPrefix: SECOND, startTs: 9_000 }).sessionStarted({
    sessionId: SECOND,
    repoPath: REPO,
    repoName: 'rhizomorph',
    mainBranch: 'trunk',
  })

  it('the fixture really does fill every slice — this block is vacuous otherwise', () => {
    const folded = reduceAll(first)
    expect(Object.keys(folded.worktrees).length).toBeGreaterThan(0)
    expect(Object.keys(folded.branches).length).toBeGreaterThan(0)
    expect(folded.commits.order.length).toBeGreaterThan(0)
    expect(Object.keys(folded.panes).length).toBeGreaterThan(0)
    expect(Object.keys(folded.agents).length).toBeGreaterThan(0)
    expect(Object.keys(folded.collectors).length).toBeGreaterThan(0)
    expect(folded.errors.length).toBeGreaterThan(0)
    expect(folded.telemetry.usage.length).toBeGreaterThan(0)
    expect(folded.telemetry.costs.length).toBeGreaterThan(0)
    expect(folded.telemetry.tools.length).toBeGreaterThan(0)
    expect(folded.telemetry.activeTime.length).toBeGreaterThan(0)
    expect(folded.traces.spans.length).toBeGreaterThan(0)
    expect(folded.checkpoints.records.length).toBeGreaterThan(0)
    expect(folded.forks.dispatches.length).toBeGreaterThan(0)
    expect(folded.judge.findings.length).toBeGreaterThan(0)
    expect(folded.refusals.records.length).toBeGreaterThan(0)
  })

  /**
   * THE TEST THIS ISSUE IS FOR: the state is CLEARED, not merged — stated as
   * an identity against a fold of the boundary event alone, so there is no
   * slice a future addition can quietly leave behind. A per-slice assertion
   * list would only ever cover the slices that existed when it was written.
   */
  it('folding it over an existing session clears the state rather than merging into it', () => {
    const after = reduce(reduceAll(first), opensSecond)

    expect(after).toEqual(reduceAll([opensSecond]))
    // …and said the same way round, so a reader does not have to unpack the
    // identity to see what it means.
    expect(after.session?.sessionId).toBe(SECOND)
    expect(after.worktrees).toEqual({})
    expect(after.branches).toEqual({})
    expect(after.commits.order).toEqual([])
    expect(after.panes).toEqual({})
    expect(after.agents).toEqual({})
    expect(after.collectors).toEqual({})
    expect(after.errors).toEqual([])
    expect(after.telemetry).toEqual(initialTelemetryState())
    expect(after.traces.spans).toEqual([])
    expect(after.checkpoints).toEqual(initialCheckpointState())
    expect(after.forks).toEqual(initialForkState())
    expect(after.judge).toEqual(initialJudgeState())
    expect(after.refusals).toEqual(initialRefusalState())
    // Not one trace of the ended recording is left anywhere, under any key.
    expect(JSON.stringify(after)).not.toContain(FIRST)
  })

  it('restarts the elapsed figures from the new recording, counting its own first event', () => {
    const before = reduceAll(first)
    const after = reduce(before, opensSecond)

    // The fixture really did accumulate a span, so this is not vacuous.
    expect(before.eventCount).toBe(first.length)
    expect(before.firstEventTs).toBe(1_000)

    expect(after.eventCount).toBe(1)
    expect(after.firstEventTs).toBe(opensSecond.ts)
    expect(after.lastEventTs).toBe(opensSecond.ts)
    expect(after.session?.startedAt).toBe(opensSecond.ts)
  })

  it('relearns the main branch from the new recording rather than inheriting it', () => {
    const before = reduceAll([
      ...busySession(FIRST),
      // The main worktree is the authority on what "main" means (`sessionStarted`
      // and `worktreeDiscovered` both write it).
      createEventFactory({ idPrefix: 'main', startTs: 5_000 }).worktreeDiscovered({
        path: REPO,
        branch: 'ancient-main',
        head: 'sha-0',
        isMain: true,
      }),
    ])
    expect(before.mainBranch).toBe('ancient-main')

    const nameless = createEventFactory({ idPrefix: 'nameless', startTs: 9_000 }).sessionStarted({
      sessionId: SECOND,
      repoPath: REPO,
      repoName: 'rhizomorph',
      mainBranch: null,
    })
    expect(reduce(before, nameless).mainBranch).toBeNull()
  })

  /**
   * The eager-reset direction is the dangerous one — a reconnect that wiped
   * good state would be a worse instrument than the bug being fixed. The
   * server honestly falls back to replaying a whole session when its buffer
   * never held the client's `Last-Event-ID`, which re-emits `session.started`
   * for the SAME session.
   */
  it('does NOT reset when the same session.started is folded again — a reconnect replay', () => {
    const once = reduceAll(first)
    const twice = reduce(once, first[0] as RhizomorphEvent)

    expect(Object.keys(twice.worktrees)).toEqual(Object.keys(once.worktrees))
    expect(twice.commits.order).toEqual(once.commits.order)
    expect(twice.telemetry.usage.length).toBe(once.telemetry.usage.length)
    // Absorbed the replay rather than restarting on it.
    expect(twice.eventCount).toBe(once.eventCount + 1)
  })

  it('does NOT reset on the first session.started of a fresh fold — nothing to contradict', () => {
    const folded = reduceAll(first)
    expect(folded.eventCount).toBe(first.length)
    expect(Object.keys(folded.worktrees)).toEqual([WT])
  })

  /**
   * The sibling case the repo boundary already had (#390) and this predicate
   * must keep: a `session.started` naming a different REPO is a boundary even
   * if the session id somehow matched. Not reachable through today's server —
   * every retarget mints a new session id — which is exactly why it is pinned
   * rather than assumed.
   */
  it('is also a boundary when the repo changes, whatever the session id says', () => {
    const before = reduceAll(first)
    const elsewhere = createEventFactory({ idPrefix: 'elsewhere', startTs: 9_000 }).sessionStarted({
      sessionId: FIRST,
      repoPath: '/repos/somewhere-else',
      repoName: 'somewhere-else',
    })
    const after = reduce(before, elsewhere)

    expect(after.worktrees).toEqual({})
    expect(after.session?.repoPath).toBe('/repos/somewhere-else')
  })

  it('a mid-log boundary folds the same whether reduceAll runs it or reduce one at a time', () => {
    const log = [...first, opensSecond, ...busySession(SECOND).slice(1)]
    expect(reduceAll(log)).toEqual(log.reduce(reduce, initialSessionState()))
  })

  /**
   * The mutation this block would not survive without: with the reset removed,
   * the fold of a two-session log is NOT the fold of its second session alone.
   * Stated as a property rather than left implicit, because "cleared, not
   * merged" is only meaningful against a log that genuinely carried a past.
   */
  it('a two-session log folds to exactly what its second session folds to alone', () => {
    const second = busySession(SECOND)
    const both = reduceAll([...first, ...second])
    const alone = reduceAll(second)

    // `firstEventTs`/`lastEventTs` come from the same events either way,
    // because `busySession` stamps both sessions from the same clock — so the
    // states are comparable whole, not field by field.
    expect(canonicalStateJson(both)).toBe(canonicalStateJson(alone))
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

describe('worktree.dirtyStatusFailed / worktree.dirtyStatusRecovered', () => {
  const WT_A = `${REPO}-wt/lane-a`
  const WT_B = `${REPO}-wt/lane-b`

  it('opens an incident on a discovered worktree', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: WT, branch: 'feature', isMain: false }, { ts: 100 }),
      f.worktreeDirtyStatusFailed(
        { worktreePath: WT, consecutiveFailures: 4, message: 'error: could not read index' },
        { ts: 500 },
      ),
    ])
    expect(state.worktrees[WT]?.dirtyStatusFailedSince).toBe(500)
  })

  it('closes an open incident', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: WT, branch: 'feature', isMain: false }, { ts: 100 }),
      f.worktreeDirtyStatusFailed({ worktreePath: WT }, { ts: 500 }),
      f.worktreeDirtyStatusRecovered({ worktreePath: WT }, { ts: 700 }),
    ])
    expect(state.worktrees[WT]?.dirtyStatusFailedSince).toBeNull()
  })

  it('stubs an undiscovered worktree rather than throwing', () => {
    const state = reduce(
      initialSessionState(),
      f.worktreeDirtyStatusFailed({ worktreePath: WT, consecutiveFailures: 4 }, { ts: 500 }),
    )
    expect(state.worktrees[WT]).toMatchObject({
      path: WT,
      present: true,
      dirtyStatusFailedSince: 500,
    })
  })

  it('is a no-op recovering a path never discovered', () => {
    const before = initialSessionState()
    const after = reduce(before, f.worktreeDirtyStatusRecovered({ worktreePath: '/nope' }))
    expect(after.worktrees).toEqual({})
  })

  it('is idempotent: repeated recoveries stay null, repeated failures last-write-win', () => {
    let state = reduceAll([
      f.worktreeDiscovered({ path: WT, branch: 'feature', isMain: false }, { ts: 100 }),
      f.worktreeDirtyStatusRecovered({ worktreePath: WT }, { ts: 200 }),
      f.worktreeDirtyStatusRecovered({ worktreePath: WT }, { ts: 201 }),
    ])
    expect(state.worktrees[WT]?.dirtyStatusFailedSince).toBeNull()

    state = reduceAll([
      f.worktreeDiscovered({ path: WT, branch: 'feature', isMain: false }, { ts: 100 }),
      f.worktreeDirtyStatusFailed({ worktreePath: WT }, { ts: 300 }),
      f.worktreeDirtyStatusFailed({ worktreePath: WT }, { ts: 400 }),
    ])
    expect(state.worktrees[WT]?.dirtyStatusFailedSince).toBe(400)
  })

  it("the #429 law: one worktree's recovery cannot mask a sibling's still-open incident", () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: WT_A, branch: 'lane-a', isMain: false }, { ts: 100 }),
      f.worktreeDiscovered({ path: WT_B, branch: 'lane-b', isMain: false }, { ts: 100 }),
      f.worktreeDirtyStatusFailed({ worktreePath: WT_A, consecutiveFailures: 4 }, { ts: 500 }),
      f.worktreeDirtyStatusFailed({ worktreePath: WT_B, consecutiveFailures: 4 }, { ts: 600 }),
      f.worktreeDirtyStatusRecovered({ worktreePath: WT_A }, { ts: 700 }),
    ])
    expect(state.worktrees[WT_A]?.dirtyStatusFailedSince).toBeNull()
    expect(state.worktrees[WT_B]?.dirtyStatusFailedSince).toBe(600)
  })

  it('never touches CollectorState', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: WT_A, branch: 'lane-a', isMain: false }, { ts: 100 }),
      f.worktreeDiscovered({ path: WT_B, branch: 'lane-b', isMain: false }, { ts: 100 }),
      f.worktreeDirtyStatusFailed({ worktreePath: WT_A }, { ts: 500 }),
      f.worktreeDirtyStatusFailed({ worktreePath: WT_B }, { ts: 600 }),
      f.worktreeDirtyStatusRecovered({ worktreePath: WT_A }, { ts: 700 }),
    ])
    expect(state.collectors).toEqual({})
  })

  it('worktreeRemoved clears an open incident', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: WT, branch: 'feature', isMain: false }, { ts: 100 }),
      f.worktreeDirtyStatusFailed({ worktreePath: WT }, { ts: 500 }),
      f.worktreeRemoved({ path: WT }, { ts: 900 }),
    ])
    expect(state.worktrees[WT]?.dirtyStatusFailedSince).toBeNull()
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
    expect(state.commits.order).toEqual(['c1', 'c2'])
    expect(state.branches['feature']?.commits).toEqual(['c1', 'c2'])
    expect(state.commits.bySha['c1']).toMatchObject({
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
    expect(state.commits.bySha['c1']).toMatchObject({ authoredAt: 5, landedAt: 900 })
  })

  it('adds a branch to an existing commit when the same sha lands again', () => {
    const state = reduceAll([
      f.commitLanded({ sha: 'c1', branch: 'feature' }, { ts: 10 }),
      f.commitLanded({ sha: 'c1', branch: 'main' }, { ts: 20 }),
      f.commitLanded({ sha: 'c1', branch: 'main' }, { ts: 30 }),
    ])
    expect(state.commits.bySha['c1']?.branches).toEqual(['feature', 'main'])
    expect(state.commits.bySha['c1']?.landedAt).toBe(10)
    expect(state.commits.order).toEqual(['c1'])
    expect(state.branches['main']?.commits).toEqual(['c1'])
  })

  it('does not lose a known file list to a later fileless sighting', () => {
    const state = reduceAll([
      f.commitLanded({ sha: 'c1', branch: 'feature', files: [{ path: 'a.ts', status: 'added' }] }),
      f.commitLanded({ sha: 'c1', branch: 'main', files: [] }),
    ])
    expect(state.commits.bySha['c1']?.files).toEqual([{ path: 'a.ts', status: 'added' }])
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
    expect(state.commits.bySha['c1']).toMatchObject({ sha: 'c1', branches: ['feature'] })
    expect(state.commits.order).toEqual(['c1'])
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
      f.paneActivity({ paneId: '%1', contentHash: 'h1' }, { ts: 200 }),
      f.paneActivity({ paneId: '%1', contentHash: 'h2' }, { ts: 300 }),
    ])
    expect(state.panes['%1']).toMatchObject({
      contentHash: 'h2',
      lastActivityTs: 300,
      lastContentChangeTs: 300,
      activityCount: 2,
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
      present: true,
      removedAt: null,
      witness: 'workmux',
      dissent: null,
    })
  })

  it('marks a removed agent absent, keeping its last-known fields', () => {
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'working', worktreePath: WT, branch: 'feature' }, { ts: 10 }),
      f.agentRemoved({ handle: 'feature' }, { ts: 300 }),
    ])
    expect(state.agents['feature']).toMatchObject({
      present: false,
      removedAt: 300,
      // The last-known status/branch/worktree survive removal for replay.
      status: 'working',
      worktreePath: WT,
      branch: 'feature',
    })
  })

  it('ignores removal of an agent handle it never saw', () => {
    const before = initialSessionState()
    const after = reduce(before, f.agentRemoved({ handle: 'nope' }))
    expect(after.agents).toEqual({})
  })

  it('is idempotent on a repeat removal — removedAt stays pinned to the first', () => {
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'working' }, { ts: 10 }),
      f.agentRemoved({ handle: 'feature' }, { ts: 300 }),
      f.agentRemoved({ handle: 'feature' }, { ts: 400 }),
    ])
    expect(state.agents['feature']).toMatchObject({ present: false, removedAt: 300 })
  })

  it('re-appearance after removal resets present and clears removedAt', () => {
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'working' }, { ts: 10 }),
      f.agentRemoved({ handle: 'feature' }, { ts: 300 }),
      f.agentStatus({ handle: 'feature', status: 'working' }, { ts: 400 }),
    ])
    expect(state.agents['feature']).toMatchObject({ present: true, removedAt: null, updatedAt: 400 })
  })

  // ── the second witness (#281, ADR-0037) ───────────────────────────────────
  //
  // prd-27 ruling 2 gives `agent.status` two legitimate signers, and ruling 4
  // rules what happens when they disagree: a declaration may raise a summons;
  // an inference alone may only withdraw an *inferred* one. That asymmetry is
  // one `if` in `agentStatus`, and `dissent` is the record of what it refused.

  /** The organ's word, signed with its own name rather than workmux's. */
  const organ = (payload: Partial<PayloadOf<'agent.status'>>, ts: number) =>
    f.agentStatus(payload, { ts, source: 'sessionlog' })

  const ORGAN_WORKING = 'WORKING — tail pending-tool, quiet 3s, threshold 30s'

  it('records whose word the status is', () => {
    const declared = reduceAll([f.agentStatus({ handle: 'a', status: 'working' }, { ts: 10 })])
    expect(declared.agents['a']).toMatchObject({ witness: 'workmux', dissent: null })

    const inferred = reduceAll([organ({ handle: 'b', status: 'working' }, 10)])
    expect(inferred.agents['b']).toMatchObject({ witness: 'sessionlog', dissent: null })
  })

  it('an inferred waiting over a declared working is last-wins — the inferred summons is raised', () => {
    // Ruling 4 is one-directional. Nothing was declared waiting here, so the
    // organ raising a hand is new information, not a withdrawal.
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'working' }, { ts: 10 }),
      organ({ handle: 'feature', status: 'waiting' }, 20),
    ])
    expect(state.agents['feature']).toMatchObject({
      status: 'waiting',
      witness: 'sessionlog',
      updatedAt: 20,
      previousStatus: 'working',
      dissent: null,
    })
  })

  it('ruling 4: a sessionlog working does not withdraw a declared waiting, and is kept as dissent', () => {
    // The common case, not an edge: a permission prompt leaves the transcript
    // on a `pending-tool` shape, which the organ reads as `working`, while
    // workmux reads `waiting`. The human was asked by name; the declaration
    // stands, and the refused word is kept so it can be rendered.
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'waiting' }, { ts: 10 }),
      organ({ handle: 'feature', status: 'working', detail: ORGAN_WORKING }, 20),
    ])
    expect(state.agents['feature']).toMatchObject({
      status: 'waiting',
      witness: 'workmux',
      updatedAt: 10,
      dissent: { witness: 'sessionlog', status: 'working', ts: 20, detail: ORGAN_WORKING },
    })
  })

  it('corroboration is not dissent — an agreeing organ does not turn a declaration into an inference', () => {
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'waiting' }, { ts: 10 }),
      organ({ handle: 'feature', status: 'waiting' }, 20),
    ])
    expect(state.agents['feature']).toMatchObject({
      status: 'waiting',
      witness: 'workmux',
      updatedAt: 10,
      dissent: null,
    })
  })

  it('workmux speaking again clears the dissent and wins', () => {
    // When the human answers, workmux says `working` within a poll and the
    // disagreement is over — a declaration always speaks.
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'waiting' }, { ts: 10 }),
      organ({ handle: 'feature', status: 'working', detail: ORGAN_WORKING }, 20),
      f.agentStatus({ handle: 'feature', status: 'working' }, { ts: 30 }),
    ])
    expect(state.agents['feature']).toMatchObject({
      status: 'working',
      witness: 'workmux',
      previousStatus: 'waiting',
      updatedAt: 30,
      dissent: null,
    })
  })

  it('a removed handle re-sighted by sessionlog is last-wins, not ruling 4', () => {
    // The refusal is guarded on `present`: a declaration nobody is standing
    // behind any more cannot outrank a fresh sighting.
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'waiting' }, { ts: 10 }),
      f.agentRemoved({ handle: 'feature' }, { ts: 20 }),
      organ({ handle: 'feature', status: 'working' }, 30),
    ])
    expect(state.agents['feature']).toMatchObject({
      status: 'working',
      witness: 'sessionlog',
      present: true,
      dissent: null,
    })
  })

  it('ruling 4, the sibling: a sessionlog waiting does not resurrect a declared done, and is kept as dissent', () => {
    // The normal sequence for every finished lane in the full rig: workmux
    // declares `done` within a poll of the ✓ title; 75s later the organ reads
    // the quiet, alive session at its prompt as `waiting`. Verify of #281
    // caught the last-wins path turning DONE back into a summons here.
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'done' }, { ts: 10 }),
      organ({ handle: 'feature', status: 'waiting', detail: 'WAITING — tail turn-complete, quiet 75s, threshold 75s' }, 20),
    ])
    expect(state.agents['feature']).toMatchObject({
      status: 'done',
      witness: 'workmux',
      updatedAt: 10,
      dissent: {
        witness: 'sessionlog',
        status: 'waiting',
        ts: 20,
        detail: 'WAITING — tail turn-complete, quiet 75s, threshold 75s',
      },
    })
  })

  it('a sessionlog working over a declared done is dissent too, and workmux speaking again clears it', () => {
    // The human typed a new prompt: the organ sees work before workmux's next
    // poll does. The declaration stands until workmux itself says `working`.
    const refused = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'done' }, { ts: 10 }),
      organ({ handle: 'feature', status: 'working', detail: ORGAN_WORKING }, 20),
    ])
    expect(refused.agents['feature']).toMatchObject({
      status: 'done',
      witness: 'workmux',
      dissent: { witness: 'sessionlog', status: 'working', ts: 20, detail: ORGAN_WORKING },
    })

    const resumed = reduce(refused, f.agentStatus({ handle: 'feature', status: 'working' }, { ts: 30 }))
    expect(resumed.agents['feature']).toMatchObject({
      status: 'working',
      witness: 'workmux',
      previousStatus: 'done',
      updatedAt: 30,
      dissent: null,
    })
  })

  it('only a declared working yields to an inference', () => {
    // The one declared word the organ can improve on: workmux's `working` is
    // a title read once at the turn's start, the organ's `waiting` is the
    // turn's end observed. Every other declared word stands (the two tests
    // above, and the ruling-4 case).
    const state = reduceAll([
      f.agentStatus({ handle: 'feature', status: 'working' }, { ts: 10 }),
      organ({ handle: 'feature', status: 'working' }, 20),
    ])
    expect(state.agents['feature']).toMatchObject({ status: 'working', witness: 'sessionlog', updatedAt: 20, dissent: null })
  })

  it('repetition: the same sessionlog word three times folds to the same state as once', () => {
    const declared = f.agentStatus({ handle: 'feature', status: 'waiting' }, { ts: 10 })
    const once = reduceAll([declared, organ({ handle: 'feature', status: 'working', detail: ORGAN_WORKING }, 20)])
    const thrice = reduceAll([
      declared,
      organ({ handle: 'feature', status: 'working', detail: ORGAN_WORKING }, 20),
      organ({ handle: 'feature', status: 'working', detail: ORGAN_WORKING }, 20),
      organ({ handle: 'feature', status: 'working', detail: ORGAN_WORKING }, 20),
    ])
    expect(thrice.agents).toEqual(once.agents)
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
    expect(state.commits.order).toEqual(['sha-core-1', 'sha-core-2', 'sha-git-1'])
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

  it('indexes the r runs of one arm under one armKey, beside the fork and lane indexes (prd53 ruling 1)', () => {
    const state = reduceAll(
      [1, 2, 3].map((run) =>
        f.forkDispatched(
          { forkId: 'fork-1', arm: 2, run, laneHandle: run === 1 ? 'fork-1-arm-2' : `fork-1-arm-2-run-${run}` },
          { ts: 100 + run },
        ),
      ),
    )
    expect(state.forks.byArm[armKey('fork-1', 2)]).toEqual([0, 1, 2])
    expect(state.forks.byFork['fork-1']).toEqual([0, 1, 2])
    expect(Object.keys(state.forks.byLane)).toHaveLength(3)
    expect(state.forks.dispatches.map((d) => d.run)).toEqual([1, 2, 3])
  })

  it('reads a record written before runs existed as run 1 — the additive convention, not an upcast', () => {
    const state = reduceAll([f.forkDispatched({ forkId: 'fork-1', arm: 1, laneHandle: 'fork-1-arm-1' }, { ts: 100 })])
    expect(state.forks.dispatches[0]?.run).toBe(1)
    expect(state.forks.byArm[armKey('fork-1', 1)]).toEqual([0])
  })

  it('keeps the declared ceiling override on the record, and null — never a default — when none was declared (prd53 ruling 6)', () => {
    const state = reduceAll([
      f.forkDispatched({ forkId: 'fork-1', arm: 1, laneHandle: 'fork-1-arm-1' }, { ts: 100 }),
      f.forkDispatched({ forkId: 'fork-1', arm: 2, laneHandle: 'fork-1-arm-2', ceilingOverride: 12 }, { ts: 101 }),
    ])
    expect(state.forks.dispatches.map((d) => d.ceilingOverride)).toEqual([null, 12])
  })

  describe('fork.measured (prd53 ruling 3 — measuring is a write)', () => {
    it('appends every verdict and indexes the newest per lane — a re-measure supersedes without erasing', () => {
      const state = reduceAll([
        f.forkDispatched({ forkId: 'fork-1', arm: 1, laneHandle: 'fork-1-arm-1' }, { ts: 100 }),
        f.forkMeasured({ forkId: 'fork-1', laneHandle: 'fork-1-arm-1', verified: 'fail', verifiedDetail: '1 failed' }, { ts: 200 }),
        f.forkMeasured({ forkId: 'fork-1', laneHandle: 'fork-1-arm-1', verified: 'pass', verifiedDetail: null }, { ts: 300 }),
      ])
      expect(state.forks.measurements).toHaveLength(2)
      expect(state.forks.measurements.map((m) => m.verified)).toEqual(['fail', 'pass'])
      expect(state.forks.latestOutcomeByLane['fork-1-arm-1']).toBe(1)
      expect(state.forks.measurements[1]).toMatchObject({
        forkId: 'fork-1',
        laneHandle: 'fork-1-arm-1',
        verified: 'pass',
        verifyCommand: 'npm test',
        source: 'measure-route',
        ts: 300,
      })
    })

    it('an unmeasured lane has no entry at all — nothing stands in for a verdict nobody gave', () => {
      const state = reduceAll([f.forkDispatched({ forkId: 'fork-1', arm: 1, laneHandle: 'fork-1-arm-1' }, { ts: 100 })])
      expect(state.forks.measurements).toEqual([])
      expect(Object.hasOwn(state.forks.latestOutcomeByLane, 'fork-1-arm-1')).toBe(false)
    })

    it('leaves the dispatch record exactly as it was — a measurement is about a run, it does not change what the run was', () => {
      const dispatched = reduceAll([f.forkDispatched({ forkId: 'fork-1', arm: 1, laneHandle: 'fork-1-arm-1' }, { ts: 100 })])
      const measured = reduce(dispatched, f.forkMeasured({ forkId: 'fork-1', laneHandle: 'fork-1-arm-1' }, { ts: 200 }))
      expect(measured.forks.dispatches).toEqual(dispatched.forks.dispatches)
      expect(measured.forks.byLane).toEqual(dispatched.forks.byLane)
    })
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
 * THE HOSTILE-KEY LAW, restated for #289's four siblings.
 *
 * `checkpoints.byLane`, `forks.byFork`, `forks.byLane` and `judge.byLane` all
 * had `#283`'s exact bug (`50d85af`): `{ ...index, [key]: [...(index[key] ??
 * []), at] }` reads an INHERITED `Object.prototype` member for `'__proto__'`,
 * `'constructor'`, `'hasOwnProperty'` and `'toString'`, so `?? []` never fires
 * and the spread throws. Every one of these keys is a lane handle or fork id
 * this repo generates today — not attacker-reachable the way the refusal
 * twin's `instance` is — but a lane or fork literally named one of the four
 * would poison the recording forever, the same way a hostile `instance` did.
 *
 * `isSyntheticLane`'s bracket read (`forks.byLane[laneHandle] !== undefined`)
 * was the quieter sibling: not a crash, a silent false positive, since
 * `Object.prototype` is never `undefined` either.
 */
describe('reduce — prototype-hostile keys across the four #283 siblings (#289)', () => {
  const HOSTILE = ['__proto__', 'constructor', 'hasOwnProperty', 'toString'] as const

  for (const key of HOSTILE) {
    it(`checkpoints.byLane folds a checkpoint for lane '${key}' as an ordinary key`, () => {
      const state = reduceAll([
        f.forkCheckpoint({ lane: key, checkpointId: 'ckpt-1' }, { ts: 100 }),
        f.forkCheckpoint({ lane: 'ordinary', checkpointId: 'ckpt-2' }, { ts: 200 }),
        f.forkCheckpoint({ lane: key, checkpointId: 'ckpt-3' }, { ts: 300 }),
      ])
      expect(Object.hasOwn(state.checkpoints.byLane, key)).toBe(true)
      expect(state.checkpoints.byLane[key]).toEqual([0, 2])
      expect(state.checkpoints.byLane.ordinary).toEqual([1])
      expect(Object.getPrototypeOf(state.checkpoints.byLane)).toBe(Object.prototype)
      expect(Object.keys(state.checkpoints.byLane).sort()).toEqual([key, 'ordinary'].sort())
    })

    it(`forks.byFork and forks.byLane fold a dispatch keyed '${key}' as an ordinary key`, () => {
      const state = reduceAll([
        f.forkDispatched({ forkId: key, laneHandle: key }, { ts: 100 }),
        f.forkDispatched({ forkId: 'fork-1', laneHandle: 'fork-1-arm-1' }, { ts: 200 }),
        f.forkDispatched({ forkId: key, laneHandle: key }, { ts: 300 }),
      ])
      expect(Object.hasOwn(state.forks.byFork, key)).toBe(true)
      expect(state.forks.byFork[key]).toEqual([0, 2])
      expect(Object.hasOwn(state.forks.byLane, key)).toBe(true)
      expect(state.forks.byLane[key]).toEqual([0, 2])
      expect(state.forks.byFork['fork-1']).toEqual([1])
      expect(state.forks.byLane['fork-1-arm-1']).toEqual([1])
      expect(Object.getPrototypeOf(state.forks.byFork)).toBe(Object.prototype)
      expect(Object.getPrototypeOf(state.forks.byLane)).toBe(Object.prototype)
      // The sibling read: a lane actually named this hostile key is genuinely
      // synthetic (a dispatch DID name it); an untouched lane must not read
      // as synthetic just because the key coincides with a prototype member.
      expect(state.agents[key]?.synthetic).toBe(true)
    })

    it(`judge.byLane folds a finding naming lane '${key}' as an ordinary key, under both lanes`, () => {
      const lanes = [key, 'ordinary'].sort() as [string, string]
      const state = reduceAll([
        f.judgeFinding({ lanes }, { ts: 100 }),
        f.judgeFinding({ lanes }, { ts: 200 }),
      ])
      expect(Object.hasOwn(state.judge.byLane, key)).toBe(true)
      expect(state.judge.byLane[key]).toEqual([0, 1])
      expect(state.judge.byLane.ordinary).toEqual([0, 1])
      expect(Object.getPrototypeOf(state.judge.byLane)).toBe(Object.prototype)
    })
  }

  it('survives every hostile key in one fold across all three indexes, alongside ordinary ones', () => {
    const state = reduceAll([
      ...HOSTILE.map((key) => f.forkCheckpoint({ lane: key, checkpointId: `ckpt-${key}` })),
      f.forkCheckpoint({ lane: 'ordinary', checkpointId: 'ckpt-ordinary' }),
      ...HOSTILE.map((key) => f.forkDispatched({ forkId: key, laneHandle: key })),
      f.forkDispatched({ forkId: 'fork-1', laneHandle: 'fork-1-arm-1' }),
      ...HOSTILE.map((key) => f.judgeFinding({ lanes: [key, 'ordinary'].sort() as [string, string] })),
    ])
    expect(Object.keys(state.checkpoints.byLane).sort()).toEqual([...HOSTILE, 'ordinary'].sort())
    expect(Object.keys(state.forks.byFork).sort()).toEqual([...HOSTILE, 'fork-1'].sort())
    expect(Object.keys(state.forks.byLane).sort()).toEqual([...HOSTILE, 'fork-1-arm-1'].sort())
    expect(Object.keys(state.judge.byLane).sort()).toEqual([...HOSTILE, 'ordinary'].sort())
    expect(Object.getPrototypeOf(state.checkpoints.byLane)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(state.forks.byFork)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(state.forks.byLane)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(state.judge.byLane)).toBe(Object.prototype)
  })

  it("isSyntheticLane does not read an untouched lane named '__proto__' as synthetic", () => {
    const state = reduceAll([
      f.forkDispatched({ forkId: 'fork-1', laneHandle: 'fork-1-arm-1' }, { ts: 100 }),
      f.agentStatus({ handle: '__proto__', status: 'working' }, { ts: 200 }),
    ])
    expect(state.agents['__proto__']?.synthetic).not.toBe(true)
  })
})

/**
 * prd19 ruling 2 — the fold the #62 TODO promised. `telemetry.refused` used to
 * hit a `return state` arm carrying a comment that a home was coming; this is
 * the home. The refusal's *other* half — that folding one leaves
 * `TelemetryState` byte-identical — is a law about the money layer's shape and
 * is stated in `reduce.telemetry.test.ts`'s additivity oracle, beside the
 * six-key law it protects.
 */
describe('reduce — telemetry.refused (prd19 ruling 2)', () => {
  const refused = (
    instance: string | null,
    count: number,
    ts: number,
  ): EventOf<'telemetry.refused'> =>
    f.make('telemetry.refused', { instance, expectedInstance: 'ours', count }, { ts })

  it('an old log with no telemetry.refused events folds refusals to its initial value — additive, unchanged replay', () => {
    expect(reduceAll(fixtureSession()).refusals).toEqual(initialRefusalState())
  })

  it('records the refusal whole, exactly as the receiver reported it', () => {
    const state = reduceAll([refused('other-rhizomorph', 4, 5_000)])
    expect(state.refusals.records).toHaveLength(1)
    expect(state.refusals.records[0]).toEqual({
      eventId: 'evt-000001',
      ts: 5_000,
      instance: 'other-rhizomorph',
      expectedInstance: 'ours',
      count: 4,
    })
    expect(state.refusals.byInstance).toEqual({ 'other-rhizomorph': [0] })
  })

  it('keeps arrival order and indexes each offender\'s positions in it', () => {
    const state = reduceAll([
      refused('theirs', 1, 100),
      refused(null, 1, 200),
      refused('other', 1, 300),
      refused('theirs', 9, 400),
    ])
    expect(state.refusals.records.map((record) => record.ts)).toEqual([100, 200, 300, 400])
    expect(state.refusals.byInstance).toEqual({ theirs: [0, 3], other: [2] })
  })

  it('keeps observation order even when timestamps arrive out of order — same rule as every other record', () => {
    const state = reduceAll([refused('theirs', 1, 9_000), refused('theirs', 1, 3_000)])
    expect(state.refusals.records.map((record) => record.ts)).toEqual([9_000, 3_000])
    expect(state.refusals.byInstance).toEqual({ theirs: [0, 1] })
  })

  /**
   * Two posts from the same offender are two facts about a fault that is STILL
   * happening — the one signal a connect surface reads to say "the fix has not
   * taken yet". The receiver's own once-per-offender-per-minute throttle is the
   * only thinning applied; merging here would hide exactly that.
   */
  it('never dedups a repeat offender — a standing fault is a standing fact', () => {
    const state = reduceAll([
      refused('theirs', 1, 100),
      refused('theirs', 12, 60_100),
      refused('theirs', 11, 120_100),
    ])
    expect(state.refusals.records.map((record) => record.count)).toEqual([1, 12, 11])
  })

  it('counts the event in the envelope bookkeeping — the export was refused, the log line still arrived', () => {
    const state = reduceAll([refused('theirs', 1, 100), refused('theirs', 1, 200)])
    expect(state.eventCount).toBe(2)
    expect(state.firstEventTs).toBe(100)
    expect(state.lastEventTs).toBe(200)
  })

  it('teaches no lane and no session — a refused post is nobody we saw spending', () => {
    const state = reduceAll([refused('theirs', 1, 100)])
    expect(state.telemetry.lanes).toEqual({})
    expect(state.telemetry.sessions).toEqual({})
    expect(state.agents).toEqual({})
  })

  it('is pure — folding a refusal does not mutate the prior state', () => {
    const before = reduceAll([refused('theirs', 1, 100)])
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown
    const after = reduce(before, refused('theirs', 2, 200))
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot)
    expect(after.refusals).not.toBe(before.refusals)
    expect(after.refusals.records).not.toBe(before.refusals.records)
  })

  /**
   * The accumulated index against the derived one — the same law #179 and #184
   * state for their tables, pointed at this slice: the index is exactly the
   * index of its own records, so the retention seam's rebuild path
   * (`refusalIndexOf`, which a cap would use) can never disagree with the
   * append-per-event path, and a replay resumed mid-log folds the same bytes as
   * one pass over the whole thing.
   */
  it('folds an index indistinguishable from the one derived from its records', () => {
    const events = [
      refused('theirs', 1, 100),
      refused(null, 3, 200),
      refused('other', 1, 300),
      refused('theirs', 2, 400),
      refused(null, 1, 500),
    ]
    const whole = reduceAll(events)
    // The replay split: the same log folded as two slices, which is what a boot
    // recovery followed by a live stream actually does.
    const resumed = reduceAll(events.slice(2), reduceAll(events.slice(0, 2)))

    expect(JSON.stringify(resumed.refusals)).toBe(JSON.stringify(whole.refusals))
    expect(whole.refusals.byInstance).toEqual(refusalIndexOf(whole.refusals.records))
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
// prd17 ruling 3, item 4 — the fold-order law
// ---------------------------------------------------------------------------

/**
 * The INCREMENTAL fold, spelled exactly as a stream spells it: one
 * `reduce(state, event)` per event, in the log's own order, no sorting. That
 * is what `packages/web/src/app/streamState.ts` and the server recorder do as
 * events arrive, and — since #205 — what replay's `foldFrom` does as a scrub
 * advances. Kept beside `reduceAll` so the two spellings can be held to the
 * same answer rather than assumed to agree.
 */
function foldIncrementally(events: readonly RhizomorphEvent[]): SessionState {
  let state = initialSessionState()
  for (const event of events) state = reduce(state, event)
  return state
}

/**
 * The fold #205 OUTLAWED: `ts`-ascending first, then reduced.
 *
 * Nothing in this repo folds this way. It is here as the counterexample that
 * gives the law its teeth — the reducer has to actually be order-sensitive, or
 * "append order is the truth" would be a rule about nothing and every test
 * below would pass at any ordering. Replay is where this shape used to live
 * (`packages/web/src/replay/replayFold.ts`'s `sortEvents` once fed
 * `buildSessionIndex`/`foldFrom`); it no longer does, and `replayFold.test.ts`
 * is the witness for that.
 */
function foldTsSorted(events: readonly RhizomorphEvent[]): SessionState {
  return reduceAll([...events].sort((a, b) => a.ts - b.ts))
}

/**
 * THE FOLD-ORDER LAW — ruled, and this is the reducer's half of it.
 *
 * The systems chair's verified finding was a real divergence: live folded
 * arrival order while replay folded a `ts`-sorted copy, through an
 * order-sensitive reducer, so the two paths folded one log to two different
 * states. Lane #204 pinned it and took no side. The operator ruled it on
 * **#205 (2026-08-24, option 1): a record's append order is the truth**, and
 * `docs/record-format.md` law 4 now states it — a reader folds the log in the
 * order it was written and MUST NOT re-sort it by `ts` to decide what the
 * state became; timestamps navigate time, they do not decide what happened
 * after what.
 *
 * The ruling splits into two testable halves, and this block owns the first:
 *
 * 1. **Here (core):** the reducer really is order-sensitive, so the choice of
 *    fold order is load-bearing rather than cosmetic — in three distinct ways,
 *    each exercised below: last-write-wins on a keyed record (`agent.status`),
 *    create-vs-delete on a key (`branch.updated` / `branch.removed`), and
 *    first-sighting sequence (`commits.order`, `firstEventTs`). Plus: the
 *    committed era-1 snapshot is the append-order fold, so the golden corpus
 *    stands on the ruled side rather than beside it.
 * 2. **`packages/web/src/replay/replayFold.test.ts` (web):** the functions
 *    `useReplaySession` actually calls — `buildSessionIndex`, `foldFrom`,
 *    `foldUpTo` — honour it unconditionally, with the `ts`-sorted copy kept
 *    for the scrubber's binary search and nothing else. Core cannot import
 *    web, so that half is proven there against the real implementation rather
 *    than modelled here; the model in this file is deliberately only ever used
 *    to show what the ruled-out ordering *would* have said.
 */
describe('reduce — the fold-order law: append order is the truth (prd17 ruling 3.4, #205)', () => {
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

  it('the two spellings of the one ruled fold agree, event by event and in bulk', () => {
    const events = interleaved()
    expect(canonicalStateJson(foldIncrementally(events))).toBe(
      canonicalStateJson(reduceAll(events)),
    )
  })

  describe('what no ordering may change', () => {
    it('counts every event exactly once', () => {
      const events = interleaved()
      expect(reduceAll(events).eventCount).toBe(events.length)
      expect(foldTsSorted(events).eventCount).toBe(events.length)
    })

    it('reports the same last-seen timestamp — a max, not a sequence', () => {
      const events = interleaved()
      expect(reduceAll(events).lastEventTs).toBe(9_000)
      expect(foldTsSorted(events).lastEventTs).toBe(9_000)
    })

    it('holds the same set of commits, whatever order they were sighted in', () => {
      const events = interleaved()
      expect(Object.keys(reduceAll(events).commits.bySha).sort()).toEqual(['sha-1', 'sha-2'])
      expect(Object.keys(foldTsSorted(events).commits.bySha).sort()).toEqual(['sha-1', 'sha-2'])
    })

    it('counts the same tokens — spend is a sum, and a sum has no order', () => {
      const events = interleaved()
      const tokensOf = (state: SessionState) =>
        state.telemetry.usage.reduce((sum, record) => sum + record.totalTokens, 0)
      expect(tokensOf(reduceAll(events))).toBe(tokensOf(foldTsSorted(events)))
      expect(tokensOf(reduceAll(events))).toBeGreaterThan(0)
    })
  })

  describe('why the ruling is load-bearing: what a ts-sort would have answered instead', () => {
    it('a keyed record\'s latest value: the last APPEND wins, not the latest TIMESTAMP', () => {
      const events = interleaved()
      // Ruled: `working` then `done` were appended, so `done` is the last write.
      expect(reduceAll(events).agents.a?.status).toBe('done')
      expect(reduceAll(events).agents.a?.previousStatus).toBe('working')
      // Outlawed: sorted, `done` (ts 3000) would precede `working` (ts 5000).
      expect(foldTsSorted(events).agents.a?.status).toBe('working')
      expect(foldTsSorted(events).agents.a?.previousStatus).toBe('done')
    })

    it('whether a branch still EXISTS — the sharpest form of the old divergence', () => {
      const events = interleaved()
      // Ruled: created, then removed. Gone.
      expect(reduceAll(events).branches['lane-a']).toBeUndefined()
      // Outlawed: the removal would sort FIRST and no-op on a branch that isn't
      // there yet; the update would then create it. Present, with a head.
      expect(foldTsSorted(events).branches['lane-a']?.head).toBe('sha-a')
    })

    it('the commit ticker\'s order', () => {
      const events = interleaved()
      expect(reduceAll(events).commits.order).toEqual(['sha-2', 'sha-1'])
      expect(foldTsSorted(events).commits.order).toEqual(['sha-1', 'sha-2'])
    })

    it('when the session began: the first APPEND, not the earliest TIMESTAMP', () => {
      const events = interleaved()
      expect(reduceAll(events).firstEventTs).toBe(2_000)
      expect(foldTsSorted(events).firstEventTs).toBe(1_000)
    })

    it('so the outlawed ordering folds one log to a different state — stated once, plainly', () => {
      const events = interleaved()
      expect(canonicalStateJson(reduceAll(events))).not.toBe(
        canonicalStateJson(foldTsSorted(events)),
      )
    })
  })

  describe('this is not a synthetic worry — a REAL recording is non-monotonic too', () => {
    /**
     * The era-1 corpus recording (`eras/era-1/recording.jsonl`) is a contiguous
     * slice of a log this instrument actually wrote, and it is not monotonic in
     * `ts`: a `sessionlog` tail line lands beside a `tmux` poll seconds older.
     * So the divergence above is the one the live dashboard and a replay of the
     * same recording really did disagree over, on real data, before #205.
     */
    const recording = eraCorpusEntry('era-1').recordingText

    it('era-1 is genuinely out of order in its own log', () => {
      const { events } = foldEraRecording(recording)
      const arrival = events.map((event) => event.ts)
      expect(arrival).not.toEqual([...arrival].sort((a, b) => a - b))
    })

    it('and the outlawed ordering lands it somewhere else entirely', () => {
      const { events } = foldEraRecording(recording)
      expect(canonicalStateJson(reduceAll(events))).not.toBe(
        canonicalStateJson(foldTsSorted(events)),
      )
    })

    it('the committed era snapshot is the APPEND-ORDER fold — the corpus stands on the ruled side', () => {
      const { events, state } = foldEraRecording(recording)
      expect(canonicalStateJson(state)).toBe(canonicalStateJson(foldIncrementally(events)))
      expect(canonicalStateJson(state)).not.toBe(canonicalStateJson(foldTsSorted(events)))
    })
  })
})

describe('reduce — beacon.received folds declared attention per lane (prd-27 w3, #283)', () => {
  const DIGEST = 'a'.repeat(64)

  it('a waiting beacon for a lane writes declared[lane] with the writer clock and the pointer', () => {
    const base = reduceAll(fixtureSession())
    const after = reduce(
      base,
      f.beaconReceived(
        { kind: 'waiting', lane: '2-core', writer: 'claude-hook', digest: DIGEST, file: 'claude-hook.jsonl', offset: 0 },
        { ts: 10 },
      ),
    )
    expect(after.declared['2-core']).toEqual({
      kind: 'waiting',
      at: 10,
      writer: 'claude-hook',
      digest: DIGEST,
      file: 'claude-hook.jsonl',
      offset: 0,
    })
    // Nothing else moved: the declared slice and the envelope bookkeeping, and no more.
    expect({ ...after, declared: base.declared, eventCount: base.eventCount, lastEventTs: base.lastEventTs }).toEqual(base)
  })

  it('a kind outside BEACON_ATTENTION_KINDS folds to state unchanged', () => {
    const base = reduceAll(fixtureSession())
    const after = reduce(base, f.beaconReceived({ kind: 'landed', lane: '2-core' }, { ts: 10 }))
    expect(after.declared).toEqual({})
    expect({ ...after, eventCount: base.eventCount, lastEventTs: base.lastEventTs }).toEqual(base)
  })

  it('an unlaned beacon is never indexed — it has nobody to be about', () => {
    const base = reduceAll(fixtureSession())
    const after = reduce(base, f.beaconReceived({ kind: 'waiting', lane: null }, { ts: 10 }))
    expect(after.declared).toEqual({})
  })

  it('the latest by writer clock wins, and an older line never rolls a lane back', () => {
    const after = reduceAll([
      f.beaconReceived({ kind: 'waiting', lane: '2-core' }, { ts: 10 }),
      f.beaconReceived({ kind: 'working', lane: '2-core' }, { ts: 20 }),
    ])
    expect(after.declared['2-core']?.kind).toBe('working')
    expect(after.declared['2-core']?.at).toBe(20)

    const late = reduce(after, f.beaconReceived({ kind: 'stopped', lane: '2-core' }, { ts: 15 }))
    expect(late.declared['2-core']?.kind).toBe('working')
    expect(late.declared['2-core']?.at).toBe(20)
  })

  it('equal clocks yield to log order — the later line stands', () => {
    const after = reduceAll([
      f.beaconReceived({ kind: 'waiting', lane: '2-core' }, { ts: 10 }),
      f.beaconReceived({ kind: 'working', lane: '2-core' }, { ts: 10 }),
    ])
    expect(after.declared['2-core']?.kind).toBe('working')
  })

  it('two lanes fold independently', () => {
    const after = reduceAll([
      f.beaconReceived({ kind: 'waiting', lane: '2-core' }, { ts: 10 }),
      f.beaconReceived({ kind: 'working', lane: '3-web' }, { ts: 11 }),
    ])
    expect(after.declared['2-core']?.kind).toBe('waiting')
    expect(after.declared['3-web']?.kind).toBe('working')
  })

  it('repetition: folding the same run of beacons twice yields toEqual states', () => {
    const events = fixtureSession()
    const run = [
      f.beaconReceived({ kind: 'waiting', lane: '2-core' }, { ts: 10 }),
      f.beaconReceived({ kind: 'working', lane: '3-web' }, { ts: 11 }),
      f.beaconReceived({ kind: 'landed', writer: 'gate', lane: '2-core' }, { ts: 12 }),
    ]
    const once = reduceAll([...events, ...run])
    const twice = reduceAll([...events, ...run, ...run])
    expect({ ...twice, eventCount: once.eventCount, lastEventTs: once.lastEventTs }).toEqual(once)
  })

  it('is pure for this arm too — the input state is untouched and no reference is shared into the fold', () => {
    const before = reduceAll(fixtureSession())
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown
    const after = reduce(before, f.beaconReceived())
    expect(before).toEqual(snapshot)
    expect(after).not.toBe(before)
  })

  it('canonical state with a run of attention beacons differs from without only in declared', () => {
    const events = fixtureSession()
    const beacons = [
      f.beaconReceived({ kind: 'waiting' }, { ts: 10 }),
      f.beaconReceived({ kind: 'working', lane: null }, { ts: 11 }),
      f.beaconReceived({ kind: 'landed', writer: 'gate', detail: 'prd27 w1' }, { ts: 12 }),
    ]
    const alone = reduceAll(events)
    const both = reduceAll([...events, ...beacons])
    expect(both.eventCount).toBe(alone.eventCount + beacons.length)
    // The one laned attention beacon in that run landed, and it is the only difference.
    expect(both.declared['2-core']?.kind).toBe('waiting')
    expect(
      canonicalStateJson({
        ...both,
        declared: alone.declared,
        eventCount: alone.eventCount,
        lastEventTs: alone.lastEventTs,
      }),
    ).toBe(canonicalStateJson(alone))
  })
})

describe('reduce — gate.verdict (prd17 w6, #280)', () => {
  it('folds to state unchanged — the event is emitted now, but reading it back into SessionState is not this wave', () => {
    const before = reduceAll(fixtureSession())
    const after = reduce(before, f.gateVerdict({ handle: 'feature', held: true, reason: 'suite-red' }, { ts: 10 }))
    expect({ ...after, eventCount: before.eventCount, lastEventTs: before.lastEventTs }).toEqual(before)
  })
})
