import { beforeEach, describe, expect, it } from 'vitest'
import {
  createEventFactory,
  fixtureSession,
  fixtureTelemetrySession,
  fixtureTraceSpans,
} from './fixtures.js'
import { reduce, reduceAll } from './reduce.js'
import { initialSessionState } from './state.js'

/**
 * The telemetry fold. Records go in whole and in observation order; every total
 * is a selector's job, so what is asserted here is what was *recorded*.
 */

let f = createEventFactory()
beforeEach(() => {
  f = createEventFactory()
})

describe('reduce — llm.usage', () => {
  it('records the request with its tiers, origin and total', () => {
    const state = reduceAll([
      f.llmUsage(
        {
          lane: '33-core',
          role: 'worker',
          model: 'claude-opus-5',
          tokens: { input: 4, output: 100, cacheRead: 9_000, cacheCreation: 200 },
          requestId: 'req_1',
          durationMs: 8_400,
          sessionId: 'sess-a',
        },
        { ts: 5_000 },
      ),
    ])

    expect(state.telemetry.usage).toHaveLength(1)
    expect(state.telemetry.usage[0]).toEqual({
      eventId: 'evt-000001',
      ts: 5_000,
      origin: 'sessionlog',
      lane: '33-core',
      role: 'worker',
      model: 'claude-opus-5',
      tokens: { input: 4, output: 100, cacheRead: 9_000, cacheCreation: 200 },
      totalTokens: 9_304,
      requestId: 'req_1',
      durationMs: 8_400,
      sessionId: 'sess-a',
      worktreePath: '/repo/rhizomorph-wt/feature',
      branch: 'feature',
      thread: null,
    })
  })

  it('takes origin from the envelope, so both collectors stay distinguishable', () => {
    const state = reduceAll([
      // Distinct requestIds: these are two unrelated requests, not a dup pair —
      // see 'cross-collector dedup by requestId' below for the collision case.
      f.llmUsage({ lane: 'a', requestId: 'req_a' }),
      f.llmUsage({ lane: 'a', requestId: 'req_b' }, { source: 'otel' }),
    ])
    expect(state.telemetry.usage.map((record) => record.origin)).toEqual(['sessionlog', 'otel'])
  })

  it('normalises absent optional fields to null rather than dropping them', () => {
    const state = reduceAll([
      f.llmUsage({
        lane: 'a',
        requestId: null,
        durationMs: null,
        sessionId: null,
        worktreePath: null,
        branch: null,
      }),
    ])
    expect(state.telemetry.usage[0]).toMatchObject({
      requestId: null,
      durationMs: null,
      sessionId: null,
      worktreePath: null,
      branch: null,
    })
  })

  it('keeps observation order even when timestamps arrive out of order', () => {
    const state = reduceAll([
      f.llmUsage({ lane: 'a', model: 'first' }, { ts: 9_000 }),
      f.llmUsage({ lane: 'a', model: 'second' }, { ts: 3_000 }),
    ])
    expect(state.telemetry.usage.map((record) => record.model)).toEqual(['first', 'second'])
  })

  describe('cross-collector dedup by requestId', () => {
    const sessionlogTokens = { input: 4, output: 100, cacheRead: 9_000, cacheCreation: 200 }
    const otelTokens = { input: 0, output: 222_678, cacheRead: 0, cacheCreation: 0 }

    it('counts a request once when sessionlog arrives first and OTel repeats it', () => {
      const state = reduceAll([
        f.llmUsage(
          { lane: 'a', requestId: 'req_dup', tokens: sessionlogTokens, sessionId: 'sess-a' },
          { ts: 1_000, source: 'sessionlog' },
        ),
        f.llmUsage(
          { lane: 'a', requestId: 'req_dup', tokens: otelTokens, worktreePath: null, branch: null, sessionId: 'sess-a' },
          { ts: 1_200, source: 'otel' },
        ),
      ])

      expect(state.telemetry.usage).toHaveLength(1)
      expect(state.telemetry.usage[0]).toMatchObject({
        origin: 'sessionlog',
        tokens: sessionlogTokens,
        totalTokens: 9_304,
      })
    })

    it('counts a request once when OTel arrives first and sessionlog repeats it', () => {
      const state = reduceAll([
        f.llmUsage(
          { lane: 'a', requestId: 'req_dup', tokens: otelTokens, worktreePath: null, branch: null, sessionId: 'sess-a' },
          { ts: 1_000, source: 'otel' },
        ),
        f.llmUsage(
          { lane: 'a', requestId: 'req_dup', tokens: sessionlogTokens, sessionId: 'sess-a' },
          { ts: 1_200, source: 'sessionlog' },
        ),
      ])

      // Same requestId, opposite arrival order — sessionlog still wins the
      // tier detail, and the total is the one request's tokens, not both.
      expect(state.telemetry.usage).toHaveLength(1)
      expect(state.telemetry.usage[0]).toMatchObject({
        origin: 'sessionlog',
        tokens: sessionlogTokens,
        totalTokens: 9_304,
      })
    })

    it('fills in attribution the winning side lacks, without letting the loser overwrite what the winner already knows', () => {
      const state = reduceAll([
        // OTel's own sessionId, no worktree/branch — the only new information it carries.
        f.llmUsage(
          {
            lane: 'a',
            requestId: 'req_dup',
            tokens: otelTokens,
            worktreePath: null,
            branch: null,
            sessionId: 'sess-otel-only',
          },
          { ts: 1_000, source: 'otel' },
        ),
        f.llmUsage(
          {
            lane: 'a',
            requestId: 'req_dup',
            tokens: sessionlogTokens,
            worktreePath: '/repo/wt/a',
            branch: 'a',
            sessionId: null,
          },
          { ts: 1_200, source: 'sessionlog' },
        ),
      ])

      expect(state.telemetry.usage[0]).toMatchObject({
        worktreePath: '/repo/wt/a',
        branch: 'a',
        sessionId: 'sess-otel-only',
      })
    })

    it('still accumulates distinct requestIds as separate records', () => {
      const state = reduceAll([
        f.llmUsage({ lane: 'a', requestId: 'req_1' }, { ts: 1_000 }),
        f.llmUsage({ lane: 'a', requestId: 'req_2' }, { ts: 1_100 }),
      ])
      expect(state.telemetry.usage).toHaveLength(2)
      expect(state.telemetry.usage.map((r) => r.requestId)).toEqual(['req_1', 'req_2'])
    })

    it('never dedups null-requestId events against each other', () => {
      const state = reduceAll([
        f.llmUsage({ lane: 'a', requestId: null, model: 'first' }, { ts: 1_000, source: 'otel' }),
        f.llmUsage({ lane: 'a', requestId: null, model: 'second' }, { ts: 1_100, source: 'otel' }),
      ])
      expect(state.telemetry.usage).toHaveLength(2)
      expect(state.telemetry.usage.map((r) => r.model)).toEqual(['first', 'second'])
    })
  })

  describe('residual cross-collector dedup: OTel usage with no requestId', () => {
    // Every OTel `llm.usage` event carries `requestId: null` (parse-metrics.ts
    // never has one to report), so the requestId dedup above never fires for
    // it. Left alone, a session both collectors report on would double every
    // total. Origin precedence closes the gap: sessionlog is the depth
    // collector, so once a session has any sessionlog usage record, OTel's
    // request-less usage for that same session folds away instead of
    // appending — order of arrival aside.
    const sessionlogRecord = (ts: number) =>
      f.llmUsage(
        {
          lane: 'a',
          requestId: 'req_1',
          sessionId: 'sess-a',
          tokens: { input: 1, output: 100, cacheRead: 0, cacheCreation: 0 },
        },
        { ts, source: 'sessionlog' },
      )
    const otelRecord = (ts: number, output = 999) =>
      f.llmUsage(
        {
          lane: 'a',
          requestId: null,
          sessionId: 'sess-a',
          tokens: { input: 0, output, cacheRead: 0, cacheCreation: 0 },
          worktreePath: null,
          branch: null,
        },
        { ts, source: 'otel' },
      )

    it('counts a session once when sessionlog arrives first and OTel repeats it with no requestId', () => {
      const state = reduceAll([sessionlogRecord(1_000), otelRecord(1_100)])
      expect(state.telemetry.usage).toHaveLength(1)
      expect(state.telemetry.usage[0]).toMatchObject({ origin: 'sessionlog', requestId: 'req_1' })
      expect(state.telemetry.usage.reduce((sum, r) => sum + r.tokens.output, 0)).toBe(100)
    })

    it('retroactively folds OTel usage already recorded once sessionlog catches up to the same session', () => {
      const state = reduceAll([otelRecord(1_000), sessionlogRecord(1_100)])
      expect(state.telemetry.usage).toHaveLength(1)
      expect(state.telemetry.usage[0]).toMatchObject({ origin: 'sessionlog', requestId: 'req_1' })
      expect(state.telemetry.usage.reduce((sum, r) => sum + r.tokens.output, 0)).toBe(100)
    })

    it('folds every request-less OTel record for the session, not just the first one seen', () => {
      const state = reduceAll([otelRecord(1_000, 500), otelRecord(1_050, 300), sessionlogRecord(1_100)])
      expect(state.telemetry.usage).toHaveLength(1)
      expect(state.telemetry.usage[0]?.tokens.output).toBe(100)
    })

    it('never folds an OTel-only session — nothing to fold against, so it keeps counting in full', () => {
      const state = reduceAll([
        f.llmUsage(
          {
            lane: 'a',
            requestId: null,
            sessionId: 'sess-otel-only',
            tokens: { input: 0, output: 500, cacheRead: 0, cacheCreation: 0 },
            worktreePath: null,
            branch: null,
          },
          { ts: 1_000, source: 'otel' },
        ),
        f.llmUsage(
          {
            lane: 'a',
            requestId: null,
            sessionId: 'sess-otel-only',
            tokens: { input: 0, output: 300, cacheRead: 0, cacheCreation: 0 },
            worktreePath: null,
            branch: null,
          },
          { ts: 1_100, source: 'otel' },
        ),
      ])
      expect(state.telemetry.usage).toHaveLength(2)
      expect(state.telemetry.usage.reduce((sum, r) => sum + r.tokens.output, 0)).toBe(800)
    })

    it('never joins a null-requestId record that carries no session id at all', () => {
      const state = reduceAll([
        f.llmUsage(
          { lane: 'a', requestId: null, sessionId: null, tokens: { input: 0, output: 1, cacheRead: 0, cacheCreation: 0 } },
          { ts: 1_000, source: 'otel' },
        ),
        f.llmUsage(
          { lane: 'a', requestId: null, sessionId: null, tokens: { input: 0, output: 2, cacheRead: 0, cacheCreation: 0 } },
          { ts: 1_100, source: 'otel' },
        ),
      ])
      expect(state.telemetry.usage).toHaveLength(2)
    })
  })
})

