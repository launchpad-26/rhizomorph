import { describe, expect, it } from 'vitest'
import {
  FIXTURE_START_TS,
  createEventFactory,
  fixtureTelemetrySession,
  fixtureTraceSpans,
} from '../fixtures.js'
import { eventToLine, eventsToJsonl, lineToEvent, parseJsonl } from '../jsonl.js'
import { reduce, reduceAll } from '../reduce.js'
import {
  selectLaneSpend,
  selectModelSpend,
  selectOverheadRatio,
  selectRecentToolActivity,
  selectRoleSpend,
  selectSessionSpend,
  selectSpendByBranch,
  selectSpendByLaneRole,
  selectSpendByWorktree,
  selectSpendRate,
  selectSpendRateByLane,
  selectTelemetryOrigins,
  selectToolUsage,
} from '../selectors/index.js'
import { initialSessionState } from '../state.js'
import { SPAN_KINDS, spanKindSchema, traceSpanPayloadSchema } from './trace.js'
import { createEvent, parseEvent, sourceOf } from './index.js'

/**
 * prd9's keystone. Everything wave A builds against is stated here: the
 * payload's allowlist, the fold's idempotence, and the three laws that make the
 * trace layer safe to add to a money layer that already works.
 */

const VALID = {
  lane: '2-core',
  role: 'worker',
  traceId: 'trace-1',
  spanId: 'span-1',
  parentSpanId: null,
  name: 'claude_code.llm_request',
  kind: 'llm_request',
  startTs: 1_000,
  endTs: 2_000,
  status: 'ok',
} as const

describe('trace.span — the payload', () => {
  it('accepts the minimum a span must always know', () => {
    const parsed = traceSpanPayloadSchema.parse(VALID)
    expect(parsed.parentSpanId).toBeNull()
    expect(parsed.model).toBeUndefined()
    expect(parsed.tokens).toBeUndefined()
  })

  it('carries the same attribution as every prd1 telemetry payload', () => {
    const parsed = traceSpanPayloadSchema.parse({
      ...VALID,
      sessionId: 'sess-a',
      worktreePath: '/repo/wt/2-core',
      branch: '2-core',
      thread: 'subagent',
    })
    expect(parsed.sessionId).toBe('sess-a')
    expect(parsed.thread).toBe('subagent')
    // Role is required, exactly as on `llm.usage`: never guessed from a lane name.
    expect(() => traceSpanPayloadSchema.parse({ ...VALID, role: undefined })).toThrow()
    expect(() => traceSpanPayloadSchema.parse({ ...VALID, lane: '' })).toThrow()
  })

  it('takes ANY raw span name — beta churn is data, not schema', () => {
    for (const name of [
      'claude_code.interaction',
      'claude_code.tool.blocked_on_user',
      'session_task.turn',
      'some.name.the.beta.invents.next',
    ]) {
      expect(traceSpanPayloadSchema.parse({ ...VALID, name, kind: 'other' }).name).toBe(name)
    }
    // …and nothing else: an empty name is a parser bug, not a new span type.
    expect(() => traceSpanPayloadSchema.parse({ ...VALID, name: '' })).toThrow()
  })

  it('takes only the stable kinds, with `other` as the catch-all', () => {
    expect([...spanKindSchema.options]).toEqual([...SPAN_KINDS])
    expect(SPAN_KINDS).toContain('other')
    for (const kind of SPAN_KINDS) {
      expect(traceSpanPayloadSchema.parse({ ...VALID, kind }).kind).toBe(kind)
    }
    expect(() => traceSpanPayloadSchema.parse({ ...VALID, kind: 'llm.request' })).toThrow()
  })

  it('keeps `unset` distinct from `ok`, and `unknown` a real decision', () => {
    expect(traceSpanPayloadSchema.parse({ ...VALID, status: 'unset' }).status).toBe('unset')
    expect(() => traceSpanPayloadSchema.parse({ ...VALID, status: 'success' })).toThrow()
    expect(
      traceSpanPayloadSchema.parse({ ...VALID, kind: 'tool_blocked', decision: 'unknown' }).decision,
    ).toBe('unknown')
    expect(() => traceSpanPayloadSchema.parse({ ...VALID, decision: 'allowed' })).toThrow()
  })

  it('requires both ends of the span, because a span only exports once it has ended', () => {
    expect(() => traceSpanPayloadSchema.parse({ ...VALID, endTs: undefined })).toThrow()
    expect(() => traceSpanPayloadSchema.parse({ ...VALID, startTs: -1 })).toThrow()
    expect(() => traceSpanPayloadSchema.parse({ ...VALID, startTs: 1.5 })).toThrow()
  })

  /**
   * prd9 ruling 5, stated structurally. This list IS the privacy boundary: the
   * capture confirms `user.email`, `user.account_*`, `organization.id` and a
   * `user_prompt` attribute ride on every span, and none of them has anywhere
   * to land. Widening this test is how a future field gets noticed.
   */
  it('has a fixed allowlist of fields — and no attributes map', () => {
    expect(Object.keys(traceSpanPayloadSchema.shape).sort()).toEqual(
      [
        'agentId',
        'branch',
        'decision',
        'endTs',
        'kind',
        'lane',
        'model',
        'name',
        'parentAgentId',
        'parentSpanId',
        'requestId',
        'role',
        'sessionId',
        'spanId',
        'startTs',
        'status',
        'subagentType',
        'thread',
        'tokens',
        'toolName',
        'toolUseId',
        'traceId',
        'ttftMs',
        'worktreePath',
      ].sort(),
    )
    for (const field of ['attributes', 'attrs', 'resourceAttributes', 'raw']) {
      expect(Object.keys(traceSpanPayloadSchema.shape)).not.toContain(field)
    }
  })

  it('strips what the exporter sends that we never asked for', () => {
    const parsed = traceSpanPayloadSchema.parse({
      ...VALID,
      'user.email': 'someone@example.com',
      'organization.id': 'org-123',
      user_prompt: 'the actual text of what the human typed',
      attributes: { 'user.account_uuid': 'acct-1' },
    })
    expect(parsed).not.toHaveProperty('user.email')
    expect(parsed).not.toHaveProperty('attributes')
    expect(JSON.stringify(parsed)).not.toContain('example.com')
    expect(JSON.stringify(parsed)).not.toContain('the actual text')
  })
})

