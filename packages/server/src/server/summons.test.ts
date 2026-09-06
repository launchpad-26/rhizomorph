import { describe, expect, it } from 'vitest'
import { diffSummons, isSummonsKind, type SummonsCondition, type SummonsPoint } from './summons.js'

function condition(overrides: Partial<SummonsCondition> & { lane: string; kind: string }): SummonsCondition {
  return { since: null, ...overrides }
}

describe('isSummonsKind', () => {
  it('excludes the one notice-rank pathology (expensive)', () => {
    expect(isSummonsKind('expensive')).toBe(false)
  })

  it('includes every needs-you/broken-rank pathology', () => {
    expect(isSummonsKind('frozen')).toBe(true)
    expect(isSummonsKind('looping')).toBe(true)
    expect(isSummonsKind('waiting')).toBe(true)
    expect(isSummonsKind('off-fence')).toBe(true)
  })
})

describe('diffSummons', () => {
  it('raises once when a condition first appears', () => {
    const { diff, next } = diffSummons([], [condition({ lane: 'lane-a', kind: 'frozen', since: 100 })], 200)
    expect(diff.raised).toEqual([{ lane: 'lane-a', kind: 'frozen', raisedAt: 100 }])
    expect(diff.cleared).toEqual([])
    expect(next).toEqual([{ lane: 'lane-a', kind: 'frozen' }])
  })

  it('falls back to `now` for raisedAt when the pathology names no `since`', () => {
    const { diff } = diffSummons([], [condition({ lane: 'lane-a', kind: 'frozen', since: null })], 500)
    expect(diff.raised).toEqual([{ lane: 'lane-a', kind: 'frozen', raisedAt: 500 }])
  })

  it('carries `detail` on the raise, straight through from the condition', () => {
    const { diff } = diffSummons(
      [],
      [condition({ lane: 'lane-a', kind: 'waiting', since: 10, detail: 'Read→Edit→Bash ×6, no commit' })],
      50,
    )
    expect(diff.raised).toEqual([
      { lane: 'lane-a', kind: 'waiting', raisedAt: 10, detail: 'Read→Edit→Bash ×6, no commit' },
    ])
  })

  it('MUTATION 1 (DoD): a raise fires once, not once per tick — repeated ticks with the condition unchanged stay at zero new raises', () => {
    const stillFrozen = [condition({ lane: 'lane-a', kind: 'frozen', since: 100 })]
    const first = diffSummons([], stillFrozen, 200)
    expect(first.diff.raised).toHaveLength(1)

    const second = diffSummons(first.next, stillFrozen, 400)
    expect(second.diff.raised).toEqual([])
    expect(second.diff.cleared).toEqual([])
    expect(second.next).toEqual(first.next)

    const third = diffSummons(second.next, stillFrozen, 600)
    expect(third.diff.raised).toEqual([])
    expect(third.diff.cleared).toEqual([])
  })

  it('clears once when a condition that was open disappears', () => {
    const previous: SummonsPoint[] = [{ lane: 'lane-a', kind: 'frozen' }]
    const { diff, next } = diffSummons(previous, [], 900)
    expect(diff.raised).toEqual([])
    expect(diff.cleared).toEqual([{ lane: 'lane-a', kind: 'frozen', clearedAt: 900 }])
    expect(next).toEqual([])
  })

  it('a clear never carries `detail` — the schema does not have one for it', () => {
    const previous: SummonsPoint[] = [{ lane: 'lane-a', kind: 'frozen' }]
    const { diff } = diffSummons(previous, [], 900)
    expect(diff.cleared[0]).not.toHaveProperty('detail')
  })

  it('SIBLING CASE (DoD): a clear with no raise this module ever emitted still fires exactly once — `previous` is exogenous input, not a memory of past raises', () => {
    // Nothing in this test ever called diffSummons to produce `restored` — it
    // stands in for a snapshot loaded fresh off disk after a restart, or a
    // condition whose whole raise-then-clear lifetime fell between two ticks
    // this process never observed either half of.
    const restored: SummonsPoint[] = [{ lane: 'lane-b', kind: 'waiting' }]
    const { diff, next } = diffSummons(restored, [], 1000)
    expect(diff.cleared).toEqual([{ lane: 'lane-b', kind: 'waiting', clearedAt: 1000 }])
    expect(diff.raised).toEqual([])
    expect(next).toEqual([])
  })

  it('one lane can raise and another can clear on the very same tick', () => {
    const previous: SummonsPoint[] = [{ lane: 'lane-a', kind: 'frozen' }]
    const current = [condition({ lane: 'lane-b', kind: 'looping', since: 5 })]
    const { diff, next } = diffSummons(previous, current, 10)
    expect(diff.raised).toEqual([{ lane: 'lane-b', kind: 'looping', raisedAt: 5 }])
    expect(diff.cleared).toEqual([{ lane: 'lane-a', kind: 'frozen', clearedAt: 10 }])
    expect(next).toEqual([{ lane: 'lane-b', kind: 'looping' }])
  })

  it('keys on (lane, kind): the same lane can hold two independent summonses, and two lanes can share a kind without colliding', () => {
    const current = [
      condition({ lane: 'lane-a', kind: 'frozen', since: 1 }),
      condition({ lane: 'lane-a', kind: 'waiting', since: 1 }),
      condition({ lane: 'lane-b', kind: 'waiting', since: 1 }),
    ]
    const { diff, next } = diffSummons([], current, 2)
    expect(next).toHaveLength(3)
    expect(diff.raised).toHaveLength(3)

    // Now lane-a's `frozen` alone clears; the other two stay open.
    const second = diffSummons(
      next,
      [condition({ lane: 'lane-a', kind: 'waiting', since: 1 }), condition({ lane: 'lane-b', kind: 'waiting', since: 1 })],
      3,
    )
    expect(second.diff.cleared).toEqual([{ lane: 'lane-a', kind: 'frozen', clearedAt: 3 }])
    expect(second.diff.raised).toEqual([])
    expect(second.next).toHaveLength(2)
  })

  it('a duplicate (lane, kind) pair within one tick collapses to a single point rather than two', () => {
    const current = [
      condition({ lane: 'lane-a', kind: 'frozen', since: 1, detail: 'first' }),
      condition({ lane: 'lane-a', kind: 'frozen', since: 1, detail: 'second' }),
    ]
    const { diff, next } = diffSummons([], current, 5)
    expect(next).toEqual([{ lane: 'lane-a', kind: 'frozen' }])
    expect(diff.raised).toHaveLength(1)
  })
})
