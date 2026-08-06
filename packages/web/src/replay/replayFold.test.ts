import {
  createEventFactory,
  fixtureSession,
  initialSessionState,
  observeUpcast,
  reduce,
  reduceAll,
  type RhizomorphEvent,
} from '@rhizomorph/core'
import { eraCorpusEntry } from '@rhizomorph/core/src/eras/corpus.js'
import { canonicalStateJson, foldEraRecording } from '@rhizomorph/core/src/eras/fold.js'
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

  /**
   * prd17 ruling 3.4 (#205): folding never re-sorts. A shuffled append order
   * is folded exactly as given — the substantive proof that this changes the
   * *result* when order genuinely matters lives in the dedicated law block
   * below; this just pins that `foldUpTo` doesn't quietly correct the input
   * on its way there.
   */
  it('folds a genuinely unsorted log in exactly the order it was given, never re-sorted', () => {
    const shuffled = [events[2]!, events[0]!, events[1]!, ...events.slice(3)]
    const target = boundaryIndex(sortEvents(shuffled), events[1]!.ts)
    expect(foldUpTo(shuffled, events[1]!.ts)).toEqual(reduceAll(shuffled.slice(0, target)))
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

  it('keeps events in the record\'s own order and builds a separate sorted view for navigation (#205)', () => {
    expect(index.events).toBe(events)
    expect(index.sortedEvents).toEqual(events)
    // this fixture happens to already be ts-ascending, so the two coincide —
    // the dedicated law block below covers a fixture where they do not.
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
    expect(crossed).toHaveLength(boundaryIndex(index.sortedEvents, second) - toFirst.index)
    expect(crossed.length).toBeGreaterThan(0)
  })

  it('a scrub that moves nowhere upcasts nothing — no event was folded', () => {
    const index = buildSessionIndex(fixtureSession())
    const ts = index.events[2]!.ts
    const cursor = foldFrom(index, ts, initialFoldCursor())
    expect(watching(() => foldFrom(index, ts, cursor))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// prd17 ruling 3.4 / #205 — the fold-order law, resolved for replay
// ---------------------------------------------------------------------------

/**
 * THE FOLD-ORDER LAW, IMPLEMENTATION LANE.
 *
 * `reduce.test.ts`'s fold-order law (prd17 ruling 3.4) pinned a real
 * divergence: live folds arrival order, replay folded a `ts`-sorted copy,
 * and because the reducer is order-sensitive, the two paths folded one log
 * to two different states — proven on era-1, a real non-monotonic
 * recording. Lane #204 raised it as a `BLOCKED` and took no side; the
 * operator's ruling (#205) is option 1, "append order is the truth", with
 * the scrubber addressing time through its own index rather than by sorting
 * the fold's input. This block proves the actual functions
 * `useReplaySession` calls — `buildSessionIndex`, `foldFrom`, `foldUpTo` —
 * now honour that ruling: fold order is append order, unconditionally, and
 * the divergence this repo's own real recording exposed is gone.
 */
describe('replay folds append order, never a ts-sorted copy (prd17 ruling 3.4, #205)', () => {
  /**
   * The same interleaved shape `reduce.test.ts`'s fold-order law uses: one
   * log whose ARRIVAL order deliberately disagrees with its TIMESTAMP order,
   * exercising all three ways the reducer is order-sensitive: last-write-wins
   * on a keyed record (`agent.status`), create-vs-delete on a key
   * (`branch.updated`/`branch.removed`), and first-sighting sequence
   * (`commitOrder`).
   */
  function interleaved(): RhizomorphEvent[] {
    const f = createEventFactory()
    return [
      f.sessionStarted({}, { ts: 2_000 }),
      f.agentStatus({ handle: 'a', status: 'working' }, { ts: 5_000 }),
      f.agentStatus({ handle: 'a', status: 'done' }, { ts: 3_000 }),
      f.branchUpdated({ branch: 'lane-a', head: 'sha-a' }, { ts: 6_000 }),
      f.branchRemoved({ branch: 'lane-a' }, { ts: 4_000 }),
      f.commitLanded({ sha: 'sha-2', branch: 'main' }, { ts: 8_000 }),
      f.commitLanded({ sha: 'sha-1', branch: 'main' }, { ts: 7_000 }),
    ]
  }

  function maxTs(events: readonly RhizomorphEvent[]): number {
    return events.reduce((max, event) => Math.max(max, event.ts), -Infinity)
  }

  it('the fixture really is interleaved — this block is vacuous otherwise', () => {
    const events = interleaved()
    const arrival = events.map((event) => event.ts)
    expect(arrival).not.toEqual([...arrival].sort((a, b) => a - b))
  })

  it('buildSessionIndex + foldFrom to the end matches folding the log in its own order, not a ts-sorted one', () => {
    const events = interleaved()
    const index = buildSessionIndex(events)
    const cursor = foldFrom(index, maxTs(events), initialFoldCursor())

    const appendOrderFold = reduceAll(events)
    const tsSortedFold = reduceAll([...events].sort((a, b) => a.ts - b.ts))

    expect(cursor.state).toEqual(appendOrderFold)
    // The reducer really is order-sensitive on this fixture, or this whole
    // law would be untestable by construction.
    expect(JSON.stringify(cursor.state)).not.toBe(JSON.stringify(tsSortedFold))
  })

  it('foldUpTo matches the same append-order fold, independently of buildSessionIndex/foldFrom', () => {
    const events = interleaved()
    expect(foldUpTo(events, maxTs(events))).toEqual(reduceAll(events))
  })

  it('agrees with a plain arrival-order fold on the sharpest form of the old divergence: a branch\'s existence', () => {
    const events = interleaved()
    // Arrival order: branch.updated (ts 6000) then branch.removed (ts 4000)
    // — created, then removed. Gone, however the log addresses time.
    const arrivalOrderState = reduceAll(events)
    expect(arrivalOrderState.branches['lane-a']).toBeUndefined()

    const lastTs = maxTs(events)
    expect(foldUpTo(events, lastTs).branches['lane-a']).toBeUndefined()
    const cursor = foldFrom(buildSessionIndex(events), lastTs, initialFoldCursor())
    expect(cursor.state.branches['lane-a']).toBeUndefined()
  })

  it('fold order does not depend on the keyframe interval — "regardless of the index"', () => {
    const events = interleaved()
    const lastTs = maxTs(events)
    const fine = foldFrom(buildSessionIndex(events, 1), lastTs, initialFoldCursor())
    const coarse = foldFrom(buildSessionIndex(events, 1_000), lastTs, initialFoldCursor())
    expect(fine.state).toEqual(coarse.state)
    expect(fine.state).toEqual(reduceAll(events))
  })

  it('every incremental scrub stop through a non-monotonic log matches the append-order oracle, forward and backward', () => {
    const events = interleaved()
    const index = buildSessionIndex(events)
    expect(index.sortedEvents).not.toEqual(index.events)
    expect(isSorted(index.sortedEvents)).toBe(true)

    let cursor = initialFoldCursor()
    for (const ts of [2_000, 5_000, 3_000, 6_000, 4_000, 8_000, 7_000, 1_000]) {
      cursor = foldFrom(index, ts, cursor)
      expect(cursor.state).toEqual(foldUpTo(events, ts))
    }
  })

  it('the scrub offset is monotonic non-decreasing in ts even though the log itself is not — the timeline tolerates disorder without complaint', () => {
    const events = interleaved()
    const index = buildSessionIndex(events)
    let previous = -1
    for (let ts = 0; ts <= 9_000; ts += 500) {
      const target = boundaryIndex(index.sortedEvents, ts)
      expect(target).toBeGreaterThanOrEqual(previous)
      previous = target
    }
  })

  /**
   * era-1 (`packages/core/src/eras/era-1`) is the real recording lane #204
   * found diverging: this repo's own live session log, non-monotonic in
   * `ts` exactly as `docs/record-format.md` warns a tailed line can be. The
   * committed snapshot is the LOG-ORDER fold (`CAPTURE.md`, `reduce.test.ts`)
   * — the same thing the live dashboard would show. Replay's own machinery
   * must now agree with it, not with a `ts`-sorted re-fold.
   */
  describe('era-1: the real recording #204 found diverging now agrees', () => {
    const recording = eraCorpusEntry('era-1').recordingText

    it('era-1 is genuinely out of order in its own log', () => {
      const { events } = foldEraRecording(recording)
      const arrival = events.map((event) => event.ts)
      expect(arrival).not.toEqual([...arrival].sort((a, b) => a - b))
    })

    it('buildSessionIndex + foldFrom to the end folds era-1 identically to the committed (log-order) snapshot', () => {
      const { events, state: logOrderState } = foldEraRecording(recording)
      const index = buildSessionIndex(events)
      const cursor = foldFrom(index, maxTs(events), initialFoldCursor())
      expect(canonicalStateJson(cursor.state)).toBe(canonicalStateJson(logOrderState))
    })

    it('foldUpTo folds era-1 identically to the committed snapshot too', () => {
      const { events, state: logOrderState } = foldEraRecording(recording)
      expect(canonicalStateJson(foldUpTo(events, maxTs(events)))).toBe(canonicalStateJson(logOrderState))
    })

    it('diverges from what a ts-sort would have produced — the old bug is still detectable, just no longer replay\'s own answer', () => {
      const { events, state: logOrderState } = foldEraRecording(recording)
      const tsSortedState = reduceAll([...events].sort((a, b) => a.ts - b.ts))
      expect(canonicalStateJson(tsSortedState)).not.toBe(canonicalStateJson(logOrderState))
    })
  })
})
