import { createEventFactory, reduceAll } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { exemplarForBranch, heaviestLlmRequestSpanByLane, type ExemplarSpan } from './exemplar.js'

describe('heaviestLlmRequestSpanByLane', () => {
  it('picks the span with the most total tokens, per lane', () => {
    const fx = createEventFactory()
    fx.sessionStarted()
    fx.traceSpan({
      lane: 'a', traceId: 't1', spanId: 's1',
      tokens: { input: 10, output: 90, cacheRead: 0, cacheCreation: 0 }, // 100
    })
    fx.traceSpan({
      lane: 'a', traceId: 't1', spanId: 's2', parentSpanId: 's1',
      tokens: { input: 10, output: 490, cacheRead: 0, cacheCreation: 0 }, // 500 — heaviest
    })
    fx.traceSpan({
      lane: 'b', traceId: 't2', spanId: 's3',
      tokens: { input: 5, output: 5, cacheRead: 0, cacheCreation: 0 }, // 10
    })

    const state = reduceAll(fx.all())
    const byLane = heaviestLlmRequestSpanByLane(state)

    expect(byLane.get('a')).toMatchObject({ traceId: 't1', spanId: 's2', tokens: 500 })
    expect(byLane.get('b')).toMatchObject({ traceId: 't2', spanId: 's3', tokens: 10 })
  })

  it('ignores non-llm_request spans and spans with no token reading at all', () => {
    const fx = createEventFactory()
    fx.sessionStarted()
    fx.traceSpan({
      lane: 'c', traceId: 't1', spanId: 'root', kind: 'interaction', tokens: null,
    })
    fx.traceSpan({
      lane: 'c', traceId: 't1', spanId: 'tool-1', parentSpanId: 'root', kind: 'tool', toolName: 'Bash',
      tokens: { input: 999, output: 999, cacheRead: 999, cacheCreation: 999 }, // would win if counted — must not be
    })

    const state = reduceAll(fx.all())
    expect(heaviestLlmRequestSpanByLane(state).has('c')).toBe(false)
  })

  it('is empty for a session with no trace spans at all', () => {
    const fx = createEventFactory()
    fx.sessionStarted()
    const state = reduceAll(fx.all())
    expect(heaviestLlmRequestSpanByLane(state).size).toBe(0)
  })
})

describe('exemplarForBranch', () => {
  const SPAN: ExemplarSpan = { traceId: 't1', spanId: 's1', tokens: 500, startTs: 0 }

  it('finds a span filed directly under the branch name', () => {
    const byLane = new Map([['42-feature', SPAN]])
    expect(exemplarForBranch(byLane, '42-feature', [])).toBe(SPAN)
  })

  it('falls back to each telemetry handle when the branch name itself has no spans', () => {
    const byLane = new Map([['lane-abc123', SPAN]])
    expect(exemplarForBranch(byLane, '42-feature', ['lane-xyz', 'lane-abc123'])).toBe(SPAN)
  })

  it('is null when neither the branch nor any of its handles has a span', () => {
    const byLane = new Map([['someone-else', SPAN]])
    expect(exemplarForBranch(byLane, '42-feature', ['lane-xyz'])).toBeNull()
  })
})