describe('trace.span — the envelope', () => {
  it('comes off our own OTLP receiver and nowhere else', () => {
    expect(sourceOf('trace.span')).toBe('otel')
    const event = createEvent('trace.span', VALID, { id: 'evt-1', ts: 3_000 })
    expect(event.source).toBe('otel')
    expect(
      parseEvent({ id: 'evt-1', ts: 3_000, source: 'sessionlog', type: 'trace.span', payload: VALID })
        .ok,
    ).toBe(false)
  })

  it('throws at the boundary on a payload no parser should have built', () => {
    expect(() =>
      // @ts-expect-error — a span with no trace is not a span
      createEvent('trace.span', { ...VALID, traceId: undefined }, { id: 'evt-1', ts: 1 }),
    ).toThrow()
  })
})

describe('trace.span — the fold', () => {
  it('stores the span whole, in observation order, and indexes it', () => {
    const f = createEventFactory({ idPrefix: 'tr' })
    const event = f.traceSpan(
      {
        lane: '2-core',
        traceId: 'trace-a',
        spanId: 'span-a',
        parentSpanId: 'span-root',
        sessionId: 'sess-a',
        worktreePath: '/repo/wt/2-core',
        branch: '2-core',
      },
      { ts: 7_000 },
    )
    const state = reduceAll([event])

    expect(state.traces.spans).toHaveLength(1)
    expect(state.traces.spans[0]).toEqual({
      eventId: 'tr-000001',
      ts: 7_000,
      lane: '2-core',
      role: 'worker',
      thread: null,
      sessionId: 'sess-a',
      worktreePath: '/repo/wt/2-core',
      branch: '2-core',
      traceId: 'trace-a',
      spanId: 'span-a',
      parentSpanId: 'span-root',
      name: 'claude_code.llm_request',
      kind: 'llm_request',
      startTs: FIXTURE_START_TS,
      endTs: FIXTURE_START_TS + 9_400,
      status: 'ok',
      model: 'claude-opus-5',
      tokens: { input: 2, output: 1_700, cacheRead: 99_700, cacheCreation: 1_900 },
      ttftMs: 1_200,
      requestId: 'req_fixture_1',
      agentId: null,
      parentAgentId: null,
      toolName: null,
      toolUseId: null,
      subagentType: null,
      decision: null,
    })
    expect(state.traces.byTrace).toEqual({ 'trace-a': [0] })
    expect(state.traces.bySession).toEqual({ 'sess-a': [0] })
  })

  it('keeps a whole tree in arrival order, leaves before root', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    expect(state.traces.spans.map((span) => span.kind)).toEqual([
      'llm_request',
      'tool_blocked',
      'tool_execution',
      'tool',
      'interaction',
    ])
    expect(state.traces.byTrace['trace-2-core-1']).toEqual([0, 1, 2, 3, 4])
    expect(state.traces.bySession['sess-2-core']).toEqual([0, 1, 2, 3, 4])
    // The root arrives last and is the only span with no parent.
    const roots = state.traces.spans.filter((span) => span.parentSpanId === null)
    expect(roots.map((span) => span.spanId)).toEqual(['trace-2-core-1-interaction'])
  })

  it('does not index a span that named no session', () => {
    const f = createEventFactory()
    const state = reduceAll([f.traceSpan({ sessionId: null })])
    expect(state.traces.spans[0]?.sessionId).toBeNull()
    expect(state.traces.bySession).toEqual({})
  })

  it('separates two traces, and lets a session own both', () => {
    const state = reduceAll([
      ...fixtureTraceSpans({ lane: '2-core', traceId: 'trace-1' }),
      ...fixtureTraceSpans({ lane: '2-core', traceId: 'trace-2', idPrefix: 'span-2-core-b' }),
    ])
    expect(Object.keys(state.traces.byTrace).sort()).toEqual(['trace-1', 'trace-2'])
    expect(state.traces.byTrace['trace-1']).toEqual([0, 1, 2, 3, 4])
    expect(state.traces.byTrace['trace-2']).toEqual([5, 6, 7, 8, 9])
    expect(state.traces.bySession['sess-2-core']).toHaveLength(10)
  })

  it('keys identity on the pair — the same span id in another trace is another span', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.traceSpan({ traceId: 'trace-a', spanId: 'shared' }),
      f.traceSpan({ traceId: 'trace-b', spanId: 'shared' }),
    ])
    expect(state.traces.spans).toHaveLength(2)
    expect(state.traces.byTrace).toEqual({ 'trace-a': [0], 'trace-b': [1] })
  })

  it('is pure — a span-free state object is not touched', () => {
    const empty = initialSessionState()
    const next = reduce(empty, createEventFactory().traceSpan())
    expect(empty.traces.spans).toEqual([])
    expect(next.traces.spans).toHaveLength(1)
    expect(next.traces).not.toBe(empty.traces)
  })

  it('leaves the unknown-type forward-compat guard intact', () => {
    const state = reduceAll([createEventFactory().traceSpan()])
    const fromTheFuture = {
      id: 'evt-future',
      ts: 99_000,
      source: 'otel',
      type: 'trace.link',
      payload: {},
    } as never
    const next = reduce(state, fromTheFuture)
    expect(next.traces).toEqual(state.traces)
    expect(next.eventCount).toBe(state.eventCount + 1)
  })
})