describe('reduce — llm.cost', () => {
  it('records dollars with their authority intact', () => {
    const state = reduceAll([
      f.llmCost({ lane: 'a', costUsd: 0.0588372, authoritative: true }, { ts: 10 }),
      f.llmCost(
        {
          lane: 'a',
          costUsd: 0.5,
          authoritative: false,
          estimateSource: 'pricing-table@litellm',
        },
        { ts: 20, source: 'sessionlog' },
      ),
    ])
    expect(state.telemetry.costs).toHaveLength(2)
    expect(state.telemetry.costs[0]).toMatchObject({
      origin: 'otel',
      costUsd: 0.0588372,
      authoritative: true,
      estimateSource: null,
    })
    expect(state.telemetry.costs[1]).toMatchObject({
      origin: 'sessionlog',
      authoritative: false,
      estimateSource: 'pricing-table@litellm',
    })
  })
})

describe('reduce — cost joins place through sessionId', () => {
  // The audit's §C shape: OTel knows the dollars and the session and nothing
  // about the place; sessionlog knows the session and the place and no dollars.
  const bareCost = (sessionId: string | null, costUsd = 1) => ({
    lane: 'otel-lane',
    role: 'worker' as const,
    costUsd,
    authoritative: true,
    sessionId,
    worktreePath: null,
    branch: null,
  })
  const placedUsage = (sessionId: string) => ({
    lane: 'sessionlog-lane',
    role: 'worker' as const,
    sessionId,
    worktreePath: '/repo/wt/64-cost',
    branch: '64-cost',
  })

  it('places dollars that arrive after the usage that knows where the session runs', () => {
    const state = reduceAll([
      f.llmUsage(placedUsage('sess-64'), { ts: 1_000, source: 'sessionlog' }),
      f.llmCost(bareCost('sess-64'), { ts: 2_000, source: 'otel' }),
    ])
    expect(state.telemetry.costs[0]).toMatchObject({
      costUsd: 1,
      worktreePath: '/repo/wt/64-cost',
      branch: '64-cost',
      placeSource: 'session-join',
    })
  })

  it('places dollars that arrived first, once the usage catches up', () => {
    const state = reduceAll([
      f.llmCost(bareCost('sess-64'), { ts: 1_000, source: 'otel' }),
      f.llmUsage(placedUsage('sess-64'), { ts: 2_000, source: 'sessionlog' }),
    ])
    // Same record, same dollars, same branch — arrival order is not a fact
    // about where the money was spent.
    expect(state.telemetry.costs).toHaveLength(1)
    expect(state.telemetry.costs[0]).toMatchObject({
      costUsd: 1,
      worktreePath: '/repo/wt/64-cost',
      branch: '64-cost',
      placeSource: 'session-join',
    })
  })

  it('joins on the session, not the lane — the two collectors name lanes differently', () => {
    const state = reduceAll([
      f.llmUsage(placedUsage('sess-64'), { ts: 1_000, source: 'sessionlog' }),
      f.llmCost(bareCost('sess-64'), { ts: 2_000, source: 'otel' }),
    ])
    expect(state.telemetry.costs[0]?.lane).toBe('otel-lane')
    expect(state.telemetry.costs[0]?.branch).toBe('64-cost')
  })

  it('keeps unplaceable dollars visible under their lane rather than dropping or guessing them', () => {
    const state = reduceAll([
      f.llmUsage(placedUsage('sess-64'), { ts: 1_000, source: 'sessionlog' }),
      // A different session entirely: nothing in the log says where it ran.
      f.llmCost(bareCost('sess-unknown', 0.25), { ts: 2_000, source: 'otel' }),
    ])
    expect(state.telemetry.costs).toHaveLength(1)
    expect(state.telemetry.costs[0]).toMatchObject({
      lane: 'otel-lane',
      costUsd: 0.25,
      worktreePath: null,
      branch: null,
      placeSource: null,
    })
  })

  it('never joins a cost that carries no session id at all', () => {
    const state = reduceAll([
      f.llmUsage(placedUsage('sess-64'), { ts: 1_000, source: 'sessionlog' }),
      f.llmCost(bareCost(null), { ts: 2_000, source: 'otel' }),
    ])
    expect(state.telemetry.costs[0]).toMatchObject({ branch: null, placeSource: null })
  })

  it('lets the collector that was there outrank the join', () => {
    const state = reduceAll([
      f.llmCost(
        { ...bareCost('sess-64'), worktreePath: '/repo/wt/reported', branch: 'reported' },
        { ts: 1_000, source: 'sessionlog' },
      ),
      f.llmUsage(placedUsage('sess-64'), { ts: 2_000, source: 'sessionlog' }),
    ])
    expect(state.telemetry.costs[0]).toMatchObject({
      worktreePath: '/repo/wt/reported',
      branch: 'reported',
      placeSource: 'source',
    })
  })

  it('completes a half-known place when the missing half arrives later', () => {
    const state = reduceAll([
      // The worktree is learned first, the branch only later.
      f.llmUsage(
        { lane: 'sessionlog-lane', sessionId: 'sess-64', worktreePath: '/repo/wt/64-cost', branch: null },
        { ts: 1_000, source: 'sessionlog' },
      ),
      f.llmCost(bareCost('sess-64'), { ts: 2_000, source: 'otel' }),
      f.llmUsage(placedUsage('sess-64'), { ts: 3_000, source: 'sessionlog' }),
    ])
    expect(state.telemetry.costs[0]).toMatchObject({
      worktreePath: '/repo/wt/64-cost',
      branch: '64-cost',
      placeSource: 'session-join',
    })
  })

  it('records where each session runs, learned from whichever event knew', () => {
    const state = reduceAll([
      f.llmCost(bareCost('sess-64'), { ts: 1_000, source: 'otel' }),
      f.llmUsage(placedUsage('sess-64'), { ts: 2_000, source: 'sessionlog' }),
      // A later bare event must not unlearn the place.
      f.llmCost(bareCost('sess-64'), { ts: 3_000, source: 'otel' }),
    ])
    expect(state.telemetry.sessions['sess-64']).toEqual({
      sessionId: 'sess-64',
      worktreePath: '/repo/wt/64-cost',
      branch: '64-cost',
      firstSeenAt: 1_000,
      lastSeenAt: 3_000,
    })
  })

  it('teaches the bare lane its place too, whichever order the two sides arrive in', () => {
    const costFirst = reduceAll([
      f.llmCost(bareCost('sess-64'), { ts: 1_000, source: 'otel' }),
      f.llmUsage(placedUsage('sess-64'), { ts: 2_000, source: 'sessionlog' }),
    ])
    const usageFirst = reduceAll([
      f.llmUsage(placedUsage('sess-64'), { ts: 1_000, source: 'sessionlog' }),
      f.llmCost(bareCost('sess-64'), { ts: 2_000, source: 'otel' }),
    ])
    for (const state of [costFirst, usageFirst]) {
      expect(state.telemetry.lanes['otel-lane']).toMatchObject({
        worktreePath: '/repo/wt/64-cost',
        branch: '64-cost',
      })
    }
  })

  it('leaves a lane that shares no session with anything placed exactly as bare as it was', () => {
    const state = reduceAll([
      f.llmUsage(placedUsage('sess-64'), { ts: 1_000, source: 'sessionlog' }),
      f.llmCost(bareCost('sess-elsewhere'), { ts: 2_000, source: 'otel' }),
    ])
    expect(state.telemetry.lanes['otel-lane']).toMatchObject({
      worktreePath: null,
      branch: null,
    })
  })

  it('folds the same log to the same state whichever order the pair arrives in', () => {
    const usageEvent = f.llmUsage(placedUsage('sess-64'), { ts: 1_000, source: 'sessionlog' })
    const costEvent = f.llmCost(bareCost('sess-64'), { ts: 2_000, source: 'otel' })
    const usageFirst = reduceAll([usageEvent, costEvent])
    const costFirst = reduceAll([costEvent, usageEvent])
    // Records keep observation order, so compare the placed facts themselves.
    expect(costFirst.telemetry.costs).toEqual(usageFirst.telemetry.costs)
    expect(costFirst.telemetry.sessions).toEqual(usageFirst.telemetry.sessions)
    expect(costFirst.telemetry.lanes).toEqual(usageFirst.telemetry.lanes)
  })

  it('is pure — reconciling does not mutate the state it read', () => {
    const before = reduceAll([f.llmCost(bareCost('sess-64'), { ts: 1_000, source: 'otel' })])
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown
    reduce(before, f.llmUsage(placedUsage('sess-64'), { ts: 2_000, source: 'sessionlog' }))
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot)
  })
})

