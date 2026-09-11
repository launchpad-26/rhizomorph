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

  /**
   * The sibling of the case above, and the one it could not see: both its rows
   * are `llm.cost` with an empty payload, so `agentStateOf` is null for each and
   * `state` is never varied in either direction. `state` is the field the
   * database cannot correct afterwards — the `lane_state` upsert guards on
   * `EXCLUDED.last_event_ts >= lane_state.last_event_ts`, and a stale state
   * arrives here carrying the batch's MAXIMUM ts, so it is accepted and no
   * later out-of-order batch can displace it. Out-of-order arrival is legal
   * (ADR-0033), so the reversed order is not a hypothetical input.
   */
  it('an OLDER row cannot overwrite a newer row state, in either arrival order', () => {
    const late = Date.UTC(2026, 7, 3, 18)
    const early = Date.UTC(2026, 7, 3, 6)
    const newer = row({ n: 2, type: 'agent.status', lane: 'l', tsMs: late, payload: { handle: 'l', status: 'running' } })
    const older = row({ n: 1, type: 'agent.status', lane: 'l', tsMs: early, payload: { handle: 'l', status: 'idle' } })

    for (const rows of [
      [older, newer],
      [newer, older],
    ]) {
      const lane = projectionsFor(rows).lanes[0]
      expect(lane?.state).toBe('running')
      expect(lane?.lastEventTsMs).toBe(late)
    }
  })

  /**
   * And the property the coalesce exists for, which the fix above must not
   * cost: a newer row that says nothing about status does not erase a status an
   * older row in the same batch carried. `null` is reserved for "this batch
   * said nothing", which is what tells the adapter's `COALESCE` to leave the
   * stored value alone.
   */
  it('a newer row carrying no status keeps the status an older row carried, rather than erasing it', () => {
    const late = Date.UTC(2026, 7, 3, 18)
    const early = Date.UTC(2026, 7, 3, 6)
    const quiet = row({ n: 2, lane: 'l', tsMs: late, payload: { costUsd: 1 } })
    const speaking = row({ n: 1, type: 'agent.status', lane: 'l', tsMs: early, payload: { handle: 'l', status: 'idle' } })

    for (const rows of [
      [speaking, quiet],
      [quiet, speaking],
    ]) {
      const lane = projectionsFor(rows).lanes[0]
      expect(lane?.state).toBe('idle')
      expect(lane?.lastEventTsMs).toBe(late)
    }
  })

  /**
   * THE SHAPE THAT NEEDS THREE ROWS, AND WHY TWO CANNOT SEE IT.
   *
   * "Newer wins" has to be measured against the ts of the row that supplied
   * the field, not against the lane's running maximum. At two rows those are
   * the same number, so the two cases above hold under either reading — which
   * is exactly how a fix that compared against `lastEventTsMs` passed them
   * while leaving the defect open.
   *
   * Add one row that carries no status but the highest ts and they part: it
   * lifts the maximum, and the genuinely newer `agent.status` behind it is then
   * misread as older and dropped. The delta that leaves carries the STALE
   * state stamped with the batch maximum — the one combination the database
   * cannot correct, since `lane_state`'s
   * `EXCLUDED.last_event_ts >= lane_state.last_event_ts` guard accepts it and
   * then refuses the true row when a later batch brings it.
   *
   * Every arrival order is asserted because only some of them are wrong, and
   * which ones depends on the defect: `fold/worker.ts` folds every journal
   * record past the cursor in one call, so the fold does not get to choose.
   */
  it('a row carrying no status cannot make a newer status row look older, in any arrival order', () => {
    const early = Date.UTC(2026, 7, 3, 1)
    const middle = Date.UTC(2026, 7, 3, 3)
    const latest = Date.UTC(2026, 7, 3, 5)
    const stale = row({ n: 1, type: 'agent.status', lane: 'l', tsMs: early, payload: { handle: 'l', status: 'idle' } })
    const truth = row({ n: 2, type: 'agent.status', lane: 'l', tsMs: middle, payload: { handle: 'l', status: 'running' } })
    const quiet = row({ n: 3, lane: 'l', tsMs: latest, payload: { costUsd: 1 } })

    const orders: ReadonlyArray<readonly [string, EventRow[]]> = [
      ['stale, truth, quiet', [stale, truth, quiet]],
      ['stale, quiet, truth', [stale, quiet, truth]],
      ['truth, stale, quiet', [truth, stale, quiet]],
      ['truth, quiet, stale', [truth, quiet, stale]],
      ['quiet, stale, truth', [quiet, stale, truth]],
      ['quiet, truth, stale', [quiet, truth, stale]],
    ]

    expect(orders.map(([name, rows]) => `${name} -> ${projectionsFor(rows).lanes[0]?.state}`)).toEqual(
      orders.map(([name]) => `${name} -> running`),
    )
    // And the ts is still the batch maximum, which is what makes the wrong
    // state permanent rather than merely wrong.
    expect(projectionsFor([stale, quiet, truth]).lanes[0]?.lastEventTsMs).toBe(latest)
  })

  /**
   * The same shape on `worktree`, the field `state` was originally written to
   * match. It has always been coalesced against the running maximum too, so it
   * has always had this defect — the two-row case above cannot see it, and
   * `state`'s fix inherited the reading rather than the bug being new here.
   */
  it('a row carrying no worktree cannot make a newer worktree row look older, in any arrival order', () => {
    const early = Date.UTC(2026, 7, 3, 1)
    const middle = Date.UTC(2026, 7, 3, 3)
    const latest = Date.UTC(2026, 7, 3, 5)
    const stale = row({ n: 1, lane: 'l', tsMs: early, worktree: '/old' })
    const truth = row({ n: 2, lane: 'l', tsMs: middle, worktree: '/new' })
    const quiet = row({ n: 3, lane: 'l', tsMs: latest, payload: { costUsd: 1 } })

    const orders: ReadonlyArray<readonly [string, EventRow[]]> = [
      ['stale, truth, quiet', [stale, truth, quiet]],
      ['stale, quiet, truth', [stale, quiet, truth]],
      ['truth, stale, quiet', [truth, stale, quiet]],
      ['truth, quiet, stale', [truth, quiet, stale]],
      ['quiet, stale, truth', [quiet, stale, truth]],
      ['quiet, truth, stale', [quiet, truth, stale]],
    ]

    expect(orders.map(([name, rows]) => `${name} -> ${projectionsFor(rows).lanes[0]?.worktree}`)).toEqual(
      orders.map(([name]) => `${name} -> /new`),
    )
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
