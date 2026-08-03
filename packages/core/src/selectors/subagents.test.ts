import { describe, expect, it } from 'vitest'
import { createEventFactory } from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import {
  DEFAULT_SUBAGENT_RECENCY_MS,
  selectSubagentActivity,
  selectSubagentActivityForLane,
} from './subagents.js'

/**
 * prd10 ruling 9's data layer: does a lane have a live subagent bud, and,
 * where the lane is trace-instrumented, whose. Two independent signals —
 * liveness from thread-marked `llm.usage`/`tool.activity`, enrichment from
 * `trace.span` — so the four cases the DoD names each get their own case
 * below.
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

describe('selectSubagentActivity — recency windows', () => {
  it('is empty for a state with no thread-marked telemetry at all', () => {
    const f = createEventFactory()
    const state = reduceAll([f.llmUsage({ lane: 'a' })])
    expect(selectSubagentActivity(state, { now: NOW })).toEqual([])
  })

  it('counts a lane whose subagent-thread reading landed inside the window', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.llmUsage({ lane: 'a', thread: 'subagent' }, { ts: NOW - 60_000 }),
    ])
    const entries = selectSubagentActivity(state, { now: NOW })
    expect(entries).toEqual([{ lane: 'a', lastActivityTs: NOW - 60_000, agentId: null, subagentType: null }])
  })

  it('drops a lane whose newest subagent-thread reading fell outside the window', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.toolActivity({ lane: 'a', thread: 'subagent' }, { ts: NOW - DEFAULT_SUBAGENT_RECENCY_MS - 1 }),
    ])
    expect(selectSubagentActivity(state, { now: NOW })).toEqual([])
  })

  it('respects a caller-supplied window instead of the default', () => {
    const f = createEventFactory()
    const state = reduceAll([f.llmUsage({ lane: 'a', thread: 'subagent' }, { ts: NOW - 20_000 })])
    expect(selectSubagentActivity(state, { now: NOW, recencyMs: 10_000 })).toEqual([])
    expect(selectSubagentActivity(state, { now: NOW, recencyMs: 30_000 })).toHaveLength(1)
  })

  it('ignores a main-thread or unmarked reading — only thread: subagent counts', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.llmUsage({ lane: 'a', thread: 'main' }, { ts: NOW - 1_000 }),
      f.toolActivity({ lane: 'b' }, { ts: NOW - 1_000 }), // thread absent → null
    ])
    expect(selectSubagentActivity(state, { now: NOW })).toEqual([])
  })

  it('takes the newest of several readings for the same lane', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.llmUsage({ lane: 'a', thread: 'subagent' }, { ts: NOW - 90_000 }),
      f.toolActivity({ lane: 'a', thread: 'subagent' }, { ts: NOW - 10_000 }),
    ])
    expect(selectSubagentActivity(state, { now: NOW })[0]?.lastActivityTs).toBe(NOW - 10_000)
  })

  it('excludes a reading from the future relative to `now` — replay must not peek ahead', () => {
    const f = createEventFactory()
    const state = reduceAll([f.llmUsage({ lane: 'a', thread: 'subagent' }, { ts: NOW + 5_000 })])
    expect(selectSubagentActivity(state, { now: NOW })).toEqual([])
  })
})

describe('selectSubagentActivity — trace enrichment', () => {
  it('attaches agentId/subagentType from a matching recent span', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.llmUsage({ lane: 'a', thread: 'subagent' }, { ts: NOW - 10_000 }),
      f.traceSpan(
        {
          lane: 'a',
          kind: 'tool',
          name: 'claude_code.tool',
          toolName: 'Task',
          agentId: 'agent-42',
          subagentType: 'Explore',
        },
        { ts: NOW - 8_000 },
      ),
    ])
    expect(selectSubagentActivity(state, { now: NOW })).toEqual([
      { lane: 'a', lastActivityTs: NOW - 10_000, agentId: 'agent-42', subagentType: 'Explore' },
    ])
  })

  it('leaves enrichment null when the lane is live but has no matching span', () => {
    const f = createEventFactory()
    const state = reduceAll([f.llmUsage({ lane: 'a', thread: 'subagent' }, { ts: NOW - 10_000 })])
    expect(selectSubagentActivityForLane(state, 'a', { now: NOW })).toEqual({
      lane: 'a',
      lastActivityTs: NOW - 10_000,
      agentId: null,
      subagentType: null,
    })
  })

  it('ignores a span outside the recency window even when it names an agent', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.llmUsage({ lane: 'a', thread: 'subagent' }, { ts: NOW - 10_000 }),
      f.traceSpan(
        { lane: 'a', kind: 'tool', name: 'claude_code.tool', agentId: 'agent-stale' },
        { ts: NOW - DEFAULT_SUBAGENT_RECENCY_MS - 1 },
      ),
    ])
    expect(selectSubagentActivityForLane(state, 'a', { now: NOW })?.agentId).toBeNull()
  })

  it('never lets a span alone establish liveness — a lane with no thread-marked telemetry stays absent', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.traceSpan(
        { lane: 'a', kind: 'tool', name: 'claude_code.tool', agentId: 'agent-42', subagentType: 'Explore' },
        { ts: NOW - 5_000 },
      ),
    ])
    expect(selectSubagentActivity(state, { now: NOW })).toEqual([])
  })

  it('takes the newest matching span when more than one names an agent', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.llmUsage({ lane: 'a', thread: 'subagent' }, { ts: NOW - 10_000 }),
      f.traceSpan(
        { lane: 'a', spanId: 'span-1', kind: 'tool', name: 'claude_code.tool', agentId: 'agent-old' },
        { ts: NOW - 9_000 },
      ),
      f.traceSpan(
        { lane: 'a', spanId: 'span-2', kind: 'tool', name: 'claude_code.tool', agentId: 'agent-new' },
        { ts: NOW - 3_000 },
      ),
    ])
    expect(selectSubagentActivityForLane(state, 'a', { now: NOW })?.agentId).toBe('agent-new')
  })
})

describe('selectSubagentActivity — the conductor lane', () => {
  it('counts the conductor exactly like any worker lane — its telemetry lane, its own row', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.llmUsage(
        { lane: 'conductor', role: 'conductor', thread: 'subagent', worktreePath: null, branch: null },
        { ts: NOW - 5_000 },
      ),
    ])
    expect(selectSubagentActivityForLane(state, 'conductor', { now: NOW })).toEqual({
      lane: 'conductor',
      lastActivityTs: NOW - 5_000,
      agentId: null,
      subagentType: null,
    })
  })
})

describe('selectSubagentActivity — no-telemetry honesty', () => {
  it('reports nothing for a lane that never sent a thread-marked reading — never a zeroed row', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.llmUsage({ lane: 'a', thread: 'main' }, { ts: NOW - 1_000 }),
      f.toolActivity({ lane: 'a' }, { ts: NOW - 1_000 }),
    ])
    expect(selectSubagentActivity(state, { now: NOW })).toEqual([])
    expect(selectSubagentActivityForLane(state, 'a', { now: NOW })).toBeNull()
  })

  it('keeps two lanes apart, one live and one not', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.llmUsage({ lane: 'a', thread: 'subagent' }, { ts: NOW - 1_000 }),
      f.llmUsage({ lane: 'b', thread: 'main' }, { ts: NOW - 1_000 }),
    ])
    const entries = selectSubagentActivity(state, { now: NOW })
    expect(entries.map((entry) => entry.lane)).toEqual(['a'])
    expect(selectSubagentActivityForLane(state, 'b', { now: NOW })).toBeNull()
  })

  it('orders newest lane first, name as the tiebreak', () => {
    const f = createEventFactory()
    const state = reduceAll([
      f.llmUsage({ lane: 'b', thread: 'subagent' }, { ts: NOW - 5_000 }),
      f.llmUsage({ lane: 'a', thread: 'subagent' }, { ts: NOW - 5_000 }),
      f.llmUsage({ lane: 'c', thread: 'subagent' }, { ts: NOW - 1_000 }),
    ])
    expect(selectSubagentActivity(state, { now: NOW }).map((entry) => entry.lane)).toEqual(['c', 'a', 'b'])
  })
})
