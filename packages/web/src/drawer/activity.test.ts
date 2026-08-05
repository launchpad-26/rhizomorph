import { createEventFactory } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { activityCounts, foldActivity, type ActivityLane } from './foldActivity.js'

const WORKTREE = '/repo-wt/84-chat-drawer'
const BRANCH = '84-chat-drawer'

const LANE: ActivityLane = {
  id: '84-chat-drawer',
  branch: BRANCH,
  worktreePath: WORKTREE,
  handles: ['84-chat-drawer'],
}

function laneAttribution() {
  return { lane: LANE.id, branch: LANE.branch, worktreePath: WORKTREE }
}

describe('foldActivity — the three kinds (ruling 17)', () => {
  it('folds tool calls, file changes and commits, newest first', () => {
    const f = createEventFactory({ startTs: 1_000, stepMs: 1_000 })
    const events = [
      f.toolActivity({ ...laneAttribution(), tool: 'Read' }),
      f.worktreeDirty({ path: WORKTREE, branch: LANE.branch, files: [{ path: 'src/a.ts', status: 'modified' }] }),
      f.commitLanded({ branch: BRANCH, sha: 'abc1234def', message: 'feat: a thing\n\nbody', files: [{ path: 'src/a.ts', status: 'modified' }], insertions: 4, deletions: 1 }),
    ]

    const entries = foldActivity(events, LANE)

    expect(entries.map((entry) => entry.kind)).toEqual(['commit', 'file', 'tool'])
    expect(activityCounts(entries)).toEqual({ tool: 1, file: 1, commit: 1 })
  })

  it('reports a tool call with its thread', () => {
    const f = createEventFactory()
    const entries = foldActivity([f.toolActivity({ ...laneAttribution(), tool: 'Grep', thread: 'subagent' })], LANE)

    expect(entries[0]).toMatchObject({ kind: 'tool', tool: 'Grep', count: 1, thread: 'subagent' })
  })

  it('reports a commit as its subject line, file count and diffstat', () => {
    const f = createEventFactory()
    const entries = foldActivity(
      [
        f.commitLanded({
          branch: BRANCH,
          sha: 'deadbeefcafe',
          message: 'fix(drawer): tail honestly\n\nlong body nobody wants in a ticker',
          files: [
            { path: 'a.ts', status: 'modified' },
            { path: 'b.ts', status: 'added' },
          ],
          insertions: 12,
          deletions: 3,
        }),
      ],
      LANE,
    )

    expect(entries[0]).toMatchObject({
      kind: 'commit',
      sha: 'deadbeefcafe',
      subject: 'fix(drawer): tail honestly',
      fileCount: 2,
      insertions: 12,
      deletions: 3,
    })
  })
})

describe('foldActivity — coalescing (ruling 32: coalesced, never invented)', () => {
  it('coalesces a run of the same tool into one line with a count', () => {
    const f = createEventFactory({ startTs: 1_000, stepMs: 1_000 })
    const events = [
      f.toolActivity({ ...laneAttribution(), tool: 'Read' }),
      f.toolActivity({ ...laneAttribution(), tool: 'Read' }),
      f.toolActivity({ ...laneAttribution(), tool: 'Read' }),
      f.toolActivity({ ...laneAttribution(), tool: 'Edit' }),
    ]

    const entries = foldActivity(events, LANE)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'tool', tool: 'Edit', count: 1 })
    expect(entries[1]).toMatchObject({ kind: 'tool', tool: 'Read', count: 3, ts: 3_000 })
  })

  it('does not coalesce across a commit — a run means an uninterrupted run', () => {
    const f = createEventFactory({ startTs: 1_000, stepMs: 1_000 })
    const events = [
      f.toolActivity({ ...laneAttribution(), tool: 'Bash' }),
      f.commitLanded({ branch: BRANCH, sha: 'c1' }),
      f.toolActivity({ ...laneAttribution(), tool: 'Bash' }),
    ]

    const entries = foldActivity(events, LANE)

    expect(entries.map((entry) => entry.kind)).toEqual(['tool', 'commit', 'tool'])
    expect(entries.filter((entry) => entry.kind === 'tool').every((entry) => entry.count === 1)).toBe(true)
  })

  it('does not coalesce the main thread with a subagent doing the same thing', () => {
    const f = createEventFactory()
    const events = [
      f.toolActivity({ ...laneAttribution(), tool: 'Read', thread: 'main' }),
      f.toolActivity({ ...laneAttribution(), tool: 'Read', thread: 'subagent' }),
    ]

    expect(foldActivity(events, LANE)).toHaveLength(2)
  })
})

