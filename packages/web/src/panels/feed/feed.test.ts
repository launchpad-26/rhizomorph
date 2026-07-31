import { createEventFactory, reduceAll, type SessionState } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import { buildFleet } from '../../fleet/buildFleet.js'
import {
  buildFeedEntries,
  buildLaneIndex,
  filterFeedEntries,
  type FeedEntry,
} from './feed.js'

const REPO = '/repo/observatory'
const WT = (name: string) => `${REPO}-wt/${name}`
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const NEWS_GRACE_MS = 4_000

/**
 * One small swarm: two real lanes (so the lane filter has something to
 * discriminate against), a landing, a lane stop/start, and both flavours of
 * collector trouble. Folded by core's real reducer and read by the real
 * `buildFleet`, so `laneIndex` resolves lane ids exactly the way the fleet
 * table and the scene would.
 */
function buildScenario() {
  const f = createEventFactory({ startTs: NOW - 10 * 60_000, stepMs: 60_000 })

  f.sessionStarted()
  f.worktreeDiscovered({ path: REPO, branch: 'main', head: 'sha-main-0', isMain: true })
  f.worktreeDiscovered({ path: WT('42-lane'), branch: '42-lane', head: 'sha-42-0', isMain: false })
  f.worktreeDiscovered({ path: WT('43-lane'), branch: '43-lane', head: 'sha-43-0', isMain: false })

  f.agentStatus({ handle: '42-lane', status: 'working', worktreePath: WT('42-lane'), branch: '42-lane' })
  f.commitLanded({
    sha: 'sha-42-1',
    branch: '42-lane',
    message: 'feat(42): land the thing',
  })
  f.agentStatus({ handle: '42-lane', status: 'done', worktreePath: WT('42-lane'), branch: '42-lane' })
  f.worktreeRemoved({ path: WT('42-lane') })

  f.collectorDisabled({ collector: 'workmux', reason: 'workmux not found on PATH' })
  f.commitLanded({
    sha: 'sha-43-1',
    branch: '43-lane',
    message: 'feat(43): a second lane',
  })
  f.collectorError({ collector: 'tmux', message: 'capture-pane timed out' })

  const events = f.all()
  const session: SessionState = reduceAll(events)
  const fleet = buildFleet(session, { now: NOW })
  const laneIndex = buildLaneIndex(fleet.lanes)

  return { events, session, laneIndex }
}

function kindsOf(entries: readonly FeedEntry[]): string[] {
  return entries.map((entry) => entry.kind)
}

describe('buildFeedEntries', () => {
  it('folds all four kinds — commit, landing, lane, collector — newest first', () => {
    const { events, session, laneIndex } = buildScenario()

    const entries = buildFeedEntries(events, session, laneIndex, {
      connectedAt: NOW,
      newsGraceMs: NEWS_GRACE_MS,
    })

    expect(new Set(kindsOf(entries))).toEqual(new Set(['commit', 'landing', 'lane', 'collector']))
    // Newest first: the tmux error was the very last thing to happen.
    expect(entries[0]?.kind).toBe('collector')
    expect(entries[0]).toMatchObject({ collector: 'tmux', state: 'error' })
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i - 1]!.ts).toBeGreaterThanOrEqual(entries[i]!.ts)
    }
  })

  it('does not treat the main worktree closing as a landing', () => {
    const f = createEventFactory({ startTs: NOW - 60_000, stepMs: 60_000 })
    f.sessionStarted()
    f.worktreeDiscovered({ path: REPO, branch: 'main', head: 'sha-main-0', isMain: true })
    f.worktreeRemoved({ path: REPO })
    const events = f.all()
    const session = reduceAll(events)
    const fleet = buildFleet(session, { now: NOW })
    const laneIndex = buildLaneIndex(fleet.lanes)

    const entries = buildFeedEntries(events, session, laneIndex, {
      connectedAt: NOW,
      newsGraceMs: NEWS_GRACE_MS,
    })

    expect(entries.some((entry) => entry.kind === 'landing')).toBe(false)
  })

  it('marks a fact from before the feed connected as history, and one after as news', () => {
    const { events, session, laneIndex } = buildScenario()
    // Connect between the two commits: everything before is history, the
    // second commit and everything after it is news.
    const connectedAt = NOW - 3 * 60_000 + 1

    const entries = buildFeedEntries(events, session, laneIndex, {
      connectedAt,
      newsGraceMs: NEWS_GRACE_MS,
    })

    const firstCommit = entries.find(
      (entry): entry is Extract<FeedEntry, { kind: 'commit' }> =>
        entry.kind === 'commit' && entry.commit.sha === 'sha-42-1',
    )
    const secondCommit = entries.find(
      (entry): entry is Extract<FeedEntry, { kind: 'commit' }> =>
        entry.kind === 'commit' && entry.commit.sha === 'sha-43-1',
    )
    expect(firstCommit?.news).toBe(false)
    expect(secondCommit?.news).toBe(true)
  })
})

describe('filterFeedEntries', () => {
  it('narrows to the selected kinds', () => {
    const { events, session, laneIndex } = buildScenario()
    const entries = buildFeedEntries(events, session, laneIndex, {
      connectedAt: NOW,
      newsGraceMs: NEWS_GRACE_MS,
    })

    const commitsOnly = filterFeedEntries(entries, new Set(['commit']), null)
    expect(commitsOnly.length).toBeGreaterThan(0)
    expect(commitsOnly.every((entry) => entry.kind === 'commit')).toBe(true)
  })

  it('narrows to one lane, using the fleet-resolved lane id', () => {
    const { events, session, laneIndex } = buildScenario()
    const entries = buildFeedEntries(events, session, laneIndex, {
      connectedAt: NOW,
      newsGraceMs: NEWS_GRACE_MS,
    })
    const allKinds = new Set(['commit', 'landing', 'lane', 'collector'] as const)

    const forty2 = filterFeedEntries(entries, allKinds, '42-lane')

    // 42-lane's commit, its landing and its two status entries — nothing
    // belonging to 43-lane, and no lane-less collector entries either.
    expect(forty2.length).toBeGreaterThan(0)
    for (const entry of forty2) expect(entry.laneId).toBe('42-lane')
    expect(forty2.some((entry) => entry.kind === 'landing')).toBe(true)
    expect(forty2.some((entry) => entry.kind === 'collector')).toBe(false)
  })
})
