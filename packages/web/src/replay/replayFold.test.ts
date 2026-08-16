import {
  createEventFactory,
  fixtureSession,
  initialSessionState,
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
   * (`commits.order`).
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

/**
 * ADR-0002's half of #592: **one reducer serves both live and replay**, so the
 * session boundary the live fold now honours (`opensNewSession` in
 * `core/src/reduce.ts`) has to be exactly as true of a replayed log — where a
 * `session.started` is simply the line at that position — as it is of the SSE
 * stream. It is not special-cased for "live" anywhere, and this is what proves
 * it: replay's navigation machinery (keyframes, forward ticks, backward
 * scrubs) reaches the boundary by several different routes, and every one of
 * them has to land on the same state.
 *
 * The shape is a real one. A rotation writes a NEW file, so an ordinary replay
 * of one recording never carries two sessions — but an exported record, a
 * concatenation, or a log a rotation appended to can, and #205's own ruling
 * says a record's append order is the truth, so the fold must answer for it.
 */
describe('a replayed log crosses a session boundary the same way live does (#592, ADR-0002)', () => {
  /** Two recordings of the same repo, back to back — the rotation's own shape. */
  function twoSessions(): { events: RhizomorphEvent[]; boundaryAt: number; second: RhizomorphEvent[] } {
    const first = buildLargeSession(120)
    const g = createEventFactory({ idPrefix: 'after', startTs: first[first.length - 1]!.ts + 1_000, stepMs: 1000 })
    g.sessionStarted({ sessionId: 'session-after', repoPath: '/repo', repoName: 'repo', mainBranch: 'main' })
    g.worktreeDiscovered({ path: '/repo/wt-z', branch: 'wt-z', head: 'sha-z', isMain: false })
    g.commitLanded({ sha: 'sha-z', branch: 'wt-z', message: 'after the rotation' })
    const second = g.all()
    return { events: [...first, ...second], boundaryAt: first.length, second }
  }

  const { events, boundaryAt, second } = twoSessions()
  const index = buildSessionIndex(events, 25)
  const endTs = events[events.length - 1]!.ts

  it('the fixture really does put a boundary mid-log, with keyframes either side of it', () => {
    expect(events[boundaryAt]!.type).toBe('session.started')
    expect(index.keyframes.some((k) => k.index < boundaryAt)).toBe(true)
    expect(index.keyframes.some((k) => k.index > boundaryAt)).toBe(true)
  })

  it('the state at the end is the second recording alone — cleared, not merged', () => {
    const whole = foldUpTo(events, endTs)

    expect(whole.session?.sessionId).toBe('session-after')
    expect(Object.keys(whole.worktrees)).toEqual(['/repo/wt-z'])
    expect(whole.commits.order).toEqual(['sha-z'])
    expect(whole.eventCount).toBe(second.length)
    expect(whole.firstEventTs).toBe(second[0]!.ts)
    // …and that really is the whole of it: none of the first recording's
    // worktrees survive anywhere in the fold.
    expect(JSON.stringify(whole)).not.toContain('wt-a')
  })

  it('a forward scrub across the boundary lands where a fold from scratch lands', () => {
    let cursor = initialFoldCursor()
    for (const event of index.sortedEvents) {
      cursor = foldFrom(index, event.ts, cursor)
      expect(canonicalStateJson(cursor.state)).toBe(canonicalStateJson(foldUpTo(events, event.ts)))
    }
    expect(cursor.index).toBe(events.length)
  })

  it('a backward scrub back over the boundary restores the FIRST recording, keyframes and all', () => {
    const atEnd = foldFrom(index, endTs, initialFoldCursor())
    const beforeBoundaryTs = events[boundaryAt - 1]!.ts
    const back = foldFrom(index, beforeBoundaryTs, atEnd)

    // Scrubbing back is not a reset that sticks: the ended recording is right
    // there again, exactly as folding to that point from zero gives it.
    expect(canonicalStateJson(back.state)).toBe(canonicalStateJson(foldUpTo(events, beforeBoundaryTs)))
    expect(back.state.session?.sessionId).toBe('session-fixture')
    expect(Object.keys(back.state.worktrees)).toContain('/repo/wt-a')
  })

  it('replay and live fold the same two-session log to the same state', () => {
    // `foldUpTo` is replay's reference fold; `reduce` one event at a time is
    // what the live stream does. ADR-0002 says these are the same function,
    // and across a boundary that has to stay true.
    const live = events.reduce(reduce, initialSessionState())
    expect(canonicalStateJson(foldUpTo(events, endTs))).toBe(canonicalStateJson(live))
    expect(canonicalStateJson(reduceAll(events))).toBe(canonicalStateJson(live))
  })
})
