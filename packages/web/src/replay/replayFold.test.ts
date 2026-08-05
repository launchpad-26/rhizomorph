import {
  createEventFactory,
  fixtureSession,
  initialSessionState,
  observeUpcast,
  reduce,
  reduceAll,
  type RhizomorphEvent,
} from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import {
  boundaryIndex,
  buildSessionIndex,
  eventsUpTo,
  foldFrom,
  foldUpTo,
  initialFoldCursor,
  isSorted,
  lowerBoundaryIndex,
  sortEvents,
  timeRangeOf,
} from './replayFold.js'

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

  it('sorts a genuinely unsorted log defensively rather than folding it out of order', () => {
    const shuffled = [events[2]!, events[0]!, events[1]!, ...events.slice(3)]
    expect(foldUpTo(shuffled, events[1]!.ts)).toEqual(foldUpTo(events, events[1]!.ts))
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

describe('isSorted / sortEvents', () => {
  const events = fixtureSession()

  it('reports an already-sorted log as sorted', () => {
    expect(isSorted(events)).toBe(true)
  })

  it('reports a shuffled log as unsorted', () => {
    const shuffled = [events[1]!, events[0]!, ...events.slice(2)]
    expect(isSorted(shuffled)).toBe(false)
  })

  it('hands back the same reference for an already-sorted log — no wasted allocation', () => {
    expect(sortEvents(events)).toBe(events)
  })

  it('sorts a shuffled log into ts order without dropping or duplicating events', () => {
    const shuffled = [...events].reverse()
    const sorted = sortEvents(shuffled)
    expect(isSorted(sorted)).toBe(true)
    expect(sorted).toHaveLength(events.length)
    expect([...sorted].sort((a, b) => a.ts - b.ts)).toEqual(sorted)
  })
})

describe('boundaryIndex / eventsUpTo', () => {
  const events = fixtureSession()

  it('counts every event at or before T', () => {
    const midpoint = events[Math.floor(events.length / 2)]!
    const expected = events.filter((event) => event.ts <= midpoint.ts).length
    expect(boundaryIndex(events, midpoint.ts)).toBe(expected)
  })

  it('is 0 before the first event and events.length at/after the last', () => {
    expect(boundaryIndex(events, events[0]!.ts - 1)).toBe(0)
    expect(boundaryIndex(events, events[events.length - 1]!.ts)).toBe(events.length)
    expect(boundaryIndex(events, events[events.length - 1]!.ts + 1_000_000)).toBe(events.length)
  })

  it('includes every event sharing the boundary timestamp', () => {
    const tied = [
      { ...events[0]!, ts: 100 },
      { ...events[1]!, ts: 100 },
      { ...events[2]!, ts: 200 },
    ]
    expect(boundaryIndex(tied, 100)).toBe(2)
  })

  it('eventsUpTo slices the same prefix boundaryIndex reports', () => {
    const midpoint = events[Math.floor(events.length / 2)]!
    expect(eventsUpTo(events, midpoint.ts)).toEqual(
      events.filter((event) => event.ts <= midpoint.ts),
    )
  })
})

describe('lowerBoundaryIndex', () => {
  const events = fixtureSession()

  it('counts every event strictly before T — the complement of ts >= T', () => {
    const midpoint = events[Math.floor(events.length / 2)]!
    const expected = events.filter((event) => event.ts < midpoint.ts).length
    expect(lowerBoundaryIndex(events, midpoint.ts)).toBe(expected)
  })

  it('is 0 at/before the first event and events.length strictly after the last', () => {
    expect(lowerBoundaryIndex(events, events[0]!.ts)).toBe(0)
    expect(lowerBoundaryIndex(events, events[0]!.ts - 1)).toBe(0)
    expect(lowerBoundaryIndex(events, events[events.length - 1]!.ts + 1)).toBe(events.length)
  })

  it('excludes every event sharing the boundary timestamp — the point ts >= T starts from', () => {
    const tied = [
      { ...events[0]!, ts: 100 },
      { ...events[1]!, ts: 100 },
      { ...events[2]!, ts: 200 },
    ]
    expect(lowerBoundaryIndex(tied, 100)).toBe(0)
    expect(lowerBoundaryIndex(tied, 200)).toBe(2)
    expect(lowerBoundaryIndex(tied, 201)).toBe(3)
  })

  it('agrees with boundaryIndex off by exactly the events tied on T', () => {
    // boundaryIndex(T) counts ts <= T; lowerBoundaryIndex(T) counts ts < T.
    // The gap between them is exactly the events sharing ts === T.
    const midpoint = events[Math.floor(events.length / 2)]!
    const tiedCount = events.filter((event) => event.ts === midpoint.ts).length
    expect(boundaryIndex(events, midpoint.ts) - lowerBoundaryIndex(events, midpoint.ts)).toBe(
      tiedCount,
    )
  })
})

/**
 * A session with several distinct worktrees/branches/commits, long enough
 * (with a small `keyframeInterval`) to exercise multiple keyframes without
 * needing thousands of events in a hermetic test.
 */
function buildLargeSession(eventCount: number) {
  const f = createEventFactory({ stepMs: 1000 })
  const paths = ['/repo/wt-a', '/repo/wt-b', '/repo/wt-c']

  f.sessionStarted()
  for (const path of paths) {
    f.worktreeDiscovered({
      path,
      branch: path.split('/').pop()!,
      head: 'sha-0',
      isMain: path.endsWith('wt-a'),
    })
  }

  for (let i = 0; i < eventCount; i++) {
    const path = paths[i % paths.length]!
    const branch = path.split('/').pop()!
    if (i % 5 === 0) {
      f.commitLanded({ sha: `sha-${i}`, branch, message: `commit ${i}` })
    } else {
      f.worktreeDirty({ path, branch, files: [{ path: `file-${i}.ts`, status: 'modified' }] })
    }
  }

  return f.all()
}

describe('buildSessionIndex / foldFrom', () => {
  const events = buildLargeSession(240)
  const keyframeInterval = 10
  const index = buildSessionIndex(events, keyframeInterval)

  it('sorts the log once into the index', () => {
    expect(index.events).toEqual(events)
    expect(isSorted(index.events)).toBe(true)
  })

  it('places a keyframe every `keyframeInterval` events, starting at 0', () => {
    expect(index.keyframes[0]).toEqual(initialFoldCursor())
    const expectedIndices = []
    for (let i = keyframeInterval; i <= events.length; i += keyframeInterval) expectedIndices.push(i)
    expect(index.keyframes.slice(1).map((k) => k.index)).toEqual(expectedIndices)
  })

  it('every keyframe state matches a full refold to that point', () => {
    for (const keyframe of index.keyframes) {
      const ts = keyframe.index === 0 ? events[0]!.ts - 1 : events[keyframe.index - 1]!.ts
      expect(keyframe.state).toEqual(foldUpTo(events, ts))
    }
  })

  /**
   * The identity law (#160): whatever path `foldFrom` takes to reach a given
   * `ts` — folding forward from a cache, or restoring a keyframe and folding
   * forward from there — the resulting state is bit-for-bit what a full
   * refold from scratch (`foldUpTo`) produces. Deterministic, not
   * `Math.random`-seeded: `* 137` over the event count produces a spread of
   * indices that revisits the log non-monotonically (i.e. exercises backward
   * jumps) without depending on any RNG.
   */
  it('matches a full refold at many scrub points reached by folding forward tick by tick', () => {
    let cursor = initialFoldCursor()
    for (let i = 0; i < 60; i++) {
      const eventIndex = (i * 137) % events.length
      const ts = events[eventIndex]!.ts
      cursor = foldFrom(index, ts, cursor)
      expect(cursor.state).toEqual(foldUpTo(events, ts))
    }
  })

  it('matches a full refold when every scrub point is reached cold, from the initial cursor', () => {
    for (let i = 0; i < 60; i++) {
      const eventIndex = (i * 137) % events.length
      const ts = events[eventIndex]!.ts
      const cursor = foldFrom(index, ts, initialFoldCursor())
      expect(cursor.state).toEqual(foldUpTo(events, ts))
    }
  })

  it('folds backward scrubs correctly by restoring the nearest keyframe', () => {
    const forwardTs = events[200]!.ts
    const backwardTs = events[5]!.ts

    const atForward = foldFrom(index, forwardTs, initialFoldCursor())
    const atBackward = foldFrom(index, backwardTs, atForward)

    expect(atBackward.state).toEqual(foldUpTo(events, backwardTs))
    expect(atBackward.index).toBeLessThan(atForward.index)
  })

  it('scrubbing is exactly reversible: forward, then back, then forward again lands on identical state', () => {
    const tsA = events[30]!.ts
    const tsB = events[180]!.ts

    let cursor = foldFrom(index, tsA, initialFoldCursor())
    const stateAtAFirst = cursor.state

    cursor = foldFrom(index, tsB, cursor)
    cursor = foldFrom(index, tsA, cursor)
    const stateAtASecond = cursor.state

    expect(stateAtASecond).toEqual(stateAtAFirst)
    expect(stateAtASecond).toEqual(foldUpTo(events, tsA))
  })

  it('returns the same cursor object when ts resolves to the same boundary (no-op re-fold)', () => {
    const ts = events[50]!.ts
    const cursor = foldFrom(index, ts, initialFoldCursor())
    const again = foldFrom(index, ts, cursor)
    expect(again).toBe(cursor)
  })

  it('a coarser keyframe interval still agrees with the fine-grained index and the oracle', () => {
    const coarse = buildSessionIndex(events, 1000)
    const ts = events[150]!.ts
    expect(foldFrom(coarse, ts, initialFoldCursor()).state).toEqual(foldUpTo(events, ts))
  })
})

/**
 * prd17 ruling 3, item 3 — the chokepoint, pinned on the REAL replay path.
 *
 * `reduce.test.ts` already holds a live-shaped fold and a replay-shaped fold to
 * `upcast`. This is the other half of "both paths": the actual functions the
 * dashboard calls when a human scrubs — `buildSessionIndex`, `foldUpTo`,
 * `foldFrom` — proven to route through it too, so the migration seam is reached
 * by the code that ships and not only by a fold a test wrote to look like it.
 */
describe('the replay path routes every event through upcast() (prd17 ruling 3.3)', () => {
  /** Installs the observer and always disposes it, so a leak can't reach the next test. */
  function watching(body: () => void): RhizomorphEvent[] {
    const seen: RhizomorphEvent[] = []
    const dispose = observeUpcast((event) => seen.push(event))
    try {
      body()
    } finally {
      dispose()
    }
    return seen
  }

  const log = () => fixtureSession()

  it('buildSessionIndex upcasts every event as it keyframes the session', () => {
    const events = log()
    expect(watching(() => buildSessionIndex(events))).toHaveLength(events.length)
  })

  it('foldUpTo upcasts exactly the prefix it folds', () => {
    const events = sortEvents(fixtureSession())
    const ts = events[3]!.ts
    const expected = eventsUpTo(events, ts).length
    expect(watching(() => foldUpTo(events, ts))).toHaveLength(expected)
  })

  it('foldFrom upcasts only the events a scrub actually crosses', () => {
    const index = buildSessionIndex(fixtureSession())
    const first = index.events[2]!.ts
    const second = index.events[5]!.ts

    const toFirst = foldFrom(index, first, initialFoldCursor())
    const crossed = watching(() => foldFrom(index, second, toFirst))
    expect(crossed).toHaveLength(boundaryIndex(index.events, second) - toFirst.index)
    expect(crossed.length).toBeGreaterThan(0)
  })

  it('a scrub that moves nowhere upcasts nothing — no event was folded', () => {
    const index = buildSessionIndex(fixtureSession())
    const ts = index.events[2]!.ts
    const cursor = foldFrom(index, ts, initialFoldCursor())
    expect(watching(() => foldFrom(index, ts, cursor))).toEqual([])
  })
})
