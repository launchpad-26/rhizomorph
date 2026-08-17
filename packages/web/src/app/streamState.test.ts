import {
  createEventFactory,
  initialSessionState,
  opensNewSession,
  reduceAll,
  type RhizomorphEvent,
} from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { boundaryIndex, eventsUpTo, foldUpTo, sortEvents } from '../replay/replayFold.js'
import {
  MAX_EVENTS,
  NEWS_GRACE_MS,
  eventsWindowLabel,
  foldStreamEvent,
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

/**
 * #183's OWN BEFORE/AFTER, measured at the sizes its DoD asks for.
 *
 * The operator felt this ("INCREDIBLY slow right now", 2026-08-05); the
 * conductor then measured a real 55k-event session's live page at 62 long
 * tasks, 224,805 ms of total blocking, one 31,010 ms single task, and zero
 * `requestAnimationFrame` samples during the window — the frame loop starved
 * entirely. The mechanism: `/api/stream` replays a whole fresh session
 * (there's no `Last-Event-ID` yet on first load, #166), and
 * `useEventStream.ts` used to fold every one of those events through its own
 * `setState`, each paying `foldStreamEvent`'s `events: [...state.events,
 * event]` — an O(n) copy per event, O(n²) over the burst. `#183` buffers the
 * burst — one eager fold for the first event, one batched
 * `foldStreamEvents` pass for whatever lands before that fold has actually
 * drained — instead of one `setState` per event. This bench isolates exactly
 * the fold cost that batched pass pays (the mechanism
 * `useEventStream.ts`'s hook now exercises for real); it does not drive a
 * browser event loop, since a synthetic one measures the stub, not the fold.
 *
 * Same discipline as `panels/ledger/perf.test.ts` (#171, itself restating
 * #157): rounds are **interleaved** (one `before` sample, one `after` sample,
 * repeated) so a sibling worktree's test run landing mid-bench inflates both
 * sides equally rather than "finding" a regression that was the load average.
 * Timings are reported, never asserted — a wall clock under concurrent
 * workers measures the box, not the code. The law beside the report is a
 * shape: `before` grows worse than linearly with N (it's the O(n²) burst
 * shape), `after` stays close to linear (a single O(n) pass), and the two
 * folds must agree bit-for-bit at every size — batching must never change
 * *what* gets folded, including which events land as news vs history, only
 * how many `setState`s it costs to fold them.
 *
 * **What it measured, on the dev box** (median of 3 interleaved rounds) — see
 * `useEventStream.ts`'s own docstring for the same table, carried there since
 * that's the file this bench justifies:
 *
 * | N (events) | before (foldStreamEvent, per event) | after (foldStreamEvents, batched) | ratio  |
 * | ---------- | ------------------------------------ | ----------------------------------- | ------ |
 * | 5,000      | 29.4 ms                              | 1.8 ms                              | ~16x   |
 * | 15,000     | 630.1 ms                              | 5.8 ms                              | ~109x  |
 * | 55,000     | 20,880.2 ms                           | 24.5 ms                             | ~851x  |
 *
 * Growth 5k→55k (11x the events): before ~711x the time, after ~13x — the
 * O(n²) shape versus the O(n) shape it should have been.
 *
 * Re-run with `npm test -- packages/web/src/app/streamState.test.ts` and read
 * the `console.log` lines for this box's own numbers.
 */
describe('the live fold cost, before vs after (#183)', () => {
  const SIZES = [5_000, 15_000, 55_000]
  const ROUNDS = 3
  // Generous on purpose: this bench's own O(n²) `before` path genuinely
  // burns real CPU (not a sleep), and under sibling worktrees' own
  // concurrent `npm test` runs sharing the same machine, a single 55k-event
  // call has been observed north of 49s — several such calls happen here
  // (warm-up, the identity check, and `ROUNDS` timed rounds, per size).
  // 300_000ms was enough in isolation and timed out under that contention;
  // this headroom is a hermetic-under-concurrency fix, not a weaker law —
  // every assertion below is unchanged.
  const BENCH_TIMEOUT_MS = 1_200_000
  const connectedAt = Date.UTC(2026, 6, 31, 12, 0, 0)
  const paths = ['/repo/wt-a', '/repo/wt-b', '/repo/wt-c']

  /**
   * `worktree.dirty`, not `commit.landed`, for the same reason
   * `StreamContext.test.tsx`'s `#166` bench picks it: `@rhizomorph/core`'s
   * reducer keeps an ever-growing `commits` map (O(n) to copy per event on
   * its own), which would swamp the number this bench exists to isolate —
   * `streamState.ts`'s own `events: [...state.events, event]` copy. Cycling
   * three worktree paths keeps the core fold O(1) per event.
   *
   * A mix of history and a news tail (the last `NEWS_GRACE_MS` worth) rather
   * than an all-history burst, so the before/after equality check below
   * covers the news/history split too, not just `session`/`events`.
   */
  function burst(n: number): RhizomorphEvent[] {
    const f = createEventFactory({ idPrefix: 'bench-183', stepMs: 1000 })
    return Array.from({ length: n }, (_unused, i) => {
      const path = paths[i % paths.length]!
      const ts = connectedAt - (n - i) * 1000
      return f.worktreeDirty(
        { path, branch: path.split('/').pop()!, files: [{ path: `file-${i}.ts`, status: 'modified' }] },
        { ts },
      )
    })
  }

  function median(samples: readonly number[]): number {
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] as number
  }

  function report(line: string): void {
    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log(line)
  }

  it('reports foldStreamEvent (per event) against foldStreamEvents (batched) at 5k/15k/55k, and proves they agree', () => {
    const rows: { n: number; beforeMs: number; afterMs: number }[] = []

    for (const n of SIZES) {
      const events = burst(n)

      const perEventFold = () =>
        events.reduce((state, event) => foldStreamEvent(state, event), initialStreamState(connectedAt))
      const batchedFold = () => foldStreamEvents(initialStreamState(connectedAt), events)

      // Warm the JIT: the steady state a real reconnect sees, not the first call.
      perEventFold()
      batchedFold()

      // The identity law (#166), reaffirmed at every size this DoD measures:
      // batching must not change one field of the result, news/history split
      // included — never weakened, only exercised at realistic scale.
      expect(batchedFold()).toEqual(perEventFold())

      const beforeSamples: number[] = []
      const afterSamples: number[] = []
      for (let round = 0; round < ROUNDS; round += 1) {
        let started = performance.now()
        const before = perEventFold()
        beforeSamples.push(performance.now() - started)
        expect(before.events).toHaveLength(events.length)

        started = performance.now()
        const after = batchedFold()
        afterSamples.push(performance.now() - started)
        expect(after.events).toHaveLength(events.length)
      }

      const beforeMs = median(beforeSamples)
      const afterMs = median(afterSamples)
      rows.push({ n, beforeMs, afterMs })
      report(
        `N=${n}: before (foldStreamEvent) ${beforeMs.toFixed(3)} ms · ` +
          `after (foldStreamEvents) ${afterMs.toFixed(3)} ms · ` +
          `${(beforeMs / Math.max(afterMs, 0.001)).toFixed(1)}x`,
      )
    }

    report(
      `growth, before: 5k→55k is ${(rows[2]!.beforeMs / Math.max(rows[0]!.beforeMs, 0.001)).toFixed(1)}x ` +
        `for 11x the events (after: ${(rows[2]!.afterMs / Math.max(rows[0]!.afterMs, 0.001)).toFixed(1)}x)`,
    )

    // THE LAW, a shape rather than a pinned number (#157's discipline): the
    // per-event path is genuinely superlinear over the burst (O(n²) from the
    // O(n) copy repeated n times), so 11x the events must cost noticeably
    // more than 11x the time. The batched path is a single O(n) pass, so its
    // own growth must stay well under the per-event path's.
    expect(rows[1]!.beforeMs).toBeGreaterThan(rows[0]!.beforeMs)
    expect(rows[2]!.beforeMs).toBeGreaterThan(rows[1]!.beforeMs)
    const beforeGrowth = rows[2]!.beforeMs / Math.max(rows[0]!.beforeMs, 0.001)
    const afterGrowth = rows[2]!.afterMs / Math.max(rows[0]!.afterMs, 0.001)
    expect(afterGrowth).toBeLessThan(beforeGrowth)
  }, BENCH_TIMEOUT_MS)
})

