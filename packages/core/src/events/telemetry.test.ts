import { describe, expect, it } from 'vitest'
import {
  AGENT_ROLES,
  AGENT_THREADS,
  UNATTRIBUTED_LANE,
  ZERO_TOKENS,
  addTokens,
  agentThreadSchema,
  createEvent,
  llmCostEventSchema,
  llmUsageEventSchema,
  parseEvent,
  sourceOf,
  telemetryRefusedEventSchema,
  toolActivityEventSchema,
  totalTokens,
} from './index.js'

const TOKENS = { input: 2, output: 1700, cacheRead: 99_700, cacheCreation: 1900 }

const usage = {
  lane: '33-core',
  role: 'worker' as const,
  model: 'claude-opus-5',
  tokens: TOKENS,
}

describe('llm.usage', () => {
  it('records tokens by tier, model and request timing', () => {
    const event = createEvent(
      'llm.usage',
      { ...usage, requestId: 'req_1', durationMs: 9400, sessionId: 'sess-1' },
      { id: 'evt-1', ts: 1000 },
    )
    expect(event.source).toBe('sessionlog')
    expect(event.payload.tokens).toEqual(TOKENS)
    expect(event.payload.durationMs).toBe(9400)
  })

  it('defaults to sessionlog — the depth collector owns usage', () => {
    expect(sourceOf('llm.usage')).toBe('sessionlog')
  })

  it('accepts the otel collector as the same fact from the other side', () => {
    const event = createEvent('llm.usage', usage, { id: 'evt-1', ts: 1, source: 'otel' })
    expect(event.source).toBe('otel')
  })

  it('rejects a source that is neither telemetry collector', () => {
    const result = parseEvent({
      id: 'evt-1',
      ts: 1,
      source: 'git',
      type: 'llm.usage',
      payload: usage,
    })
    expect(result.ok).toBe(false)
  })

  it('requires all four token tiers — a missing tier is not a zero', () => {
    for (const tier of ['input', 'output', 'cacheRead', 'cacheCreation'] as const) {
      const tokens: Record<string, number> = { ...TOKENS }
      delete tokens[tier]
      expect(
        llmUsageEventSchema.safeParse({
          id: 'evt-1',
          ts: 1,
          source: 'sessionlog',
          type: 'llm.usage',
          payload: { ...usage, tokens },
        }).success,
        `missing ${tier} should fail`,
      ).toBe(false)
    }
  })

  it('rejects negative and fractional token counts', () => {
    for (const bad of [-1, 1.5]) {
      expect(
        llmUsageEventSchema.safeParse({
          id: 'evt-1',
          ts: 1,
          source: 'sessionlog',
          type: 'llm.usage',
          payload: { ...usage, tokens: { ...TOKENS, output: bad } },
        }).success,
        `${bad} tokens should fail`,
      ).toBe(false)
    }
  })

  it('rejects an empty lane, and takes the unattributed sentinel instead', () => {
    expect(() =>
      createEvent('llm.usage', { ...usage, lane: '' }, { id: 'evt-1', ts: 1 }),
    ).toThrow()
    const event = createEvent(
      'llm.usage',
      { ...usage, lane: UNATTRIBUTED_LANE },
      { id: 'evt-1', ts: 1, source: 'otel' },
    )
    expect(event.payload.lane).toBe(UNATTRIBUTED_LANE)
  })

  it('requires a role — the conductor is never inferred from a lane name', () => {
    expect(() =>
      createEvent(
        'llm.usage',
        // @ts-expect-error — role is the whole point of the dimension
        { lane: 'l', model: 'm', tokens: TOKENS },
        { id: 'evt-1', ts: 1 },
      ),
    ).toThrow()
    expect(() =>
      // @ts-expect-error — 'orchestrator' is not one of the three roles
      createEvent('llm.usage', { ...usage, role: 'orchestrator' }, { id: 'evt-1', ts: 1 }),
    ).toThrow()
  })

  it('accepts every declared role, including prd2 unattributed', () => {
    expect(AGENT_ROLES).toContain('unattributed')
    for (const role of AGENT_ROLES) {
      const event = createEvent('llm.usage', { ...usage, role }, { id: 'evt-1', ts: 1 })
      expect(event.payload.role).toBe(role)
    }
  })
})

