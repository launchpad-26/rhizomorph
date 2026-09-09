import { describe, expect, it } from 'vitest'
import type { EventRow } from '../storage/contract.js'
import { projectionsFor, utcDay } from './projections.js'

/**
 * THE PURE FOLD (prd-51 ruling 5).
 *
 * No fs, no clock, no driver — the function is `(rows) => plain data` and every
 * case here is a value comparison. The one property that is easy to state and
 * easy to lose is idempotence, and it is the last case: the same rows twice
 * produce the same delta, because this is a fold over its input rather than an
 * accumulator across calls.
 */

function row(overrides: Partial<EventRow> = {}): EventRow {
  return {
    projectId: 'acme-widgets',
    actorInstance: 'lane-7',
    n: 1,
    eventId: 'e',
    tsMs: Date.UTC(2026, 7, 3, 12, 0, 0),
    type: 'llm.cost',
    source: 'otel',
    lane: null,
    worktree: null,
    payload: {},
    line: 'x',
    ...overrides,
  }
}

describe('spend_by_project_day', () => {
  it('two rows on the same UTC day sum into one row', () => {
    const delta = projectionsFor([
      row({ n: 1, payload: { costUsd: 1.5 } }),
      row({ n: 2, payload: { costUsd: 0.25 } }),
    ])
    expect(delta.spend).toEqual([{ projectId: 'acme-widgets', day: '2026-08-03', costUsd: 1.75, events: 2 }])
  })

  it('two rows either side of a UTC midnight produce TWO days', () => {
    const delta = projectionsFor([
      row({ n: 1, tsMs: Date.UTC(2026, 7, 3, 23, 59, 59), payload: { costUsd: 1 } }),
      row({ n: 2, tsMs: Date.UTC(2026, 7, 4, 0, 0, 1), payload: { costUsd: 2 } }),
    ])
    expect(delta.spend.map((s) => s.day)).toEqual(['2026-08-03', '2026-08-04'])
    expect(delta.spend.map((s) => s.costUsd)).toEqual([1, 2])
  })

  it('a row with no dollars still counts as an event and contributes nothing to the money', () => {
    const delta = projectionsFor([row({ n: 1, type: 'llm.usage', payload: { tokens: 1 } })])
    expect(delta.spend).toEqual([{ projectId: 'acme-widgets', day: '2026-08-03', costUsd: 0, events: 1 }])
  })

  it('a non-numeric or non-finite costUsd is 0, not NaN — one bad payload cannot poison a whole day', () => {
    const delta = projectionsFor([
      row({ n: 1, payload: { costUsd: 'lots' } }),
      row({ n: 2, payload: { costUsd: Number.NaN } }),
      row({ n: 3, payload: { costUsd: 2 } }),
    ])
    expect(delta.spend[0]?.costUsd).toBe(2)
    expect(Number.isNaN(delta.spend[0]?.costUsd ?? Number.NaN)).toBe(false)
  })

  it('two projects on the same day are two rows', () => {
    const delta = projectionsFor([row({ n: 1, projectId: 'a' }), row({ n: 2, projectId: 'b' })])
    expect(delta.spend.map((s) => s.projectId)).toEqual(['a', 'b'])
  })

  it('utcDay is UTC, not local — the assertion a toLocaleDateString version fails', () => {
    expect(utcDay(Date.UTC(2026, 7, 3, 23, 59, 59, 999))).toBe('2026-08-03')
    expect(utcDay(Date.UTC(2026, 7, 4, 0, 0, 0, 0))).toBe('2026-08-04')
  })
})