/**
 * #221: the live fold used to append `events: [...]` with no ceiling at all
 * (#176's original finding, confirmed twice) — an 8-hour session grew the raw
 * buffer without limit. `MAX_EVENTS` bounds it; everything below proves the
 * bound holds, that it holds without moving the fold `session` produces by
 * one bit, and that a reader can tell when it's looking at a trimmed window.
 *
 * `dirtyCorpus` mirrors the `#166`/`#183` benches above: `worktree.dirty`
 * only, cycling three paths, so `@rhizomorph/core`'s own state stays O(1) per
 * event and a 100k+-event corpus is cheap to build and fold — what these
 * tests exercise is `streamState.ts`'s own eviction, not core's bookkeeping.
 */
describe('MAX_EVENTS — the live buffer\'s retention ceiling (#221)', () => {
  const connectedAt = Date.UTC(2026, 6, 31, 12, 0, 0)

  function dirtyCorpus(n: number, startTs: number, idPrefix = 'corpus-221'): RhizomorphEvent[] {
    const f = createEventFactory({ idPrefix, stepMs: 1000 })
    const paths = ['/repo/wt-a', '/repo/wt-b', '/repo/wt-c']
    return Array.from({ length: n }, (_unused, i) => {
      const path = paths[i % paths.length]!
      return f.worktreeDirty(
        { path, branch: path.split('/').pop()!, files: [{ path: `file-${i}.ts`, status: 'modified' }] },
        { ts: startTs + i * 1000 },
      )
    })
  }

  it('retains every event while under the ceiling', () => {
    const events = dirtyCorpus(MAX_EVENTS - 1, connectedAt - (MAX_EVENTS - 1) * 1000)
    const state = foldStreamEvents(initialStreamState(connectedAt), events)
    expect(state.events).toEqual(events)
    expect(state.session.eventCount).toBe(events.length)
  })

  it('caps the retained window at exactly MAX_EVENTS once a batch crosses it, oldest evicted first', () => {
    const overflow = 5_000
    const total = MAX_EVENTS + overflow
    const events = dirtyCorpus(total, connectedAt - total * 1000)

    const state = foldStreamEvents(initialStreamState(connectedAt), events)

    expect(state.events).toHaveLength(MAX_EVENTS)
    // The retained window is exactly the tail — the oldest `overflow` events
    // are gone, and nothing in the middle was dropped instead.
    expect(state.events).toEqual(events.slice(-MAX_EVENTS))
    expect(state.events[0]!.id).toBe(events[overflow]!.id)
    // The fold itself never lost a single event.
    expect(state.session.eventCount).toBe(total)
  })

  /**
   * `foldStreamEvent`'s own eviction, exercised at the ceiling without paying
   * to get there one real fold at a time — that cost (genuinely O(n²)) is
   * what the `#183` bench above measures on purpose; this test only needs a
   * state that is already sitting at the ceiling, which the O(n) batched path
   * builds cheaply and correctly (proven by the test above).
   */
  it('foldStreamEvent evicts the single oldest event once already at the ceiling', () => {
    const events = dirtyCorpus(MAX_EVENTS, connectedAt - MAX_EVENTS * 1000)
    const atCeiling = foldStreamEvents(initialStreamState(connectedAt), events)
    expect(atCeiling.events).toHaveLength(MAX_EVENTS)

    const nextEvent = dirtyCorpus(1, connectedAt + 1_000, 'corpus-221-next')[0]!
    const after = foldStreamEvent(atCeiling, nextEvent)

    expect(after.events).toHaveLength(MAX_EVENTS)
    expect(after.events[0]!.id).toBe(events[1]!.id)
    expect(after.events[after.events.length - 1]).toEqual(nextEvent)
    expect(after.session.eventCount).toBe(events.length + 1)
  })

  /**
   * The law the whole issue turns on, stated as a test: eviction trims the
   * raw window and never the fold. `reduceAll` (core's own, with no notion of
   * a retained window at all) is the oracle "without eviction" reading;
   * `foldStreamEvents` is "with eviction" once the corpus crosses the
   * ceiling. The two must produce the identical projection regardless.
   */
  it('the folded projection is byte-identical with and without eviction, against an oracle reduceAll', () => {
    const belowCeiling = dirtyCorpus(1_000, connectedAt - 1_000 * 1000)
    const aboveCeiling = dirtyCorpus(MAX_EVENTS + 20_000, connectedAt - (MAX_EVENTS + 20_000) * 1000)

    for (const events of [belowCeiling, aboveCeiling]) {
      const folded = foldStreamEvents(initialStreamState(connectedAt), events)
      const oracle = reduceAll(events)
      expect(folded.session).toEqual(oracle)
    }

    // Sanity on the fixture itself: the second corpus actually exercises
    // eviction, or the "with eviction" half of the law above proves nothing.
    expect(aboveCeiling.length).toBeGreaterThan(MAX_EVENTS)
  })

  /**
   * The soak: 100k+ events, folded across many batches the way a real
   * connection would deliver them (`useEventStream`'s buffer-then-flush,
   * `#183`), asserting the retained window never so much as brushes past the
   * ceiling at any point along the way — not just at the end. Deterministic:
   * fixed timestamps throughout, no wall clock, no randomness.
   */
  it('soaks 120k events across many batches; the retained window never exceeds the ceiling', () => {
    const total = 120_000
    const batchSize = 4_000
    const events = dirtyCorpus(total, connectedAt - total * 1000)

    let state = initialStreamState(connectedAt)
    for (let offset = 0; offset < events.length; offset += batchSize) {
      state = foldStreamEvents(state, events.slice(offset, offset + batchSize))
      expect(state.events.length).toBeLessThanOrEqual(MAX_EVENTS)
    }

    expect(state.events).toHaveLength(MAX_EVENTS)
    expect(state.events).toEqual(events.slice(-MAX_EVENTS))
    expect(state.session.eventCount).toBe(total)
  }, 60_000)
})