describe('foldActivity — worktree.dirty is a snapshot, not a delta', () => {
  it('reports each file once, not once per poll that still sees it dirty', () => {
    const f = createEventFactory({ startTs: 1_000, stepMs: 1_000 })
    const files = [{ path: 'src/a.ts', status: 'modified' as const }]
    const events = [
      f.worktreeDirty({ path: WORKTREE, branch: LANE.branch, files }),
      f.worktreeDirty({ path: WORKTREE, branch: LANE.branch, files }),
      f.worktreeDirty({ path: WORKTREE, branch: LANE.branch, files }),
    ]

    const entries = foldActivity(events, LANE)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'file', path: 'src/a.ts', status: 'modified' })
  })

  it('reports a file again when its status changes', () => {
    const f = createEventFactory({ startTs: 1_000, stepMs: 1_000 })
    const events = [
      f.worktreeDirty({ path: WORKTREE, branch: LANE.branch, files: [{ path: 'src/a.ts', status: 'added' }] }),
      f.worktreeDirty({ path: WORKTREE, branch: LANE.branch, files: [{ path: 'src/a.ts', status: 'modified' }] }),
    ]

    expect(foldActivity(events, LANE).map((entry) => (entry.kind === 'file' ? entry.status : null))).toEqual([
      'modified',
      'added',
    ])
  })

  it('reports a newly dirty file appearing beside one already known', () => {
    const f = createEventFactory({ startTs: 1_000, stepMs: 1_000 })
    const events = [
      f.worktreeDirty({ path: WORKTREE, branch: LANE.branch, files: [{ path: 'a.ts', status: 'modified' }] }),
      f.worktreeDirty({
        path: WORKTREE,
        branch: LANE.branch,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'added' },
        ],
      }),
    ]

    expect(foldActivity(events, LANE).map((entry) => (entry.kind === 'file' ? entry.path : null))).toEqual([
      'b.ts',
      'a.ts',
    ])
  })
})

describe('foldActivity — attribution', () => {
  it('ignores another lane entirely', () => {
    const f = createEventFactory()
    const events = [
      f.toolActivity({ lane: 'other', branch: 'other', worktreePath: '/repo-wt/other', tool: 'Read' }),
      f.commitLanded({ branch: 'other', sha: 'x1' }),
    ]

    expect(foldActivity(events, LANE)).toEqual([])
  })

  it('matches a lane the collectors named by handle rather than by branch', () => {
    const f = createEventFactory()
    const lane: ActivityLane = { ...LANE, id: 'wt-84', branch: null, handles: ['84-handle'] }
    const events = [f.toolActivity({ lane: '84-handle', branch: null, worktreePath: null, tool: 'Write' })]

    expect(foldActivity(events, lane)).toHaveLength(1)
  })

  it('matches on the worktree path when neither name was recorded', () => {
    const f = createEventFactory()
    const events = [f.worktreeDirty({ path: WORKTREE, branch: null, files: [{ path: 'z.ts', status: 'modified' }] })]

    expect(foldActivity(events, LANE)).toHaveLength(1)
  })

  it('keeps only the newest entries once the cap is reached', () => {
    const f = createEventFactory({ startTs: 1_000, stepMs: 1_000 })
    const events = Array.from({ length: 10 }, (_, i) =>
      f.toolActivity({ ...laneAttribution(), tool: `Tool${i}` }),
    )

    const entries = foldActivity(events, LANE, { limit: 3 })

    expect(entries.map((entry) => (entry.kind === 'tool' ? entry.tool : null))).toEqual([
      'Tool9',
      'Tool8',
      'Tool7',
    ])
  })

  it('is empty, not broken, for a lane with no events at all', () => {
    expect(foldActivity([], LANE)).toEqual([])
    expect(activityCounts([])).toEqual({ tool: 0, file: 0, commit: 0 })
  })
})