describe('llm.cost', () => {
  const cost = { lane: '33-core', role: 'worker' as const, model: 'claude-sonnet-5' }

  it('defaults to otel — the authority on dollars', () => {
    expect(sourceOf('llm.cost')).toBe('otel')
    const event = createEvent(
      'llm.cost',
      { ...cost, costUsd: 0.0588372, authoritative: true },
      { id: 'evt-1', ts: 1 },
    )
    expect(event.source).toBe('otel')
    expect(event.payload.costUsd).toBeCloseTo(0.0588372, 7)
  })

  it('demands an explicit authoritative flag — nothing is trusted by default', () => {
    expect(
      llmCostEventSchema.safeParse({
        id: 'evt-1',
        ts: 1,
        source: 'otel',
        type: 'llm.cost',
        payload: { ...cost, costUsd: 1 },
      }).success,
    ).toBe(false)
  })

  it('carries an estimate source when the dollars are ours, not the CLI own', () => {
    const event = createEvent(
      'llm.cost',
      { ...cost, costUsd: 0.42, authoritative: false, estimateSource: 'pricing-table@litellm' },
      { id: 'evt-1', ts: 1, source: 'sessionlog' },
    )
    expect(event.source).toBe('sessionlog')
    expect(event.payload.authoritative).toBe(false)
    expect(event.payload.estimateSource).toBe('pricing-table@litellm')
  })

  it('rejects a negative dollar amount', () => {
    expect(() =>
      createEvent(
        'llm.cost',
        { ...cost, costUsd: -0.01, authoritative: true },
        { id: 'evt-1', ts: 1 },
      ),
    ).toThrow()
  })

  it('allows a genuine zero — a cached call really can cost nothing', () => {
    const event = createEvent(
      'llm.cost',
      { ...cost, costUsd: 0, authoritative: true },
      { id: 'evt-1', ts: 1 },
    )
    expect(event.payload.costUsd).toBe(0)
  })
})

describe('tool.activity', () => {
  it('needs only a tool and a lane; the envelope supplies the ts', () => {
    const event = createEvent('tool.activity', { lane: '33-core', tool: 'Bash' }, {
      id: 'evt-1',
      ts: 7_000,
    })
    expect(event.source).toBe('sessionlog')
    expect(event.ts).toBe(7_000)
    expect(event.payload.role).toBeUndefined()
  })

  it('records a role when the collector knows one', () => {
    const event = createEvent('tool.activity', {
      lane: 'conductor',
      tool: 'Edit',
      role: 'conductor',
      durationMs: 120,
    }, { id: 'evt-1', ts: 1 })
    expect(event.payload.role).toBe('conductor')
  })

  it('rejects an empty tool name', () => {
    expect(
      toolActivityEventSchema.safeParse({
        id: 'evt-1',
        ts: 1,
        source: 'sessionlog',
        type: 'tool.activity',
        payload: { lane: 'l', tool: '' },
      }).success,
    ).toBe(false)
  })
})

