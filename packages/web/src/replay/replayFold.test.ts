import { fixtureSession, initialSessionState, reduce, reduceAll } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import { foldUpTo, timeRangeOf } from './replayFold.js'

describe('foldUpTo', () => {
  const events = fixtureSession()

  it('matches folding events with ts <= T one at a time through the core reducer', () => {
    const midpoint = events[Math.floor(events.length / 2)]!
    const expected = events
      .filter((event) => event.ts <= midpoint.ts)
      .reduce(reduce, initialSessionState())

    expect(foldUpTo(events, midpoint.ts)).toEqual(expected)
  })

  it('equals reduceAll of the whole log once T reaches the last event', () => {
    const lastTs = events[events.length - 1]!.ts
    expect(foldUpTo(events, lastTs)).toEqual(reduceAll(events))
  })

  it('is the initial state before the first event', () => {
    const firstTs = events[0]!.ts
    expect(foldUpTo(events, firstTs - 1)).toEqual(initialSessionState())
  })

  it('never loses previously observed facts as T advances', () => {
    const early = foldUpTo(events, events[2]!.ts)
    const later = foldUpTo(events, events[5]!.ts)

    expect(Object.keys(later.worktrees).length).toBeGreaterThanOrEqual(
      Object.keys(early.worktrees).length,
    )
    expect(later.eventCount).toBeGreaterThanOrEqual(early.eventCount)
    for (const path of Object.keys(early.worktrees)) {
      expect(later.worktrees[path]).toBeDefined()
    }
  })
})

describe('timeRangeOf', () => {
  it('returns null for an empty log', () => {
    expect(timeRangeOf([])).toBeNull()
  })

  it('spans the first and last event timestamps', () => {
    const events = fixtureSession()
    expect(timeRangeOf(events)).toEqual({
      start: events[0]!.ts,
      end: events[events.length - 1]!.ts,
    })
  })
})
