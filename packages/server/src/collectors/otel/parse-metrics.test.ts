import { readFileSync } from 'node:fs'
import {
  createEvent,
  createIdFactory,
  type EventOf,
  type EventType,
  type PayloadOf,
  type SourceOf,
} from '@observatory/core'
import { describe, expect, it } from 'vitest'
import { parseMetricsExport, type OtelEmitter } from './parse-metrics.js'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

/** A deterministic emitter for assertions — id/ts are stable, not the point of these tests. */
function testEmitter(): OtelEmitter {
  const nextId = createIdFactory('evt')
  return {
    emit: <T extends EventType>(type: T, payload: PayloadOf<T>, source?: SourceOf<T>): EventOf<T> =>
      createEvent(type, payload, { id: nextId(), ts: 1_000, source }),
  }
}

describe('parseMetricsExport', () => {
  it('turns claude_code.token.usage and claude_code.cost.usage datapoints into llm.usage / llm.cost events', () => {
    const result = parseMetricsExport(fixture('metrics-token-and-cost.json'), testEmitter())

    expect(result.malformed).toBe(false)

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    const costs = result.events.filter((e) => e.type === 'llm.cost')
    expect(usage).toHaveLength(4)
    expect(costs).toHaveLength(2)

    // main/worker input datapoint
    expect(usage[0]?.payload).toMatchObject({
      lane: '2-core',
      role: 'worker',
      model: 'claude-opus-5',
      tokens: { input: 4, output: 0, cacheRead: 0, cacheCreation: 0 },
      sessionId: 'sess-2-core',
    })
    // main/worker output datapoint
    expect(usage[1]?.payload).toMatchObject({
      lane: '2-core',
      role: 'worker',
      tokens: { input: 0, output: 222_678, cacheRead: 0, cacheCreation: 0 },
    })
    // auxiliary haiku call maps query_source: auxiliary to role: auxiliary
    expect(usage[2]?.payload).toMatchObject({
      lane: '2-core',
      role: 'auxiliary',
      model: 'claude-haiku-4-5-20251001',
      tokens: { input: 12, output: 0, cacheRead: 0, cacheCreation: 0 },
    })
    expect(usage[3]?.payload).toMatchObject({ role: 'auxiliary', tokens: { input: 0, output: 88, cacheRead: 0, cacheCreation: 0 } })

    expect(costs[0]?.payload).toMatchObject({
      lane: '2-core',
      role: 'worker',
      model: 'claude-opus-5',
      costUsd: 0.0588372,
      authoritative: true,
    })
    expect(costs[1]?.payload).toMatchObject({
      lane: '2-core',
      role: 'auxiliary',
      model: 'claude-haiku-4-5-20251001',
      costUsd: 0.000591,
      authoritative: true,
    })

    // every event source is otel, and every event is authoritative/attributed-null for cwd
    for (const event of result.events) {
      expect(event.source).toBe('otel')
    }
    expect(usage.every((e) => 'payload' in e && (e.payload as { worktreePath: unknown }).worktreePath === null)).toBe(
      true,
    )
  })

  it('accepts all four claude_code.token.usage tiers — input, output, cacheRead, cacheCreation — with zero collector.error', () => {
    const result = parseMetricsExport(fixture('metrics-all-tiers.json'), testEmitter())

    expect(result.malformed).toBe(false)

    const errors = result.events.filter((e) => e.type === 'collector.error')
    expect(errors).toHaveLength(0)

    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(usage).toHaveLength(4)

    const tokensByTier = usage.map((e) => (e.payload as { tokens: Record<string, number> }).tokens)
    expect(tokensByTier).toEqual(
      expect.arrayContaining([
        { input: 249, output: 0, cacheRead: 0, cacheCreation: 0 },
        { input: 0, output: 222_678, cacheRead: 0, cacheCreation: 0 },
        { input: 0, output: 0, cacheRead: 13_065_329, cacheCreation: 0 },
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 247_684 },
      ]),
    )
  })

  it('never copies user.email (or any other stray attribute) into the stored payload', () => {
    const result = parseMetricsExport(fixture('metrics-token-and-cost.json'), testEmitter())
    const serialised = JSON.stringify(result.events)
    expect(serialised).not.toContain('lachlan@example.com')
    expect(serialised).not.toContain('user.email')
  })

  it('infers role: conductor from lane === "conductor" with no explicit resource role attribute', () => {
    const result = parseMetricsExport(fixture('metrics-conductor.json'), testEmitter())
    expect(result.malformed).toBe(false)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.payload).toMatchObject({ lane: 'conductor', role: 'conductor', costUsd: 1.2345 })
  })

  it('ignores metrics it does not recognise, silently — no events, no error', () => {
    const result = parseMetricsExport(fixture('metrics-unknown-only.json'), testEmitter())
    expect(result.malformed).toBe(false)
    expect(result.events).toEqual([])
  })

  it('records one collector.error per malformed datapoint but still processes the rest of the request', () => {
    const result = parseMetricsExport(fixture('metrics-bad-datapoint.json'), testEmitter())
    expect(result.malformed).toBe(false)

    const errors = result.events.filter((e) => e.type === 'collector.error')
    const usage = result.events.filter((e) => e.type === 'llm.usage')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.payload).toMatchObject({ collector: 'otel' })
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({ lane: '7-web', model: 'claude-sonnet-5', tokens: { output: 20 } })
  })

  it('flags a body that is not a valid OTLP metrics export as malformed, with one collector.error, and never throws', () => {
    expect(() => parseMetricsExport(fixture('metrics-malformed.json'), testEmitter())).not.toThrow()
    const result = parseMetricsExport(fixture('metrics-malformed.json'), testEmitter())
    expect(result.malformed).toBe(true)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ type: 'collector.error', payload: { collector: 'otel' } })
  })

  it('never throws on wildly wrong input types', () => {
    for (const body of [null, undefined, 'a string', 42, [], {}]) {
      expect(() => parseMetricsExport(body, testEmitter())).not.toThrow()
      expect(parseMetricsExport(body, testEmitter()).malformed).toBe(true)
    }
  })

  it('falls back to a short-hash of session.id for the lane when no resource lane attribute is present', () => {
    const body = {
      resourceMetrics: [
        {
          resource: { attributes: [] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.cost.usage',
                  sum: {
                    dataPoints: [
                      {
                        attributes: [
                          { key: 'session.id', value: { stringValue: 'sess-no-lane' } },
                          { key: 'model', value: { stringValue: 'claude-opus-5' } },
                        ],
                        asDouble: 0.01,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const result = parseMetricsExport(body, testEmitter())
    expect(result.malformed).toBe(false)
    const lane = (result.events[0]?.payload as { lane: string }).lane
    expect(lane).not.toBe('sess-no-lane')
    expect(lane).toMatch(/^[0-9a-f]{8}$/)
  })

  it('falls back to the unattributed lane when neither a lane attribute nor a session id is present', () => {
    const body = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.cost.usage',
                  sum: {
                    dataPoints: [
                      { attributes: [{ key: 'model', value: { stringValue: 'claude-opus-5' } }], asDouble: 0.01 },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const result = parseMetricsExport(body, testEmitter())
    expect(result.events[0]?.payload).toMatchObject({ lane: 'unattributed' })
  })
})
