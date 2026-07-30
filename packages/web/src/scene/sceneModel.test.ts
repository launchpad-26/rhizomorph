import {
  createEvent,
  createIdFactory,
  reduceAll,
  selectWorktreeViews,
  type EventType,
  type ObservatoryEvent,
  type PayloadOf,
} from '@observatory/core'
import { describe, expect, it } from 'vitest'
import { FIXTURE_WORKTREE_COUNT, fixtureEvents } from './fixtures.js'
import {
  FLATLINE_AFTER_MS,
  IDLE_AFTER_MS,
  MAX_COMMITS_PER_STATION,
  buildSceneModel,
  stationLiveness,
} from './sceneModel.js'

const nextId = createIdFactory('t')

function ev<T extends EventType>(type: T, payload: PayloadOf<T>, ts: number): ObservatoryEvent {
  return createEvent(type, payload, { id: nextId(), ts })
}

const MAIN = '/repo'
const WT = '/repo/wt/a'

function baseLog(): ObservatoryEvent[] {
  return [
    ev(
      'session.started',
      { sessionId: 's', repoPath: MAIN, repoName: 'observatory', mainBranch: 'main' },
      1_000,
    ),
    ev('worktree.discovered', { path: MAIN, branch: 'main', head: 'h0', isMain: true }, 1_000),
    ev('worktree.discovered', { path: WT, branch: 'feat', head: 'h1', isMain: false }, 2_000),
  ]
}

function commitEvent(sha: string, ts: number, extra: { worktreePath?: string } = {}) {
  return ev(
    'commit.landed',
    {
      sha,
      branch: 'feat',
      message: `feat: ${sha}\n\nbody`,
      author: { name: 'claude' },
      files: [{ path: 'a.ts', status: 'modified' }],
      ...extra,
    },
    ts,
  )
}