/**
 * #221's honesty-at-the-boundary law: a surface reading `events` directly
 * must say so once the ceiling has actually trimmed something, and must
 * never say so before that — a bounded window is not the same claim as "the
 * session had exactly this many events."
 */
describe('eventsWindowLabel — the boundary voice (#221)', () => {
  it('is null for a fresh state and for any state under the ceiling', () => {
    expect(eventsWindowLabel(initialStreamState(0))).toBeNull()
    const events = sortEvents(buildSession(200))
    const state = foldStreamEvents(initialStreamState(events[events.length - 1]!.ts), events)
    expect(eventsWindowLabel(state)).toBeNull()
  })

  it('is still null exactly at the ceiling — the boundary voice only speaks once something is actually missing', () => {
    const f = createEventFactory({ idPrefix: 'boundary-221', stepMs: 1000 })
    const events = Array.from({ length: MAX_EVENTS }, (_unused, i) =>
      f.worktreeDirty(
        { path: '/repo/wt-a', branch: 'wt-a', files: [{ path: `file-${i}.ts`, status: 'modified' }] },
        { ts: i * 1000 },
      ),
    )
    const state = foldStreamEvents(initialStreamState(0), events)
    expect(state.events).toHaveLength(MAX_EVENTS)
    expect(state.session.eventCount).toBe(MAX_EVENTS)
    expect(eventsWindowLabel(state)).toBeNull()
  })

  it('names exactly how many events are shown once eviction has trimmed the window', () => {
    const f = createEventFactory({ idPrefix: 'boundary-221b', stepMs: 1000 })
    const total = MAX_EVENTS + 1_234
    const events = Array.from({ length: total }, (_unused, i) =>
      f.worktreeDirty(
        { path: '/repo/wt-a', branch: 'wt-a', files: [{ path: `file-${i}.ts`, status: 'modified' }] },
        { ts: i * 1000 },
      ),
    )
    const state = foldStreamEvents(initialStreamState(0), events)

    expect(state.session.eventCount).toBe(total)
    expect(state.events).toHaveLength(MAX_EVENTS)
    expect(eventsWindowLabel(state)).toBe(`showing the last ${MAX_EVENTS} events`)
  })
})