describe('reduce — the thread dimension', () => {
  it('carries the thread each source named, on all three telemetry records', () => {
    const state = reduceAll([
      f.llmUsage({ lane: 'a', thread: 'subagent' }),
      f.llmCost({ lane: 'a', thread: 'main' }),
      f.toolActivity({ lane: 'a', tool: 'Bash', thread: 'auxiliary' }),
    ])
    expect(state.telemetry.usage[0]?.thread).toBe('subagent')
    expect(state.telemetry.costs[0]?.thread).toBe('main')
    expect(state.telemetry.tools[0]?.thread).toBe('auxiliary')
  })

  it('records "the source did not say" as null, never as main', () => {
    const state = reduceAll([f.llmUsage({ lane: 'a' }), f.llmCost({ lane: 'a' })])
    expect(state.telemetry.usage[0]?.thread).toBeNull()
    expect(state.telemetry.costs[0]?.thread).toBeNull()
  })

  it('keeps the thread the one collector that parsed it reported, across a dedup fold', () => {
    const state = reduceAll([
      f.llmUsage(
        { lane: 'a', requestId: 'req_dup', thread: null, worktreePath: null, branch: null },
        { ts: 1_000, source: 'otel' },
      ),
      f.llmUsage(
        { lane: 'a', requestId: 'req_dup', thread: 'subagent' },
        { ts: 1_100, source: 'sessionlog' },
      ),
    ])
    expect(state.telemetry.usage).toHaveLength(1)
    expect(state.telemetry.usage[0]?.thread).toBe('subagent')
  })
})