describe('buildSceneModel', () => {
  it('separates the main worktree (trunk) from orbiting stations', () => {
    const model = buildSceneModel(baseLog())

    expect(model.repoName).toBe('observatory')
    expect(model.mainBranch).toBe('main')
    expect(model.trunk?.id).toBe(MAIN)
    expect(model.stations.map((station) => station.id)).toEqual([WT])
    expect(model.stations[0]?.label).toBe('feat')
  })

  it('attaches commits by worktree path and by branch alike', () => {
    const model = buildSceneModel([
      ...baseLog(),
      commitEvent('sha-1', 3_000, { worktreePath: WT }),
      commitEvent('sha-2', 4_000),
    ])

    expect(model.stations[0]?.commits.map((commit) => commit.sha)).toEqual(['sha-1', 'sha-2'])
    expect(model.commitCount).toBe(2)
    // The subject line only — the scene has no room for commit bodies.
    expect(model.stations[0]?.commits[0]?.message).toBe('feat: sha-1')
  })

  it('ignores a commit it has already seen, so replay cannot double-count', () => {
    const model = buildSceneModel([
      ...baseLog(),
      commitEvent('sha-1', 3_000),
      commitEvent('sha-1', 3_000),
    ])

    expect(model.commitCount).toBe(1)
  })

  it('does not invent a station for a branch with no worktree (retired branch)', () => {
    const model = buildSceneModel([
      ...baseLog(),
      ev('branch.updated', { branch: 'orphan', head: 'h9', aheadOfMain: 4 }, 5_000),
    ])

    expect(model.stations.some((station) => station.branch === 'orphan')).toBe(false)
    expect(model.stations).toHaveLength(1)
  })

  it('folds worktree.discovered plus repeated branch.updated into exactly one station per worktree', () => {
    const model = buildSceneModel([
      ...baseLog(),
      ev('branch.updated', { branch: 'feat', head: 'h1', aheadOfMain: 1 }, 3_000),
      ev('branch.updated', { branch: 'feat', head: 'h2', aheadOfMain: 2 }, 4_000),
      ev('branch.updated', { branch: 'feat', head: 'h3', aheadOfMain: 3, worktreePath: WT }, 5_000),
    ])

    const matching = model.stations.filter((station) => station.branch === 'feat')
    expect(matching).toHaveLength(1)
    expect(matching[0]?.id).toBe(WT)
    expect(matching[0]?.aheadOfMain).toBe(3)
    // Trunk (main) + one orbiting station — never doubled.
    expect(model.stations).toHaveLength(1)
    expect(model.trunk).not.toBeNull()
  })

  it('never fabricates a duplicate station for a branch with a worktree, and its header count matches the worktree table', () => {
    const log = [
      ...baseLog(),
      // Same branch as WT's worktree, arriving again via branch.updated —
      // must land on the existing WT station, not mint a second one.
      ev('branch.updated', { branch: 'feat', head: 'h2', aheadOfMain: 2 }, 3_000),
      // A branch with no discovered worktree at all — must produce no station.
      ev('branch.updated', { branch: 'orphan', head: 'h9', aheadOfMain: 4 }, 4_000),
    ]
    const model = buildSceneModel(log)

    const allLabels = [model.trunk, ...model.stations]
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .map((s) => s.label)
    expect(new Set(allLabels).size).toBe(allLabels.length)
    expect(model.stations.filter((s) => s.branch === 'feat')).toHaveLength(1)

    // The scene header's worktree count must equal what the worktree panel
    // (same log, `selectWorktreeViews`) would show — not a locally counted
    // number that happens to exclude the trunk.
    const expectedWorktreeCount = selectWorktreeViews(reduceAll(log)).length
    expect(expectedWorktreeCount).toBe(2) // main + WT; 'orphan' has no worktree
    expect(model.worktreeCount).toBe(expectedWorktreeCount)
  })

  it('treats worktree.dirty as a snapshot, not a delta', () => {
    const model = buildSceneModel([
      ...baseLog(),
      ev(
        'worktree.dirty',
        {
          path: WT,
          files: [
            { path: 'a.ts', status: 'modified' },
            { path: 'b.ts', status: 'added' },
          ],
        },
        3_000,
      ),
      ev('worktree.dirty', { path: WT, files: [{ path: 'a.ts', status: 'modified' }] }, 4_000),
    ])

    expect(model.stations[0]?.dirtyFiles).toBe(1)
  })

  it('routes pane activity to the worktree the pane lives in', () => {
    const model = buildSceneModel([
      ...baseLog(),
      ev(
        'pane.discovered',
        { paneId: '%1', windowName: 'a', currentPath: WT, worktreePath: WT },
        3_000,
      ),
      ev('pane.activity', { paneId: '%1', contentHash: 'x' }, 9_000),
    ])

    expect(model.stations[0]?.paneIds).toEqual(['%1'])
    expect(model.stations[0]?.lastActivityTs).toBe(9_000)
  })

  it('records removal instead of dropping the station, so it can fade out', () => {
    const model = buildSceneModel([...baseLog(), ev('worktree.removed', { path: WT }, 7_000)])

    expect(model.stations[0]?.removedAt).toBe(7_000)
  })

  it('bounds per-station commit history', () => {
    const commits = Array.from({ length: MAX_COMMITS_PER_STATION + 25 }, (_unused, index) =>
      commitEvent(`sha-${index}`, 3_000 + index),
    )
    const model = buildSceneModel([...baseLog(), ...commits])

    expect(model.stations[0]?.commits).toHaveLength(MAX_COMMITS_PER_STATION)
    // The oldest are the ones dropped.
    expect(model.stations[0]?.commits[0]?.sha).toBe('sha-25')
  })

  it('survives a log with no git events at all', () => {
    const model = buildSceneModel([
      ev('collector.disabled', { collector: 'workmux', reason: 'not installed' }, 1),
    ])

    expect(model.trunk).toBeNull()
    expect(model.stations).toEqual([])
    expect(model.commitCount).toBe(0)
  })
})

describe('stationLiveness', () => {
  const station = buildSceneModel(baseLog()).stations[0]

  it('reports unknown before anything is heard, then live, idle, flatline', () => {
    expect(station).toBeDefined()
    const silent = { ...station!, lastActivityTs: null }
    expect(stationLiveness(silent, 10_000)).toBe('unknown')

    const heard = { ...station!, lastActivityTs: 100_000 }
    expect(stationLiveness(heard, 100_000)).toBe('live')
    expect(stationLiveness(heard, 100_000 + IDLE_AFTER_MS - 1)).toBe('live')
    expect(stationLiveness(heard, 100_000 + IDLE_AFTER_MS + 1)).toBe('idle')
    expect(stationLiveness(heard, 100_000 + FLATLINE_AFTER_MS + 1)).toBe('flatline')
  })
})

describe('fixtureEvents', () => {
  it('is a schema-valid swarm at the stated performance target', () => {
    const model = buildSceneModel(fixtureEvents(1_000_000_000))

    expect(model.trunk?.isMain).toBe(true)
    expect(model.stations).toHaveLength(FIXTURE_WORKTREE_COUNT + 1) // +1 removed worktree
    expect(model.commitCount).toBeGreaterThanOrEqual(200)
    expect(model.stations.some((station) => station.removedAt !== null)).toBe(true)
    expect(model.stations.some((station) => station.agentStatus === 'waiting')).toBe(true)
  })

  it('is deterministic', () => {
    expect(fixtureEvents(1_000_000_000)).toEqual(fixtureEvents(1_000_000_000))
  })
})