/**
 * #390 (prd20 wave 3, from the retarget spike's Q5, #265): the live fold was
 * never reset, so retargeting the dashboard at another repo left every
 * worktree, branch, commit and spend fact of the *old* repo folded underneath
 * the new repo's name. `StatusBar` re-reads `/api/meta` on a session-id
 * change, so the heading was already right — which is precisely what made the
 * untouched fold a lie rather than a lag.
 *
 * The trigger is `repoPath` changing on `session.started`, a fact the payload
 * already carries. Deliberately NOT a `session.closed` reason: this lands
 * without #384, and a repo-keyed reset is also right for boundaries that are
 * not retargets at all.
 *
 * The eager-reset direction is the dangerous one, so it gets more tests than
 * the reset itself — a reconnect that wipes good state would be a worse
 * instrument than the bug being fixed.
 */
describe('the session boundary resets the fold (#390 for the repo, #592 for the rotation)', () => {
  const connectedAt = Date.UTC(2026, 7, 10, 12, 0, 0)

  /**
   * One repo's session, with a fact in each of the families the boundary has
   * to clear — a worktree, a branch and a commit — so a fold that kept any of
   * them says which.
   */
  function sessionFor(repo: string, sessionId: string): RhizomorphEvent[] {
    const f = createEventFactory({ idPrefix: repo, startTs: connectedAt, stepMs: 1000 })
    const lane = `${repo}-lane`
    f.sessionStarted({
      sessionId,
      repoPath: `/repos/${repo}`,
      repoName: repo,
      mainBranch: 'main',
    })
    f.worktreeDiscovered({
      path: `/repos/${repo}/${lane}`,
      branch: lane,
      head: `sha-${repo}`,
      isMain: false,
    })
    f.branchUpdated({ branch: lane, head: `sha-${repo}` })
    f.commitLanded({ sha: `sha-${repo}`, branch: lane, message: `work in ${repo}` })
    return f.all()
  }

  const alpha = sessionFor('alpha', 's-alpha-1')
  const beta = sessionFor('beta', 's-beta-1')

  const foldAll = (events: readonly RhizomorphEvent[]) =>
    foldStreamEvents(initialStreamState(connectedAt), events)

  describe('opensNewSession', () => {
    const foldedOnAlpha = foldAll(alpha).session

    it('is true for a session.started naming a different repoPath', () => {
      expect(opensNewSession(foldedOnAlpha, beta[0]!)).toBe(true)
    })

    it('is false for a session.started re-stating the session already folded', () => {
      expect(opensNewSession(foldedOnAlpha, alpha[0]!)).toBe(false)
    })

    it('is false before any session has been folded — nothing to contradict', () => {
      expect(opensNewSession(initialSessionState(), alpha[0]!)).toBe(false)
    })

    it('is false for every event that is not a session.started', () => {
      for (const event of alpha.slice(1)) {
        expect(opensNewSession(foldedOnAlpha, event)).toBe(false)
      }
    })
  })

  it('drops every fact of the old repo when session.started names a different repoPath', () => {
    const folded = foldStreamEvents(foldAll(alpha), beta)

    expect(folded.session.session?.repoPath).toBe('/repos/beta')
    expect(Object.keys(folded.session.worktrees)).toEqual(['/repos/beta/beta-lane'])
    expect(Object.keys(folded.session.branches)).toEqual(['beta-lane'])
    // The commit slice is nested now (#342): `bySha` and `order` are what the
    // flat `commits` Record and `commitOrder` array used to be, so the reset
    // has to be read through both projections rather than the old flat keys.
    expect(Object.keys(folded.session.commits.bySha)).toEqual(['sha-beta'])
    expect(folded.session.commits.order).toEqual(['sha-beta'])

    // The totality claim the three assertions above sample: not one trace of
    // alpha is left anywhere in the fold, under any key.
    expect(JSON.stringify(folded.session)).not.toContain('alpha')
  })

  it('clears the raw window and the news queue with it, keeping connectedAt', () => {
    const folded = foldStreamEvents(foldAll(alpha), beta)

    expect(folded.events).toEqual(beta)
    expect(folded.session.eventCount).toBe(beta.length)
    // Every fixture event is at or after `connectedAt`, so all of beta is news
    // and none of alpha's flares outlived the repo they belonged to.
    expect(folded.news).toEqual(beta)
    expect(folded.newsCount).toBe(beta.length)
    // The news/history boundary belongs to the connection, not the repo.
    expect(folded.connectedAt).toBe(connectedAt)
  })

  it('keeps events.length <= session.eventCount across the boundary', () => {
    const folded = foldStreamEvents(foldAll(alpha), beta)

    // `eventsWindowLabel` reads exactly this pair, so a half-reset that
    // cleared one and not the other would have it comparing two repos.
    expect(folded.events.length).toBeLessThanOrEqual(folded.session.eventCount)
    expect(eventsWindowLabel(folded)).toBeNull()
  })

  it('resets mid-batch when one flush carries both repos', () => {
    // The realistic shape: `useEventStream` coalesces a burst, so the
    // retarget and the new repo's first events arrive in a single fold call.
    const folded = foldAll([...alpha, ...beta])

    expect(folded.session.session?.repoPath).toBe('/repos/beta')
    expect(folded.events).toEqual(beta)
    expect(JSON.stringify(folded.session)).not.toContain('alpha')
  })

  it('folds a boundary identically batched or one at a time (#166/#183 identity law)', () => {
    const combined = [...alpha, ...beta]
    const batched = foldAll(combined)
    const perEvent = combined.reduce(
      (state, event) => foldStreamEvent(state, event),
      initialStreamState(connectedAt),
    )

    expect(batched).toEqual(perEvent)
  })

  it('does NOT reset when a reconnect replays the whole session for the same repo', () => {
    // The #166 path, and the regression most likely to be introduced by an
    // over-eager reset: `EventSource` reconnects on its own with
    // `Last-Event-ID`, the new process's buffer never held that id, and
    // `resumeBacklog` honestly falls back to a full replay — which re-emits
    // `session.started` for the SAME repo.
    const once = foldAll(alpha)
    const replayed = foldStreamEvents(once, alpha)

    expect(replayed.session.session?.repoPath).toBe('/repos/alpha')
    expect(Object.keys(replayed.session.worktrees)).toEqual(
      Object.keys(once.session.worktrees),
    )
    expect(Object.keys(replayed.session.commits)).toEqual(Object.keys(once.session.commits))
    // Absorbed the replay rather than restarting on it.
    expect(replayed.events).toHaveLength(alpha.length * 2)
    expect(replayed.session.eventCount).toBe(alpha.length * 2)
  })

  /**
   * REVERSED BY #592, deliberately and with the reasoning replaced rather than
   * deleted. #390 pinned the opposite — *"an ordinary rotation changes
   * `sessionId`, never `repoPath`. The fleet it describes is the same fleet;
   * dropping it would be a self-inflicted amnesia."* On 2026-08-16 the
   * operator pressed **end session · start fresh** and the instrument carried
   * on exactly as before: the scene did not change, the elapsed figures did
   * not reset, and a refresh changed nothing. What #390 read as amnesia to be
   * avoided is the only thing that makes the operator's own act visible, and
   * it is brief: rotation resets every collector's warm snapshot
   * (`server/api/rotate.ts`) precisely so the new log opens self-contained, so
   * the fleet refills from the new session's own discovery pass.
   *
   * The reasoning now lives on `opensNewSession` in `core/src/reduce.ts`,
   * where it has to be for replay to inherit it (ADR-0002).
   */
  it('DOES reset for an ordinary rotation — a new session id is a new recording (#592)', () => {
    const before = foldAll(alpha)
    const f = createEventFactory({ idPrefix: 'rotation', startTs: connectedAt + 60_000 })
    const rotated = f.sessionStarted({
      sessionId: 's-alpha-2',
      repoPath: '/repos/alpha',
      repoName: 'alpha',
    })
    const after = foldStreamEvent(before, rotated)

    expect(after.session.session?.sessionId).toBe('s-alpha-2')
    // Cleared, not merged — the whole point of the issue.
    expect(Object.keys(after.session.worktrees)).toEqual([])
    expect(Object.keys(after.session.branches)).toEqual([])
    expect(after.session.commits.order).toEqual([])
    // …and the elapsed figures restart from the new recording rather than the
    // one the operator ended. `before` really did hold a longer span, so this
    // is not vacuously true.
    expect(before.session.eventCount).toBeGreaterThan(1)
    expect(after.session.eventCount).toBe(1)
    expect(after.session.firstEventTs).toBe(rotated.ts)
    // The raw window and the flare queue cross with it, so the pair
    // `eventsWindowLabel` reads still describes one recording.
    expect(after.events).toEqual([rotated])
    expect(after.news).toEqual([rotated])
    expect(after.newsCount).toBe(1)
    expect(eventsWindowLabel(after)).toBeNull()
    // The news/history boundary belongs to the connection, not the recording.
    expect(after.connectedAt).toBe(connectedAt)
  })

  it('does NOT reset on the first session.started of a fresh fold', () => {
    const folded = foldAll(alpha)

    expect(folded.events).toEqual(alpha)
    expect(folded.session.eventCount).toBe(alpha.length)
  })
})