// --- the laws ---------------------------------------------------------------

/**
 * prd9 ruling 4. `llm_request` spans carry the same four tiers the money layer
 * already counts from `llm.usage`, so a span that reached a spend selector
 * would double every number in the ledger. The law is not "the parser is
 * careful"; it is that spans live in their own slice and no spend selector
 * reads it.
 */
describe('law — no spend from spans', () => {
  const NOW = FIXTURE_START_TS + 10 * 60_000
  const spans = [
    ...fixtureTraceSpans({ lane: '2-core' }),
    ...fixtureTraceSpans({ lane: '3-git' }),
  ]

  it('a state built from only spans is indistinguishable from an empty one', () => {
    const state = reduceAll(spans)
    const empty = initialSessionState()

    // Every span above carries tokens, a model, a lane and a tool name.
    expect(state.traces.spans.filter((span) => span.tokens !== null).length).toBeGreaterThan(0)

    expect(selectSessionSpend(state)).toEqual(selectSessionSpend(empty))
    expect(selectSessionSpend(state).tokens.total).toBe(0)
    expect(selectSessionSpend(state).costUsd).toBe(0)
    // Not "$0.00 spent" — "we counted no dollars at all".
    expect(selectSessionSpend(state).costIsAuthoritative).toBeNull()
    expect(selectSessionSpend(state).requestCount).toBe(0)

    expect(selectLaneSpend(state)).toEqual([])
    expect(selectSpendByWorktree(state)).toEqual({})
    expect(selectSpendByBranch(state)).toEqual([])
    expect(selectSpendByLaneRole(state)).toEqual([])
    expect(selectModelSpend(state)).toEqual([])
    expect(selectRoleSpend(state)).toEqual(selectRoleSpend(empty))
    expect(selectOverheadRatio(state)).toBeNull()
    expect(selectSpendRate(state, { now: NOW })).toEqual(selectSpendRate(empty, { now: NOW }))
    expect(selectSpendRateByLane(state, { now: NOW })).toEqual({})
    expect(selectToolUsage(state)).toEqual([])
    expect(selectRecentToolActivity(state)).toEqual([])
    expect(selectTelemetryOrigins(state)).toEqual([])
    expect(state.telemetry).toEqual(empty.telemetry)
  })

  it('spans change no number in a log that DOES have spend', () => {
    const money = fixtureTelemetrySession()
    const before = reduceAll(money)
    const after = reduceAll([...money, ...spans])

    expect(after.traces.spans).toHaveLength(spans.length)
    expect(after.telemetry).toEqual(before.telemetry)
    expect(selectSessionSpend(after)).toEqual(selectSessionSpend(before))
    expect(selectLaneSpend(after)).toEqual(selectLaneSpend(before))
    expect(selectModelSpend(after)).toEqual(selectModelSpend(before))
    expect(selectRoleSpend(after)).toEqual(selectRoleSpend(before))
    expect(selectToolUsage(after)).toEqual(selectToolUsage(before))
    expect(selectSpendRate(after, { now: NOW })).toEqual(selectSpendRate(before, { now: NOW }))
  })
})

