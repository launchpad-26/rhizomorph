import { beforeEach, describe, expect, it } from 'vitest'
import type { RhizomorphEvent } from '../events/index.js'
import {
  createEventFactory,
  fixtureSession,
  fixtureTelemetrySession,
  fixtureTraceSpans,
} from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import { initialSessionState } from '../state.js'
import { CONNECTION_SOURCES, selectConnection } from './connection.js'

/**
 * prd19 ruling 2's selector. What is under test is not arithmetic — the sums
 * here are counts and min/max — it is the **honesty** of the answers:
 *
 * - a source nothing has arrived from says so, in `null`s and a zero, because
 *   ruling 4 removes `sourceStatus(undefined) → 'live'` and this is what has to
 *   stand in its place;
 * - a refused export is never counted as flow, which is that same lie in a new
 *   costume;
 * - the transcript-without-telemetry session — Gabe's case — is named;
 * - and every answer is a pure function of the fold, so live, replay and
 *   fixtures cannot disagree about any of it.
 */

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

const refusal = (instance: string | null, count: number, ts: number) =>
  f.make('telemetry.refused', { instance, expectedInstance: 'ours', count }, { ts })

describe('selectConnection — the five sources', () => {
  it('answers for every source it declares, each labelled with its own name', () => {
    const connection = selectConnection(reduceAll(fixtureTelemetrySession()))
    for (const source of CONNECTION_SOURCES) {
      expect(connection[source].source, source).toBe(source)
    }
    expect(CONNECTION_SOURCES).toEqual(['git', 'tmux', 'workmux', 'sessionlog', 'otel'])
  })

  /**
   * The mapping written out against a log small enough to count by hand: one
   * worktree and one commit teach git (plus the branch both of them named), one
   * pane teaches tmux, one handle teaches workmux — and each window is bounded
   * by the timestamps those records actually carry, not by the log's own ends.
   */
  it('bounds each source by the timestamps its own records carry', () => {
    const state = reduceAll([
      f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, { ts: 1_000 }),
      f.paneDiscovered({ paneId: '%1', windowName: 'main', currentPath: '/repo' }, { ts: 2_000 }),
      f.agentStatus({ handle: 'main', status: 'working' }, { ts: 3_000 }),
      f.commitLanded({ sha: 'sha-1', branch: 'main' }, { ts: 4_000 }),
      f.paneActivity({ paneId: '%1', contentHash: 'h-1' }, { ts: 5_000 }),
      f.agentStatus({ handle: 'main', status: 'done' }, { ts: 6_000 }),
    ])
    const connection = selectConnection(state)

    // One worktree, one branch (`main`, named by both git events), one commit.
    expect(connection.git).toEqual({ source: 'git', firstEventTs: 1_000, lastEventTs: 4_000, count: 3 })
    expect(connection.tmux).toEqual({ source: 'tmux', firstEventTs: 2_000, lastEventTs: 5_000, count: 1 })
    expect(connection.workmux).toEqual({ source: 'workmux', firstEventTs: 3_000, lastEventTs: 6_000, count: 1 })
  })

  /**
   * THE RULING 4 LAW, from the selector's end: silence is `null`, never a
   * timestamp and never a stand-in for health. The v0 fixture log has three
   * collectors' worth of data and not one telemetry event, so it is exactly the
   * state that used to render "live" for both telemetry lanes.
   */
  it('says nothing arrived, in nulls and a zero, for a source with no folded records', () => {
    const connection = selectConnection(reduceAll(fixtureSession()))

    // Four worktrees, four branches (main + three lanes), three commits.
    expect(connection.git.count).toBe(11)
    expect(connection.tmux.count).toBe(3)
    expect(connection.workmux.count).toBe(3)
    for (const source of ['git', 'tmux', 'workmux'] as const) {
      expect(connection[source].firstEventTs, source).not.toBeNull()
      expect(connection[source].lastEventTs, source).not.toBeNull()
    }

    for (const source of ['sessionlog', 'otel'] as const) {
      expect(connection[source], source).toEqual({
        source,
        firstEventTs: null,
        lastEventTs: null,
        count: 0,
      })
    }
  })

  it('says nothing arrived from anywhere for a state that folded no events at all', () => {
    const connection = selectConnection(initialSessionState())
    for (const source of CONNECTION_SOURCES) {
      expect(connection[source], source).toEqual({
        source,
        firstEventTs: null,
        lastEventTs: null,
        count: 0,
      })
    }
    expect(connection.uninstrumentedSessions).toEqual([])
  })

  it('splits the money layer by the origin the envelope stamped, never by lane', () => {
    const state = reduceAll([
      f.llmUsage({ lane: 'a', requestId: 'req_s1', sessionId: 'sess-a' }, { ts: 1_000 }),
      f.toolActivity({ lane: 'a', tool: 'Bash', sessionId: 'sess-a' }, { ts: 1_500 }),
      f.llmCost({ lane: 'a', sessionId: 'sess-a' }, { ts: 2_000 }),
      f.agentActiveTime({ lane: 'a', sessionId: 'sess-a' }, { ts: 3_000 }),
    ])
    const connection = selectConnection(state)

    // Both collectors reported the same lane — the split is the envelope's, not
    // the lane's, which is the whole reason a connect page can tell them apart.
    expect(connection.sessionlog).toEqual({
      source: 'sessionlog',
      firstEventTs: 1_000,
      lastEventTs: 1_500,
      count: 2,
    })
    expect(connection.otel).toEqual({
      source: 'otel',
      firstEventTs: 2_000,
      lastEventTs: 3_000,
      count: 2,
    })
  })
})