/**
 * Two behaviours the #390 review asked to be settled one way or the other.
 * Both are *decisions*, and both are pinned here so that changing them is a
 * deliberate act rather than a silent side effect — the reasoning for
 * `boundary-on-case-difference` lives on `opensNewSession` in
 * `core/src/reduce.ts` (where #592 moved it, so replay inherits it), and the
 * reasoning for `drops-events-that-precede-the-boundary` on
 * `foldStreamEvent` here, since the events it is about are this layer's.
 */
describe('decisions the session boundary pins deliberately (#390 review)', () => {
  const connectedAt = Date.UTC(2026, 7, 10, 12, 0, 0)

  it('boundary-on-case-difference: a case-only spelling resets, by choice', () => {
    // macOS's default filesystem is case-insensitive, so `/repos/Alpha` and
    // `/repos/alpha` can be one directory, and a relaunch spelled differently
    // from the original resets a fold that did not need it. That is the
    // chosen error: case-folding instead would miss a genuine boundary on a
    // case-SENSITIVE filesystem (Linux, which CI runs), where those two paths
    // really are two repositories — and a missed boundary is the lie this
    // whole issue exists to remove, while a spurious reset is only amnesia.
    // The client cannot see which filesystem the server is on, so it prefers
    // the loud error. Flip this only with a way to know.
    const f = createEventFactory({ idPrefix: 'case', startTs: connectedAt })
    const upper = f.sessionStarted({
      sessionId: 's-1',
      repoPath: '/repos/Alpha',
      repoName: 'Alpha',
    })
    const worktree = f.worktreeDiscovered({
      path: '/repos/Alpha/lane',
      branch: 'lane',
      head: 'sha-1',
      isMain: true,
    })
    const lower = f.sessionStarted({
      sessionId: 's-2',
      repoPath: '/repos/alpha',
      repoName: 'alpha',
    })

    const folded = foldStreamEvents(initialStreamState(connectedAt), [upper, worktree])
    expect(opensNewSession(folded.session, lower)).toBe(true)

    const after = foldStreamEvent(folded, lower)
    expect(after.session.session?.repoPath).toBe('/repos/alpha')
    expect(Object.keys(after.session.worktrees)).toEqual([])
  })

  it('drops-events-that-precede-the-boundary: an event ahead of its own session.started is lost, not merged', () => {
    // Not reachable today: the recorder opens a session with `session.started`
    // and nothing carried over, fenced by that module's own `rotate.test.ts`
    // (not cited by path: the recorder namespace law keeps web files clear of
    // that module's paths), and `/api/stream` replays a log in order — so a
    // session's own events always follow its `session.started`. This pins
    // what the fold does if that ever stops holding: the stray event folds
    // onto the OLD repo and is then discarded with it. One event lost, which
    // is the right way round — the alternative is two repositories merged.
    const f = createEventFactory({ idPrefix: 'order', startTs: connectedAt })
    const alphaStart = f.sessionStarted({
      sessionId: 's-alpha',
      repoPath: '/repos/alpha',
      repoName: 'alpha',
    })
    const strayFromBeta = f.worktreeDiscovered({
      path: '/repos/beta/lane',
      branch: 'lane',
      head: 'sha-beta',
      isMain: true,
    })
    const betaStart = f.sessionStarted({
      sessionId: 's-beta',
      repoPath: '/repos/beta',
      repoName: 'beta',
    })

    const folded = foldStreamEvents(initialStreamState(connectedAt), [
      alphaStart,
      strayFromBeta,
      betaStart,
    ])

    expect(folded.session.session?.repoPath).toBe('/repos/beta')
    expect(folded.events).toEqual([betaStart])
    // The stray is gone rather than sitting in beta's fleet as an alpha-era
    // worktree — losing it is the failure mode, and this names it.
    expect(Object.keys(folded.session.worktrees)).toEqual([])
  })
})
