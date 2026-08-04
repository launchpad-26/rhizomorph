import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { boundaryIndex, eventsUpTo, foldUpTo, sortEvents } from '../replay/replayFold.js'
import {
  NEWS_GRACE_MS,
  foldStreamEvents,
  initialStreamState,
  replayStreamState,
} from './streamState.js'

/**
 * A session with several distinct worktrees/branches/commits, long enough to
 * exercise many scrub points without needing thousands of events in a
 * hermetic test.
 */
function buildSession(eventCount: number): RhizomorphEvent[] {
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

/** The oracle: what `foldStreamEvents` produces from scratch for a scrub prefix. */
function oracleAt(events: readonly RhizomorphEvent[], ts: number, connectedAt: number) {
  return foldStreamEvents(initialStreamState(connectedAt), eventsUpTo(events, ts))
}

/** `replayStreamState`'s inputs for a scrub prefix, matching what `useReplaySession` hands `StreamContext`. */
function replayAt(events: readonly RhizomorphEvent[], ts: number, connectedAt: number) {
  const prefixLength = boundaryIndex(events, ts)
  const session = foldUpTo(events, ts)
  return replayStreamState(events, prefixLength, session, connectedAt)
}

describe('replayStreamState', () => {
  const events = sortEvents(buildSession(120))
  // Beyond every real timestamp — replay's own news/history boundary
  // (`StreamContext`'s `REPLAY_CONNECTED_AT`), so every event here is history.
  const REPLAY_CONNECTED_AT = Number.MAX_SAFE_INTEGER

  /**
   * The identity law (#160, extended by #162): whatever `useReplaySession`'s
   * cursor cache does to reach a given scrub `ts`, the `StreamState`
   * `replayStreamState` composes from it must be bit-for-bit what an
   * independent full refold (`foldStreamEvents` over `eventsUpTo`) produces.
   * `* 137` over the event count spreads non-monotonically, exercising
   * backward jumps without an RNG.
   */
  it('matches a full refold at many scrub points, forward and backward', () => {
    for (let i = 0; i < 40; i++) {
      const eventIndex = (i * 137) % events.length
      const ts = events[eventIndex]!.ts
      expect(replayAt(events, ts, REPLAY_CONNECTED_AT)).toEqual(
        oracleAt(events, ts, REPLAY_CONNECTED_AT),
      )
    }
  })

  it('scrubbing is exactly reversible: forward, then back, then forward again lands on identical state (#155)', () => {
    const tsA = events[10]!.ts
    const tsB = events[90]!.ts

    const stateAtAFirst = replayAt(events, tsA, REPLAY_CONNECTED_AT)
    expect(replayAt(events, tsB, REPLAY_CONNECTED_AT)).toEqual(oracleAt(events, tsB, REPLAY_CONNECTED_AT))
    const stateAtASecond = replayAt(events, tsA, REPLAY_CONNECTED_AT)

    expect(stateAtASecond).toEqual(stateAtAFirst)
    expect(stateAtASecond).toEqual(oracleAt(events, tsA, REPLAY_CONNECTED_AT))
  })

  it('is the initial state before the first event', () => {
    const firstTs = events[0]!.ts
    expect(replayAt(events, firstTs - 1, REPLAY_CONNECTED_AT)).toEqual(
      initialStreamState(REPLAY_CONNECTED_AT),
    )
  })

  it('replay builds state and lights nothing: news stays empty at every prefix', () => {
    const lastTs = events[events.length - 1]!.ts
    const state = replayAt(events, lastTs, REPLAY_CONNECTED_AT)
    expect(state.news).toEqual([])
    expect(state.newsCount).toBe(0)
    expect(state.events).toEqual(events)
  })

  /**
   * `replayStreamState` doesn't assume news is always empty — it derives the
   * threshold analytically ({@link lowerBoundaryIndex}) — so it must still
   * agree with the oracle for a `connectedAt` that actually splits the log
   * into history and news, the way a live connection's boundary would.
   */
  it('matches the oracle for a connectedAt that actually crosses the log, not just replay\'s constant', () => {
    const connectedAt = events[80]!.ts + NEWS_GRACE_MS
    for (const index of [0, 10, 60, 79, 80, 81, 100, events.length - 1]) {
      const ts = events[index]!.ts
      expect(replayAt(events, ts, connectedAt)).toEqual(oracleAt(events, ts, connectedAt))
    }
  })

  it('caps news at the most recent MAX_NEWS entries, same as the oracle', () => {
    // Every event news (connectedAt before the very first event), on a log
    // longer than the 256 cap.
    const longEvents = sortEvents(buildSession(300))
    const connectedAt = longEvents[0]!.ts
    const ts = longEvents[longEvents.length - 1]!.ts
    expect(replayAt(longEvents, ts, connectedAt)).toEqual(oracleAt(longEvents, ts, connectedAt))
  })
})