describe('selectConnection — otel.firstEventTs, the issue\'s stated law', () => {
  /**
   * THE LAW, first clause: it is the timestamp of the first otel-origin folded
   * event. Sessionlog arrives earlier and OTel later, so a selector reading the
   * wrong slice — or reading the envelope's own `firstEventTs` — answers 1,000
   * here instead of 2,000.
   */
  it('equals the timestamp of the first otel-origin folded event', () => {
    const state = reduceAll([
      f.llmUsage({ lane: 'a', requestId: 'req_s1', sessionId: 'sess-a' }, { ts: 1_000 }),
      f.llmCost({ lane: 'a', sessionId: 'sess-a' }, { ts: 2_000 }),
      f.llmCost({ lane: 'a', sessionId: 'sess-a' }, { ts: 3_000 }),
    ])
    expect(state.firstEventTs).toBe(1_000)
    expect(selectConnection(state).otel).toEqual({
      source: 'otel',
      firstEventTs: 2_000,
      lastEventTs: 3_000,
      count: 2,
    })
  })

  /** THE LAW, second clause: `null` for a state that has never seen one. */
  it('is null for a state that has never seen an otel-origin event', () => {
    const sessionlogOnly = reduceAll([
      f.llmUsage({ lane: 'a', requestId: 'req_s1', sessionId: 'sess-a' }, { ts: 1_000 }),
      f.toolActivity({ lane: 'a', tool: 'Bash', sessionId: 'sess-a' }, { ts: 2_000 }),
    ])
    expect(selectConnection(sessionlogOnly).otel.firstEventTs).toBeNull()
    expect(selectConnection(sessionlogOnly).sessionlog.firstEventTs).toBe(1_000)
    expect(selectConnection(reduceAll(fixtureSession())).otel.firstEventTs).toBeNull()
    expect(selectConnection(initialSessionState()).otel.firstEventTs).toBeNull()
  })

  /**
   * THE LAW, third clause: a fold and a refold of one log answer identically —
   * which is what makes live view, replay and fixtures agree by construction
   * rather than by two code paths staying in step.
   *
   * Three refolds, each a different way the same log gets folded in practice:
   * twice from scratch (two browser tabs), and once resumed mid-log (a boot
   * recovery followed by the live stream).
   */
  it('answers identically for a fold and a refold of the same log', () => {
    const log: RhizomorphEvent[] = [
      ...fixtureTelemetrySession(),
      ...fixtureTraceSpans({ lane: '2-core' }),
      refusal('other-rhizomorph', 3, 9_999),
    ]
    const whole = selectConnection(reduceAll(log))
    const again = selectConnection(reduceAll(log))
    const resumed = selectConnection(
      reduceAll(log.slice(10), reduceAll(log.slice(0, 10))),
    )

    expect(again).toEqual(whole)
    expect(resumed).toEqual(whole)
    // Not vacuous: this log really does prove otel flowed.
    expect(whole.otel.firstEventTs).not.toBeNull()
    expect(whole.otel.count).toBeGreaterThan(0)
  })

  /**
   * The strongest form of the same clause, for the one source whose window the
   * law names: min/max are order-free, so two collectors' events arriving in
   * either order bound the same window. "The first otel event" is a fact about
   * the clock, not about which line of the log we read first.
   */
  it('bounds the same window whichever order the pair arrives in', () => {
    const early = f.llmCost({ lane: 'a', sessionId: 'sess-a' }, { ts: 2_000 })
    const late = f.llmCost({ lane: 'a', sessionId: 'sess-a' }, { ts: 3_000 })
    const forwards = selectConnection(reduceAll([early, late])).otel
    const backwards = selectConnection(reduceAll([late, early])).otel
    expect(backwards).toEqual(forwards)
    expect(forwards).toMatchObject({ firstEventTs: 2_000, lastEventTs: 3_000 })
  })

  /**
   * A span is otel flow — `trace.span` has exactly one possible source, our own
   * `/v1/traces` receiver. The timestamps here are deliberately nothing like the
   * spans' own `startTs`/`endTs` (which the fixture defaults leave far away), so
   * this also states WHICH clock the window uses: the envelope's, the moment the
   * export reached us, not the exporting process's account of when it ran.
   */
  it('counts a span as otel flow, by the envelope ts and not the span\'s own clock', () => {
    const state = reduceAll([
      f.traceSpan({ traceId: 't-1', spanId: 's-1', sessionId: 'sess-a' }, { ts: 7_000 }),
      f.traceSpan({ traceId: 't-1', spanId: 's-2', sessionId: 'sess-a' }, { ts: 8_000 }),
    ])
    expect(state.traces.spans[0]?.startTs).not.toBe(7_000)
    expect(selectConnection(state).otel).toEqual({
      source: 'otel',
      firstEventTs: 7_000,
      lastEventTs: 8_000,
      count: 2,
    })
    expect(selectConnection(state).sessionlog.count).toBe(0)
  })

  it('counts a re-delivered span once — the fold is idempotent, so the count is too', () => {
    const state = reduceAll([
      f.traceSpan({ traceId: 't-1', spanId: 's-1', sessionId: 'sess-a' }, { ts: 7_000 }),
      f.traceSpan({ traceId: 't-1', spanId: 's-1', sessionId: 'sess-a' }, { ts: 8_000 }),
    ])
    expect(selectConnection(state).otel).toEqual({
      source: 'otel',
      firstEventTs: 7_000,
      lastEventTs: 7_000,
      count: 1,
    })
  })

  /**
   * THE LOAD-BEARING EXCLUSION. A refused export is telemetry that never landed
   * — the receiver records nothing until identity checks out — so counting one
   * as otel flow would render the exact fleet this PRD exists for, a
   * misconfigured one, as otel VERIFIED with a first-event timestamp. Ruling 3
   * says a refusal is a BROKEN reason carrying its own remedy; the fold keeps it
   * whole in `state.refusals` for that, and this selector must not launder it
   * into proof of the opposite.
   */
  it('never counts a refused export as otel flow — telemetry turned away never arrived', () => {
    const state = reduceAll([refusal('other-rhizomorph', 5, 1_000), refusal(null, 2, 61_000)])
    expect(state.refusals.records).toHaveLength(2)
    expect(selectConnection(state).otel).toEqual({
      source: 'otel',
      firstEventTs: null,
      lastEventTs: null,
      count: 0,
    })
  })

  it('leaves a real otel window exactly where it was when a refusal lands beside it', () => {
    const flowed = [
      f.llmCost({ lane: 'a', sessionId: 'sess-a' }, { ts: 2_000 }),
      f.llmCost({ lane: 'a', sessionId: 'sess-a' }, { ts: 3_000 }),
    ]
    const without = selectConnection(reduceAll(flowed)).otel
    const withRefusal = selectConnection(reduceAll([...flowed, refusal('theirs', 1, 4_000)])).otel
    expect(withRefusal).toEqual(without)
  })
})

