import { describe, expect, it } from 'vitest'
import {
  AGENT_ROLES,
  AGENT_THREADS,
  UNATTRIBUTED_LANE,
  ZERO_TOKENS,
  addTokens,
  agentActiveTimeEventSchema,
  agentThreadSchema,
  createEvent,
  eventSourceSchema,
  llmCostEventSchema,
  llmUsageEventSchema,
  parseEvent,
  sourceOf,
  telemetryOriginSchema,
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

  // --- prd55 ruling 1 (#430): a cost the lab booked --------------------------

  describe('the lab may name itself as the source of a cost it booked (prd55 ruling 1)', () => {
    it('validates a lab-sourced cost, and a collector-sourced one still does', () => {
      const booked = createEvent(
        'llm.cost',
        { ...cost, costUsd: 0.0421, authoritative: true },
        { id: 'evt-1', ts: 1, source: 'lab' },
      )
      expect(booked.source).toBe('lab')
      expect(booked.payload.costUsd).toBeCloseTo(0.0421, 7)

      // …and neither collector lost the right to sign one.
      for (const source of ['otel', 'sessionlog'] as const) {
        const collected = createEvent(
          'llm.cost',
          { ...cost, costUsd: 1, authoritative: true },
          { id: 'evt-2', ts: 2, source },
        )
        expect(collected.source).toBe(source)
      }
    })

    it('leaves the source map alone — dollars are still otel by default', () => {
      expect(sourceOf('llm.cost')).toBe('otel')
      const defaulted = createEvent(
        'llm.cost',
        { ...cost, costUsd: 1, authoritative: true },
        { id: 'evt-1', ts: 1 },
      )
      expect(defaulted.source).toBe('otel')
    })

    it('still rejects a source that is neither a telemetry collector nor the lab', () => {
      for (const source of ['git', 'tmux', 'workmux', 'system', 'beacon', 'gate', 'operator', 'judge']) {
        const result = parseEvent({
          id: 'evt-1',
          ts: 1,
          source,
          type: 'llm.cost',
          payload: { ...cost, costUsd: 1, authoritative: true },
        })
        expect(result.ok, `llm.cost must refuse source "${source}"`).toBe(false)
      }
    })

    /**
     * The distinction `events/lab.ts` draws, restated as a law: the lab is an
     * explicitly-invoked second hand, not a seventh collector. It may BOOK a
     * cost, because the figure is one its own subprocess reported about itself.
     * It may not TAKE a reading — a token count comes off a transcript a
     * collector tailed and a tool call off the same, and the lab tails nothing.
     */
    it('does not let the lab sign a reading — usage and tool activity stay collectors-only', () => {
      expect(
        llmUsageEventSchema.safeParse({
          id: 'evt-1',
          ts: 1,
          source: 'lab',
          type: 'llm.usage',
          payload: usage,
        }).success,
      ).toBe(false)
      expect(
        toolActivityEventSchema.safeParse({
          id: 'evt-1',
          ts: 1,
          source: 'lab',
          type: 'tool.activity',
          payload: { lane: '33-core', tool: 'Bash' },
        }).success,
      ).toBe(false)
      expect(parseEvent({ id: 'evt-1', ts: 1, source: 'lab', type: 'llm.usage', payload: usage }).ok).toBe(false)
    })

    /**
     * The vocabulary keeps saying it (prd12 ruling 1, cited by prd55 ruling 1):
     * `eventSourceSchema` documents "which collector saw it", and `'lab'` is
     * deliberately absent from it. Widening `llm.cost` does not change that,
     * and this law is here so a later lane cannot quietly fold the lab in on
     * this precedent — `common.ts`'s own comment beside `'operator'` says that
     * reopening prd12 ruling 1 is a deliberate act, never a side effect.
     */
    it('keeps "lab" outside the collector enum — booking a cost is not becoming a collector', () => {
      expect(eventSourceSchema.safeParse('lab').success).toBe(false)
      expect(eventSourceSchema.options).not.toContain('lab')
      expect(telemetryOriginSchema.options).toContain('lab')
    })

    /**
     * A telemetry RECORD's `origin` is the union of everything any telemetry
     * event may say; each envelope above fixes which of them it may say.
     * Pinned exactly, so neither half can drift into the other unnoticed.
     */
    it('names the two collectors and the one second hand, in that order', () => {
      expect(telemetryOriginSchema.options).toEqual(['sessionlog', 'otel', 'lab'])
    })
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

  it('carries the sessionlog-derived filePath and toolUseId (prd11 ruling 2)', () => {
    const event = createEvent(
      'tool.activity',
      { lane: '33-core', tool: 'Edit', filePath: 'packages/core/src/index.ts', toolUseId: 'toolu_01abc' },
      { id: 'evt-1', ts: 1 },
    )
    expect(event.payload.filePath).toBe('packages/core/src/index.ts')
    expect(event.payload.toolUseId).toBe('toolu_01abc')
  })

  it('leaves filePath and toolUseId undefined when not passed — additive, never defaulted to null', () => {
    const event = createEvent('tool.activity', { lane: '33-core', tool: 'Bash' }, { id: 'evt-1', ts: 1 })
    expect(event.payload.filePath).toBeUndefined()
    expect(event.payload.toolUseId).toBeUndefined()
  })

  it('accepts an explicit null filePath — Bash and other non-file tools, never a guess', () => {
    const event = createEvent(
      'tool.activity',
      { lane: '33-core', tool: 'Bash', filePath: null, toolUseId: 'toolu_01abc' },
      { id: 'evt-1', ts: 1 },
    )
    expect(event.payload.filePath).toBeNull()
  })

  it('parses a pre-prd11 event with neither field — the additive law', () => {
    // Exactly the shape every `tool.activity` ever logged before prd11 has:
    // no `filePath`, no `toolUseId` key at all.
    const result = toolActivityEventSchema.safeParse({
      id: 'evt-1',
      ts: 1,
      source: 'sessionlog',
      type: 'tool.activity',
      payload: { lane: 'l', tool: 'Bash' },
    })
    expect(result.success).toBe(true)
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

describe('agent.activeTime', () => {
  const activeTime = { lane: '33-core', role: 'worker' as const, activeSeconds: 542 }

  it('is otel-only, like telemetry.refused — no other collector produces it', () => {
    expect(sourceOf('agent.activeTime')).toBe('otel')
    const event = createEvent('agent.activeTime', activeTime, { id: 'evt-1', ts: 1 })
    expect(event.source).toBe('otel')
    expect(event.payload.activeSeconds).toBe(542)
  })

  it('rejects a source other than otel', () => {
    expect(
      agentActiveTimeEventSchema.safeParse({
        id: 'evt-1',
        ts: 1,
        source: 'sessionlog',
        type: 'agent.activeTime',
        payload: activeTime,
      }).success,
    ).toBe(false)
  })

  it('rejects a negative reading — a counter never goes below zero', () => {
    expect(() =>
      createEvent('agent.activeTime', { ...activeTime, activeSeconds: -1 }, { id: 'evt-1', ts: 1 }),
    ).toThrow()
  })

  it('allows a genuine zero — a session that just started has been active for none of it', () => {
    const event = createEvent(
      'agent.activeTime',
      { ...activeTime, activeSeconds: 0 },
      { id: 'evt-1', ts: 1 },
    )
    expect(event.payload.activeSeconds).toBe(0)
  })

  it('requires a role, same as every other telemetry payload', () => {
    expect(() =>
      createEvent(
        'agent.activeTime',
        // @ts-expect-error — role is required
        { lane: 'l', activeSeconds: 1 },
        { id: 'evt-1', ts: 1 },
      ),
    ).toThrow()
  })

  it('takes a nullable sessionId, like its siblings', () => {
    const event = createEvent(
      'agent.activeTime',
      { ...activeTime, sessionId: null },
      { id: 'evt-1', ts: 1 },
    )
    expect(event.payload.sessionId).toBeNull()
  })

  it('is part of the one event union every consumer reads', () => {
    const parsed = parseEvent({
      id: 'evt-1',
      ts: 1,
      source: 'otel',
      type: 'agent.activeTime',
      payload: activeTime,
    })
    expect(parsed.ok).toBe(true)
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
    expect(
      createEvent(
        'agent.activeTime',
        { lane: 'l', role: 'worker', activeSeconds: 1, thread: 'main' },
        { id: 'evt-4', ts: 1 },
      ).payload.thread,
    ).toBe('main')
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

describe('the harness dimension (#538)', () => {
  it('is undefined by default — sessionlog with no harness still means Claude Code', () => {
    const event = createEvent('llm.usage', usage, { id: 'evt-1', ts: 1 })
    expect(event.source).toBe('sessionlog')
    expect(event.payload.harness).toBeUndefined()
  })

  it('lets a non-claude dialect name itself on a sessionlog-sourced event', () => {
    const event = createEvent(
      'llm.usage',
      { ...usage, harness: 'pi' },
      { id: 'evt-1', ts: 1, source: 'sessionlog' },
    )
    expect(event.source).toBe('sessionlog')
    expect(event.payload.harness).toBe('pi')
  })

  it('rides on all three sessionlog-eligible telemetry payloads', () => {
    expect(
      createEvent('llm.usage', { ...usage, harness: 'pi' }, { id: 'evt-1', ts: 1 }).payload.harness,
    ).toBe('pi')
    expect(
      createEvent(
        'llm.cost',
        { lane: '33-core', role: 'worker' as const, model: 'pi-model', costUsd: 1, authoritative: true, harness: 'pi' },
        { id: 'evt-2', ts: 1, source: 'sessionlog' },
      ).payload.harness,
    ).toBe('pi')
    expect(
      createEvent(
        'tool.activity',
        { lane: 'l', tool: 'bash', harness: 'pi' },
        { id: 'evt-3', ts: 1 },
      ).payload.harness,
    ).toBe('pi')
  })

  it('is not a closed vocabulary — any non-empty string names a dialect, no core PR per harness', () => {
    // A canary generated at run time, not a literal any hand-written enum
    // could happen to enumerate — a mutation that closes the vocabulary to a
    // fixed list (even one seeded with the other names in this loop) must
    // still fail this specific assertion.
    const canary = `mutation-canary-${Math.random().toString(36).slice(2)}`
    for (const harness of ['pi', 'codex', 'aider', 'some-future-cli', canary]) {
      const event = createEvent('llm.usage', { ...usage, harness }, { id: 'evt-1', ts: 1 })
      expect(event.payload.harness).toBe(harness)
    }
  })

  it('rejects an empty-string harness — nonEmptyString, same discipline as lane', () => {
    expect(
      llmUsageEventSchema.safeParse({
        id: 'evt-1',
        ts: 1,
        source: 'sessionlog',
        type: 'llm.usage',
        payload: { ...usage, harness: '' },
      }).success,
    ).toBe(false)
  })

  it('normalises a padded harness name — `.trim()` rewrites the value, not just its length check', () => {
    // `.trim()` is a zod transform, so the parsed value differs from the input.
    // `harness` is the only field in the core event schemas that does this —
    // nothing else under `events/` uses `.trim()` or `.transform()` — and
    // `eventToLine` re-serialises parsed events, so this is also the one place
    // where parse → serialise is not byte-identity. Pinned because the
    // non-transforming equivalent `.min(1).refine((s) => s.trim().length > 0)`
    // validates identically and survives every other test in this block.
    const event = createEvent('llm.usage', { ...usage, harness: '  pi  ' }, { id: 'evt-1', ts: 1 })
    expect(event.payload.harness).toBe('pi')
  })

  it('rejects a whitespace-only harness — as absent a name as the empty string', () => {
    expect(
      llmUsageEventSchema.safeParse({
        id: 'evt-1',
        ts: 1,
        source: 'sessionlog',
        type: 'llm.usage',
        payload: { ...usage, harness: '   ' },
      }).success,
    ).toBe(false)
  })

  it('accepts an explicit null harness — declared Claude explicitly, not just omitted', () => {
    const event = createEvent('llm.usage', { ...usage, harness: null }, { id: 'evt-1', ts: 1 })
    expect(event.payload.harness).toBeNull()
  })

  it('parses a pre-#538 event with no harness key at all — the additive law', () => {
    // Exactly the shape every sessionlog llm.usage ever logged before #538 has:
    // no `harness` key present, not even `null`.
    const result = llmUsageEventSchema.safeParse({
      id: 'evt-1',
      ts: 1,
      source: 'sessionlog',
      type: 'llm.usage',
      payload: usage,
    })
    expect(result.success).toBe(true)
  })

  it('is accepted, though meaningless, on an otel-sourced record too', () => {
    // otel has only ever had one dialect, so a harness here names nothing —
    // but the schema does not know that and must not reject it either.
    const event = createEvent(
      'llm.cost',
      {
        lane: '33-core',
        role: 'worker' as const,
        model: 'claude-sonnet-5',
        costUsd: 1,
        authoritative: true,
        harness: 'pi',
      },
      { id: 'evt-1', ts: 1, source: 'otel' },
    )
    expect(event.source).toBe('otel')
    expect(event.payload.harness).toBe('pi')
  })

  it('rides on agent.activeTime too, though the field means nothing there', () => {
    // activeTimePayloadSchema spreads the same shared `attribution` object,
    // so harness is accepted here as well rather than stripped or rejected —
    // pinned so that claim in telemetry.ts's doc comment can't go stale silently.
    const event = createEvent(
      'agent.activeTime',
      { lane: 'l', role: 'worker' as const, activeSeconds: 1, harness: 'pi' },
      { id: 'evt-1', ts: 1 },
    )
    expect(event.source).toBe('otel')
    expect(event.payload.harness).toBe('pi')
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