describe('reduce — tool.activity', () => {
  it('records the tool, the lane and a role only when one was reported', () => {
    const state = reduceAll([
      f.toolActivity({ lane: 'a', tool: 'Bash', role: 'worker' }, { ts: 1 }),
      f.toolActivity({ lane: 'a', tool: 'Edit', role: null }, { ts: 2 }),
    ])
    expect(state.telemetry.tools.map((record) => [record.tool, record.role])).toEqual([
      ['Bash', 'worker'],
      ['Edit', null],
    ])
  })
})

describe('reduce — the lane index', () => {
  it('learns a lane from whichever telemetry event arrives first', () => {
    const state = reduceAll([
      f.llmCost({ lane: 'conductor', worktreePath: null, branch: null }, { ts: 400 }),
    ])
    expect(state.telemetry.lanes.conductor).toEqual({
      lane: 'conductor',
      worktreePath: null,
      branch: null,
      sessionIds: ['sess-feature'],
      firstSeenAt: 400,
      lastSeenAt: 400,
    })
  })

  it('fills attribution in from the collector that has it, and never unlearns it', () => {
    const state = reduceAll([
      // OTel has no cwd — the lane arrives bare.
      f.llmCost({ lane: 'x', worktreePath: null, branch: null, sessionId: 'sess-x' }, { ts: 100 }),
      // The sessionlog side knows exactly where it lives.
      f.llmUsage({ lane: 'x', worktreePath: '/repo/wt/x', branch: 'x', sessionId: 'sess-x' }, { ts: 200 }),
      // A later bare event must not wipe what we learned.
      f.llmCost({ lane: 'x', worktreePath: null, branch: null, sessionId: 'sess-x' }, { ts: 300 }),
    ])
    expect(state.telemetry.lanes.x).toEqual({
      lane: 'x',
      worktreePath: '/repo/wt/x',
      branch: 'x',
      sessionIds: ['sess-x'],
      firstSeenAt: 100,
      lastSeenAt: 300,
    })
  })

  it('collects distinct session ids in first-sighting order, ignoring repeats', () => {
    const state = reduceAll([
      f.llmUsage({ lane: 'x', sessionId: 'sess-1' }),
      f.llmUsage({ lane: 'x', sessionId: 'sess-2' }),
      f.llmUsage({ lane: 'x', sessionId: 'sess-1' }),
      f.llmUsage({ lane: 'x', sessionId: null }),
    ])
    expect(state.telemetry.lanes.x?.sessionIds).toEqual(['sess-1', 'sess-2'])
  })

  it('holds first/last seen against the clock, not against arrival', () => {
    const state = reduceAll([
      f.llmUsage({ lane: 'x' }, { ts: 9_000 }),
      f.llmUsage({ lane: 'x' }, { ts: 1_000 }),
    ])
    expect(state.telemetry.lanes.x).toMatchObject({ firstSeenAt: 1_000, lastSeenAt: 9_000 })
  })

  it('keeps lanes apart', () => {
    const state = reduceAll([
      f.llmUsage({ lane: 'a' }),
      f.llmUsage({ lane: 'b' }),
      f.toolActivity({ lane: 'c', tool: 'Read' }),
    ])
    expect(Object.keys(state.telemetry.lanes).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('reduce — additivity', () => {
  it('leaves telemetry empty for a log that has none', () => {
    const state = reduceAll(fixtureSession())
    expect(state.telemetry).toEqual({ usage: [], costs: [], tools: [], lanes: {}, sessions: {} })
  })

  it('folds the v0 half of a telemetry log to exactly the same state', () => {
    const withTelemetry = reduceAll(fixtureTelemetrySession())
    const v0Only = reduceAll(fixtureSession())
    for (const key of ['worktrees', 'branches', 'commits', 'commitOrder', 'panes', 'agents', 'collectors', 'errors'] as const) {
      expect(withTelemetry[key], key).toEqual(v0Only[key])
    }
  })

  it('counts telemetry events in the envelope bookkeeping like any other', () => {
    const events = fixtureTelemetrySession()
    const state = reduceAll(events)
    expect(state.eventCount).toBe(events.length)
    expect(state.telemetry.usage.length + state.telemetry.costs.length + state.telemetry.tools.length)
      .toBe(events.length - fixtureSession().length)
  })

  it('is pure — the input state is untouched', () => {
    const before = reduceAll(fixtureTelemetrySession())
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown
    reduce(before, f.llmUsage({ lane: 'new-lane' }))
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot)
  })

  it('does not touch a telemetry-free state object', () => {
    const empty = initialSessionState()
    const next = reduce(empty, f.llmCost({ lane: 'a' }))
    expect(empty.telemetry.costs).toEqual([])
    expect(next.telemetry.costs).toHaveLength(1)
  })

  it('leaves traces empty for a log that has none', () => {
    expect(reduceAll(fixtureTelemetrySession()).traces).toEqual({
      spans: [],
      byTrace: {},
      bySession: {},
    })
  })

  /**
   * prd9's spans are annotation, not spend (ruling 4), so they stay out of the
   * money layer's records AND out of its lane and session indexes — a span must
   * not be able to invent a lane the ledger then reports zero dollars for. The
   * full law is in `events/trace.test.ts`; this is the fold's half of it.
   */
  it('a span writes nothing into the telemetry slice', () => {
    const money = reduceAll(fixtureTelemetrySession())
    const withSpans = reduceAll([
      ...fixtureTelemetrySession(),
      ...fixtureTraceSpans({ lane: 'lane-only-a-span-ever-mentioned' }),
    ])
    expect(withSpans.telemetry).toEqual(money.telemetry)
    expect(Object.keys(withSpans.telemetry.lanes)).not.toContain('lane-only-a-span-ever-mentioned')
    expect(withSpans.traces.spans).toHaveLength(5)
  })
})

describe('fixtureTelemetrySession', () => {
  it('is deterministic — two calls give identical logs', () => {
    expect(fixtureTelemetrySession()).toEqual(fixtureTelemetrySession())
  })

  it('starts with the v0 log, unchanged', () => {
    const v0 = fixtureSession()
    expect(fixtureTelemetrySession().slice(0, v0.length)).toEqual(v0)
  })

  it('advertises the lanes, roles and origins the selectors are tested against', () => {
    const state = reduceAll(fixtureTelemetrySession())
    expect(Object.keys(state.telemetry.lanes).sort()).toEqual([
      '2-core',
      '3-git',
      '7-web',
      'conductor',
    ])
    expect([...new Set(state.telemetry.usage.map((record) => record.role))].sort()).toEqual([
      'auxiliary',
      'conductor',
      'worker',
    ])
    expect([...new Set(state.telemetry.usage.map((record) => record.origin))]).toEqual(['sessionlog'])
    expect([...new Set(state.telemetry.costs.map((record) => record.origin))]).toEqual([
      'otel',
      'sessionlog',
    ])
    expect(state.telemetry.costs.filter((record) => !record.authoritative)).toHaveLength(1)
  })
})