describe('lane_state', () => {
  it('an agent.status row sets the state', () => {
    const delta = projectionsFor([
      row({ n: 1, type: 'agent.status', lane: 'l', worktree: '/w', payload: { handle: 'l', status: 'waiting' } }),
    ])
    expect(delta.lanes).toEqual([
      { projectId: 'acme-widgets', lane: 'l', state: 'waiting', worktree: '/w', lastEventTsMs: row().tsMs },
    ])
  })

  /**
   * The clause the upsert's `COALESCE` exists for: a batch that touched a lane
   * but said nothing about its status advances `last_event_ts` and leaves the
   * stored state alone. A `null` here is what tells the adapter to do that.
   */
  it('a batch with no agent.status for a lane reports state null, so the stored one survives', () => {
    const delta = projectionsFor([row({ n: 1, lane: 'l', payload: { costUsd: 1 } })])
    expect(delta.lanes).toEqual([
      { projectId: 'acme-widgets', lane: 'l', state: null, worktree: null, lastEventTsMs: row().tsMs },
    ])
  })

  it('a row with no lane contributes no lane_state row at all', () => {
    expect(projectionsFor([row({ n: 1, lane: null })]).lanes).toEqual([])
  })

  it('the newest ts in the batch wins, whichever order the rows arrive in', () => {
    const late = Date.UTC(2026, 7, 3, 18)
    const early = Date.UTC(2026, 7, 3, 6)
    const forwards = projectionsFor([
      row({ n: 1, lane: 'l', tsMs: early, worktree: '/old' }),
      row({ n: 2, lane: 'l', tsMs: late, worktree: '/new' }),
    ])
    const backwards = projectionsFor([
      row({ n: 2, lane: 'l', tsMs: late, worktree: '/new' }),
      row({ n: 1, lane: 'l', tsMs: early, worktree: '/old' }),
    ])
    expect(forwards.lanes[0]?.lastEventTsMs).toBe(late)
    expect(backwards.lanes[0]?.lastEventTsMs).toBe(late)
    expect(forwards.lanes[0]?.worktree).toBe('/new')
    expect(backwards.lanes[0]?.worktree).toBe('/new')
  })
})

describe('collisions', () => {
  it('a worktree.dirty row with two files produces two entries, both naming the branch', () => {
    const delta = projectionsFor([
      row({
        n: 1,
        type: 'worktree.dirty',
        source: 'git',
        payload: {
          path: '/repo-wt/l',
          branch: 'prd51-w3',
          files: [
            { path: 'src/a.ts', status: 'modified' },
            { path: 'src/b.ts', status: 'added' },
          ],
        },
      }),
    ])
    expect(delta.collisions).toEqual([
      {
        projectId: 'acme-widgets',
        path: 'src/a.ts',
        lanes: ['prd51-w3'],
        firstSeenMs: row().tsMs,
        lastSeenMs: row().tsMs,
      },
      {
        projectId: 'acme-widgets',
        path: 'src/b.ts',
        lanes: ['prd51-w3'],
        firstSeenMs: row().tsMs,
        lastSeenMs: row().tsMs,
      },
    ])
  })

  it('two branches touching one path union into one entry with two lanes', () => {
    const dirty = (branch: string, tsMs: number) =>
      row({
        n: 1,
        tsMs,
        type: 'worktree.dirty',
        source: 'git',
        payload: { path: `/repo-wt/${branch}`, branch, files: [{ path: 'src/a.ts', status: 'modified' }] },
      })
    const delta = projectionsFor([dirty('b', 200), dirty('a', 100)])
    expect(delta.collisions).toEqual([
      { projectId: 'acme-widgets', path: 'src/a.ts', lanes: ['a', 'b'], firstSeenMs: 100, lastSeenMs: 200 },
    ])
  })

  it('a dirty snapshot with no branch contributes nothing — a collision needs two named lanes', () => {
    const delta = projectionsFor([
      row({
        n: 1,
        type: 'worktree.dirty',
        source: 'git',
        payload: { path: '/repo-wt/l', files: [{ path: 'src/a.ts', status: 'modified' }] },
      }),
    ])
    expect(delta.collisions).toEqual([])
  })

  it('an event that is not worktree.dirty contributes nothing, even carrying a files array', () => {
    const delta = projectionsFor([row({ n: 1, type: 'llm.cost', payload: { branch: 'b', files: [{ path: 'a' }] } })])
    expect(delta.collisions).toEqual([])
  })
})

describe('the function is a fold over its input, not an accumulator', () => {
  it('the SAME rows twice produce the SAME delta', () => {
    const rows = [
      row({ n: 1, lane: 'l', payload: { costUsd: 1 } }),
      row({ n: 2, type: 'agent.status', lane: 'l', payload: { handle: 'l', status: 'done' } }),
      row({
        n: 3,
        type: 'worktree.dirty',
        source: 'git',
        payload: { path: '/w', branch: 'l', files: [{ path: 'src/a.ts', status: 'modified' }] },
      }),
    ]
    expect(projectionsFor(rows)).toEqual(projectionsFor(rows))
    // …and it is not vacuous: the delta actually carries all three projections.
    const delta = projectionsFor(rows)
    expect(delta.spend.length).toBe(1)
    expect(delta.lanes.length).toBe(1)
    expect(delta.collisions.length).toBe(1)
  })

  it('an empty input is an empty delta rather than a throw', () => {
    expect(projectionsFor([])).toEqual({ spend: [], lanes: [], collisions: [] })
  })
})