describe('selectConnection — the uninstrumented conductor (the PRD\'s evidence case)', () => {
  /**
   * Gabe's case, 2026-08-07: rhizomorph ran, the transcript collector folded the
   * conductor's own activity, and the Claude instance driving it had never
   * exported a single OTel datapoint. Nothing on any surface said so — this is
   * the fact that lets one say it.
   */
  const gabesLog = () => [
    f.llmUsage(
      {
        lane: 'conductor',
        role: 'conductor',
        requestId: 'req_c1',
        sessionId: 'sess-conductor',
        worktreePath: null,
        branch: null,
      },
      { ts: 1_000 },
    ),
    f.toolActivity(
      { lane: 'conductor', tool: 'Bash', role: 'conductor', sessionId: 'sess-conductor' },
      { ts: 2_000 },
    ),
    // A worker lane whose OTel side is exporting perfectly well.
    f.llmUsage({ lane: '2-core', requestId: 'req_w1', sessionId: 'sess-core' }, { ts: 3_000 }),
    f.llmCost({ lane: '2-core', sessionId: 'sess-core' }, { ts: 4_000 }),
  ]

  it('names the session whose transcript folded and whose otel never did', () => {
    expect(selectConnection(reduceAll(gabesLog())).uninstrumentedSessions).toEqual([
      {
        sessionId: 'sess-conductor',
        lanes: ['conductor'],
        roles: ['conductor'],
        firstEventTs: 1_000,
        lastEventTs: 2_000,
      },
    ])
  })

  it('drops the session the moment one otel-origin record arrives for it', () => {
    const fixed = reduceAll([
      ...gabesLog(),
      f.llmCost(
        { lane: 'conductor', role: 'conductor', sessionId: 'sess-conductor', worktreePath: null, branch: null },
        { ts: 5_000 },
      ),
    ])
    expect(selectConnection(fixed).uninstrumentedSessions).toEqual([])
    // …and the row a surface watches flip is the otel one, now proven.
    expect(selectConnection(fixed).otel.firstEventTs).toBe(4_000)
  })

  it('takes a span as proof too — spans are otel\'s alone', () => {
    const withSpan = reduceAll([
      ...gabesLog(),
      f.traceSpan({ traceId: 't-c', spanId: 's-c', sessionId: 'sess-conductor' }, { ts: 5_000 }),
    ])
    expect(selectConnection(withSpan).uninstrumentedSessions).toEqual([])
  })

  it('never names a session otel alone reported — there is no transcript to be missing telemetry for', () => {
    const otelOnly = reduceAll([
      f.llmCost({ lane: 'otel-lane', sessionId: 'sess-otel', worktreePath: null, branch: null }, { ts: 1_000 }),
    ])
    expect(selectConnection(otelOnly).uninstrumentedSessions).toEqual([])
  })

  it('never names a record that carries no session id — nothing to join a fix against', () => {
    const anonymous = reduceAll([
      f.llmUsage({ lane: 'a', requestId: 'req_1', sessionId: null }, { ts: 1_000 }),
    ])
    expect(selectConnection(anonymous).uninstrumentedSessions).toEqual([])
    expect(selectConnection(anonymous).sessionlog.count).toBe(1)
  })

  it('carries every lane and role the transcript reported, and omits a role it did not know', () => {
    const state = reduceAll([
      // Two collectors' names for one session — the case a lane-keyed answer
      // cannot see, which is why this is keyed by session id.
      f.llmUsage({ lane: 'zeta', requestId: 'req_1', sessionId: 'sess-shared' }, { ts: 1_000 }),
      f.llmUsage(
        { lane: 'alpha', role: 'auxiliary', requestId: 'req_2', sessionId: 'sess-shared' },
        { ts: 2_000 },
      ),
      // A tool call whose lane the collector saw without knowing the role.
      f.toolActivity({ lane: 'alpha', tool: 'Read', role: null, sessionId: 'sess-shared' }, { ts: 3_000 }),
    ])
    expect(selectConnection(state).uninstrumentedSessions).toEqual([
      {
        sessionId: 'sess-shared',
        lanes: ['alpha', 'zeta'],
        roles: ['auxiliary', 'worker'],
        firstEventTs: 1_000,
        lastEventTs: 3_000,
      },
    ])
  })

  it('orders them earliest transcript sighting first, with the session id as the only tiebreak', () => {
    const state = reduceAll([
      f.llmUsage({ lane: 'late', requestId: 'req_1', sessionId: 'sess-late' }, { ts: 3_000 }),
      f.llmUsage({ lane: 'early', requestId: 'req_2', sessionId: 'sess-early' }, { ts: 1_000 }),
      f.llmUsage({ lane: 'tie-b', requestId: 'req_3', sessionId: 'sess-b' }, { ts: 2_000 }),
      f.llmUsage({ lane: 'tie-a', requestId: 'req_4', sessionId: 'sess-a' }, { ts: 2_000 }),
    ])
    expect(selectConnection(state).uninstrumentedSessions.map((session) => session.sessionId)).toEqual([
      'sess-early',
      'sess-a',
      'sess-b',
      'sess-late',
    ])
  })

  it('answers the same after a refold, order of arrival aside', () => {
    const log = gabesLog()
    const whole = selectConnection(reduceAll(log)).uninstrumentedSessions
    const resumed = selectConnection(
      reduceAll(log.slice(2), reduceAll(log.slice(0, 2))),
    ).uninstrumentedSessions
    expect(resumed).toEqual(whole)
    expect(whole).toHaveLength(1)
  })
})
