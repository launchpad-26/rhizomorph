import { beforeEach, describe, expect, it } from 'vitest'
import { createEventFactory } from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import { initialSessionState } from '../state.js'
import {
  DEFAULT_FLATLINE_MS,
  selectFlatlinedPanes,
  selectPaneLiveness,
  selectPaneLivenessIndex,
  selectWorktreeLiveness,
} from './liveness.js'

const REPO = '/repo/rhizomorph'
const wt = (name: string) => `${REPO}-wt/${name}`
const MINUTE = 60_000
const T0 = 1_000_000

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

describe('pane liveness', () => {
  const state = reduceAll([
    f.paneDiscovered({ paneId: '%1', windowName: 'a', worktreePath: wt('a') }, { ts: T0 }),
    f.paneDiscovered({ paneId: '%2', windowName: 'b', worktreePath: wt('b') }, { ts: T0 }),
    f.paneActivity({ paneId: '%1', contentHash: 'h', preview: 'npm test' }, { ts: T0 + 9 * MINUTE }),
    f.paneActivity({ paneId: '%2', contentHash: 'h' }, { ts: T0 + 1 * MINUTE }),
  ])

  it('reports idle time and calls a quiet pane flatlined', () => {
    const now = T0 + 10 * MINUTE
    const index = selectPaneLivenessIndex(state, { now, flatlineMs: 5 * MINUTE })
    expect(index['%1']).toEqual({
      paneId: '%1',
      windowName: 'a',
      worktreePath: wt('a'),
      status: 'active',
      idleMs: MINUTE,
      lastActivityTs: T0 + 9 * MINUTE,
      present: true,
      preview: 'npm test',
    })
    expect(index['%2']).toMatchObject({ status: 'flatline', idleMs: 9 * MINUTE })
  })

  it('treats the threshold as inclusive', () => {
    const at = (idle: number) =>
      selectPaneLivenessIndex(state, { now: T0 + MINUTE + idle, flatlineMs: 5 * MINUTE })['%2']
        ?.status
    expect(at(5 * MINUTE - 1)).toBe('active')
    expect(at(5 * MINUTE)).toBe('flatline')
  })

  it('supports a separate warning threshold', () => {
    const status = (idle: number) =>
      selectPaneLivenessIndex(state, {
        now: T0 + MINUTE + idle,
        flatlineMs: 5 * MINUTE,
        idleMs: 2 * MINUTE,
      })['%2']?.status
    expect(status(MINUTE)).toBe('active')
    expect(status(2 * MINUTE)).toBe('idle')
    expect(status(5 * MINUTE)).toBe('flatline')
  })

  it('defaults to a five-minute flatline threshold', () => {
    expect(DEFAULT_FLATLINE_MS).toBe(5 * MINUTE)
    const statuses = selectPaneLivenessIndex(state, { now: T0 + 7 * MINUTE })
    expect(statuses['%2']?.status).toBe('flatline')
    expect(statuses['%1']?.status).toBe('active')
  })

  it('counts a freshly discovered pane as alive, not silent', () => {
    const fresh = reduceAll([f.paneDiscovered({ paneId: '%9' }, { ts: T0 })])
    expect(selectPaneLiveness(fresh, { now: T0 + 1000 })[0]).toMatchObject({
      status: 'active',
      idleMs: 1000,
    })
  })

  it('marks a closed pane closed however long ago it spoke', () => {
    const closed = reduceAll([
      f.paneDiscovered({ paneId: '%1' }, { ts: T0 }),
      f.paneClosed({ paneId: '%1' }, { ts: T0 + MINUTE }),
    ])
    expect(selectPaneLiveness(closed, { now: T0 + 60 * MINUTE })[0]?.status).toBe('closed')
  })

  it('clamps a clock that runs backwards', () => {
    expect(selectPaneLiveness(state, { now: T0 })[0]?.idleMs).toBeGreaterThanOrEqual(0)
    expect(selectPaneLiveness(state, { now: T0 })).toHaveLength(2)
  })

  it('sorts the quietest pane first', () => {
    const order = selectPaneLiveness(state, { now: T0 + 10 * MINUTE }).map((p) => p.paneId)
    expect(order).toEqual(['%2', '%1'])
  })

  it('lists only flatlines when asked', () => {
    expect(
      selectFlatlinedPanes(state, { now: T0 + 10 * MINUTE, flatlineMs: 5 * MINUTE }).map(
        (p) => p.paneId,
      ),
    ).toEqual(['%2'])
    expect(selectFlatlinedPanes(state, { now: T0 + 10 * MINUTE, flatlineMs: 60 * MINUTE })).toEqual([])
  })

  it('has nothing to say about an empty log', () => {
    expect(selectPaneLiveness(initialSessionState(), { now: T0 })).toEqual([])
  })
})

describe('worktree liveness', () => {
  it('takes the liveliest open pane in the worktree', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: wt('a'), branch: 'a', isMain: false }, { ts: T0 }),
      f.paneDiscovered({ paneId: '%1', worktreePath: wt('a') }, { ts: T0 }),
      f.paneDiscovered({ paneId: '%2', worktreePath: wt('a') }, { ts: T0 }),
      f.paneActivity({ paneId: '%1', contentHash: 'h' }, { ts: T0 + 9 * MINUTE }),
      f.paneActivity({ paneId: '%2', contentHash: 'h' }, { ts: T0 + MINUTE }),
    ])
    expect(selectWorktreeLiveness(state, { now: T0 + 10 * MINUTE, flatlineMs: 5 * MINUTE })[wt('a')]).toEqual({
      worktreePath: wt('a'),
      status: 'active',
      idleMs: MINUTE,
      lastActivityTs: T0 + 9 * MINUTE,
      paneCount: 2,
      livePaneCount: 2,
    })
  })

  it('knows nothing about a worktree with no panes', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: wt('a'), branch: 'a', isMain: false }, { ts: T0 }),
    ])
    expect(selectWorktreeLiveness(state, { now: T0 })[wt('a')]).toMatchObject({
      status: 'unknown',
      idleMs: null,
      lastActivityTs: null,
      paneCount: 0,
    })
  })

  it('calls a worktree closed once all its panes have gone', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: wt('a'), branch: 'a', isMain: false }, { ts: T0 }),
      f.paneDiscovered({ paneId: '%1', worktreePath: wt('a') }, { ts: T0 }),
      f.paneClosed({ paneId: '%1' }, { ts: T0 + MINUTE }),
    ])
    expect(selectWorktreeLiveness(state, { now: T0 + 2 * MINUTE })[wt('a')]).toMatchObject({
      status: 'closed',
      paneCount: 1,
      livePaneCount: 0,
    })
  })

  it('ignores panes that were never mapped to a worktree', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: wt('a'), branch: 'a', isMain: false }, { ts: T0 }),
      f.paneDiscovered({ paneId: '%1', worktreePath: null }, { ts: T0 }),
    ])
    const liveness = selectWorktreeLiveness(state, { now: T0 })
    expect(Object.keys(liveness)).toEqual([wt('a')])
    expect(liveness[wt('a')]?.paneCount).toBe(0)
  })

  it('still reports a pane whose worktree was never discovered', () => {
    const state = reduceAll([f.paneDiscovered({ paneId: '%1', worktreePath: wt('ghost') }, { ts: T0 })])
    expect(selectWorktreeLiveness(state, { now: T0 + 1000 })[wt('ghost')]).toMatchObject({
      status: 'active',
      paneCount: 1,
    })
  })
})