/**
 * Whether the beta exporter re-delivers was never established (research §Open
 * questions 7), and a replayed log can hand the fold the same span twice
 * anyway. Cheap insurance, stated as a law so no wave-A lane has to wonder.
 */
describe('law — idempotent re-delivery', () => {
  it('folds the same (traceId, spanId) twice into one record', () => {
    const event = createEventFactory().traceSpan({ traceId: 'trace-a', spanId: 'span-a' })
    const state = reduceAll([event, event])
    expect(state.traces.spans).toHaveLength(1)
    expect(state.traces.byTrace['trace-a']).toEqual([0])
    expect(state.traces.bySession['sess-feature']).toEqual([0])
    // The event still happened — it is the span that is not duplicated.
    expect(state.eventCount).toBe(2)
  })

  it('keeps the first delivery when a re-delivery arrives with a new envelope', () => {
    const f = createEventFactory({ idPrefix: 'redeliver' })
    const first = f.traceSpan({ traceId: 'trace-a', spanId: 'span-a' }, { ts: 1_000 })
    const again = f.traceSpan({ traceId: 'trace-a', spanId: 'span-a', status: 'error' }, { ts: 9_000 })
    const state = reduceAll([first, again])
    expect(state.traces.spans).toHaveLength(1)
    expect(state.traces.spans[0]?.eventId).toBe('redeliver-000001')
    expect(state.traces.spans[0]?.ts).toBe(1_000)
    expect(state.traces.spans[0]?.status).toBe('ok')
  })

  it('survives a whole tree delivered twice', () => {
    const tree = fixtureTraceSpans({ lane: '2-core' })
    const once = reduceAll(tree)
    const twice = reduceAll([...tree, ...tree])
    expect(twice.traces).toEqual(once.traces)
    expect(twice.eventCount).toBe(once.eventCount * 2)
  })
})

/** A span must fold the same whether it came off the wire or off the disk. */
describe('law — JSONL roundtrip', () => {
  it('one span survives stringify → parse → reduce identically', () => {
    const event = createEventFactory().traceSpan({ thread: 'subagent', decision: 'accept' })
    const line = eventToLine(event)
    const read = lineToEvent(line)
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.error)
    expect(read.event).toEqual(event)
    expect(reduceAll([read.event])).toEqual(reduceAll([event]))
  })

  it('a whole tree survives a round through the log', () => {
    const tree = fixtureTraceSpans({ lane: '7-web' })
    const { events, errors } = parseJsonl(eventsToJsonl(tree))
    expect(errors).toEqual([])
    expect(events).toEqual(tree)
    expect(reduceAll(events)).toEqual(reduceAll(tree))
  })

  it('a line whose payload smuggles an attributes map reads back without it', () => {
    const event = createEventFactory().traceSpan()
    const smuggled = JSON.stringify({
      ...event,
      payload: { ...event.payload, attributes: { 'user.email': 'someone@example.com' } },
    })
    const read = lineToEvent(smuggled)
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.error)
    expect(read.event).toEqual(event)
    expect(JSON.stringify(reduceAll([read.event]))).not.toContain('example.com')
  })
})