describe('telemetry.refused', () => {
  it('records the foreign instance, ours, and how many posts it stands for', () => {
    expect(sourceOf('telemetry.refused')).toBe('otel')
    const event = createEvent(
      'telemetry.refused',
      { instance: 'other-repo-42', expectedInstance: '1000', count: 7 },
      { id: 'evt-1', ts: 1 },
    )
    expect(event.source).toBe('otel')
    expect(event.payload).toEqual({
      instance: 'other-repo-42',
      expectedInstance: '1000',
      count: 7,
    })
  })

  it('distinguishes "declared nothing" from "declared someone else" with a null instance', () => {
    const event = createEvent(
      'telemetry.refused',
      { instance: null, expectedInstance: '1000', count: 1 },
      { id: 'evt-1', ts: 1 },
    )
    expect(event.payload.instance).toBeNull()
  })

  it('is part of the one event union every consumer reads', () => {
    const parsed = parseEvent({
      id: 'evt-1',
      ts: 1,
      source: 'otel',
      type: 'telemetry.refused',
      payload: { instance: null, expectedInstance: '1000', count: 1 },
    })
    expect(parsed.ok).toBe(true)
  })

  it('refuses a count that stands for no posts, and an empty expected instance', () => {
    expect(
      telemetryRefusedEventSchema.safeParse({
        id: 'evt-1',
        ts: 1,
        source: 'otel',
        type: 'telemetry.refused',
        payload: { instance: 'x', expectedInstance: '1000', count: 0 },
      }).success,
    ).toBe(false)
    expect(
      telemetryRefusedEventSchema.safeParse({
        id: 'evt-1',
        ts: 1,
        source: 'otel',
        type: 'telemetry.refused',
        payload: { instance: 'x', expectedInstance: '', count: 1 },
      }).success,
    ).toBe(false)
  })
})

describe('the thread dimension', () => {
  const cost = { lane: '33-core', role: 'worker' as const, model: 'claude-sonnet-5', costUsd: 1, authoritative: true }

  it('names the three threads both collectors already receive', () => {
    expect(AGENT_THREADS).toEqual(['main', 'subagent', 'auxiliary'])
    for (const thread of AGENT_THREADS) {
      expect(agentThreadSchema.safeParse(thread).success, thread).toBe(true)
    }
  })

  it('rides on all three telemetry payloads', () => {
    expect(
      createEvent('llm.usage', { ...usage, thread: 'subagent' }, { id: 'evt-1', ts: 1 }).payload
        .thread,
    ).toBe('subagent')
    expect(createEvent('llm.cost', { ...cost, thread: 'main' }, { id: 'evt-2', ts: 1 }).payload.thread).toBe(
      'main',
    )
    expect(
      createEvent('tool.activity', { lane: 'l', tool: 'Bash', thread: 'auxiliary' }, { id: 'evt-3', ts: 1 })
        .payload.thread,
    ).toBe('auxiliary')
  })

  it('is optional, and explicitly nullable for a source that does not say', () => {
    expect(createEvent('llm.usage', usage, { id: 'evt-1', ts: 1 }).payload.thread).toBeUndefined()
    expect(
      createEvent('llm.usage', { ...usage, thread: null }, { id: 'evt-1', ts: 1 }).payload.thread,
    ).toBeNull()
  })

  it('rejects a thread nobody declared — "worker" is a role, not a thread', () => {
    expect(() =>
      // @ts-expect-error — the role vocabulary is not the thread vocabulary
      createEvent('llm.usage', { ...usage, thread: 'worker' }, { id: 'evt-1', ts: 1 }),
    ).toThrow()
  })
})

describe('token arithmetic', () => {
  it('totals all four tiers', () => {
    expect(totalTokens(TOKENS)).toBe(2 + 1700 + 99_700 + 1900)
    expect(totalTokens(ZERO_TOKENS)).toBe(0)
  })

  it('adds tier by tier', () => {
    expect(addTokens(TOKENS, TOKENS)).toEqual({
      input: 4,
      output: 3400,
      cacheRead: 199_400,
      cacheCreation: 3800,
    })
    expect(addTokens(TOKENS, ZERO_TOKENS)).toEqual(TOKENS)
  })

  it('never mutates its inputs', () => {
    const a = { ...TOKENS }
    addTokens(a, a)
    expect(a).toEqual(TOKENS)
    expect(ZERO_TOKENS).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })
  })
})
