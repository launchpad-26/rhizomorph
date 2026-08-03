import { readFileSync } from 'node:fs'
import {
  createEvent,
  createIdFactory,
  type EventOf,
  type EventType,
  type PayloadOf,
  type SourceOf,
} from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { parseTracesExport } from './parse-traces.js'
import type { OtelEmitter } from './parse-metrics.js'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

function fixtureRaw(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

/** A deterministic emitter for assertions — id/ts are stable, not the point of these tests. */
function testEmitter(): OtelEmitter {
  const nextId = createIdFactory('evt')
  return {
    emit: <T extends EventType>(type: T, payload: PayloadOf<T>, source?: SourceOf<T>): EventOf<T> =>
      createEvent(type, payload, { id: nextId(), ts: 1_000, source }),
  }
}

describe('parseTracesExport', () => {
  it('turns an llm_request span into a trace.span event with exact nanos→ms conversion and the token/ttft/requestId allowlist', () => {
    const result = parseTracesExport(fixture('claude-code-2.1.220-traces-llm-request.json'), testEmitter())

    expect(result.malformed).toBe(false)
    expect(result.events).toHaveLength(1)
    const event = result.events[0]
    expect(event?.type).toBe('trace.span')
    expect(event?.source).toBe('otel')
    expect(event?.payload).toMatchObject({
      lane: 'probe-lane',
      role: 'worker',
      sessionId: '5acc6a84-f2f6-4931-a725-b4be08cfc39d',
      traceId: '2e3bb129ac011ead11ccbefc0c8ed50a',
      spanId: 'f0c801a984d353ef',
      parentSpanId: '41841eca4c564bb3',
      name: 'claude_code.llm_request',
      kind: 'llm_request',
      // startTimeUnixNano "1785736968993000000" / 1e6, endTimeUnixNano "1785736970256804102" / 1e6 (floor)
      startTs: 1785736968993,
      endTs: 1785736970256,
      status: 'unset',
      model: 'claude-haiku-4-5-20251001',
      tokens: { input: 556, output: 15, cacheRead: 0, cacheCreation: 0 },
      ttftMs: 1049,
      requestId: 'req_011CdfJprCK1rqJysEMssvTK',
    })
  })

  it('parses a tool/tool.execution pair with toolName/toolUseId and null tokens (tool-pair-a)', () => {
    const result = parseTracesExport(fixture('claude-code-2.1.220-traces-tool-pair-a.json'), testEmitter())
    expect(result.malformed).toBe(false)
    expect(result.events).toHaveLength(2)

    const byKind = Object.fromEntries(result.events.map((e) => [(e.payload as { kind: string }).kind, e.payload]))
    expect(byKind.tool_execution).toMatchObject({
      spanId: '81f46470c8d3beca',
      parentSpanId: '6c5f2eab56dcfcc9',
      toolUseId: 'toolu_018EqeBwhoEdX4WvvQWTj2kj',
      tokens: null,
      model: null,
    })
    expect(byKind.tool).toMatchObject({
      spanId: '6c5f2eab56dcfcc9',
      parentSpanId: '41841eca4c564bb3',
      toolName: 'Bash',
      toolUseId: 'toolu_018EqeBwhoEdX4WvvQWTj2kj',
      tokens: null,
    })
  })

  it('parses the second tool/tool.execution pair (tool-pair-b)', () => {
    const result = parseTracesExport(fixture('claude-code-2.1.220-traces-tool-pair-b.json'), testEmitter())
    expect(result.malformed).toBe(false)
    expect(result.events).toHaveLength(2)
    const kinds = result.events.map((e) => (e.payload as { kind: string }).kind).sort()
    expect(kinds).toEqual(['tool', 'tool_execution'])
    for (const event of result.events) {
      expect((event.payload as { tokens: unknown }).tokens).toBeNull()
    }
  })

  it('parses the interaction root alongside its child llm_request, with the root as a parentless span (interaction-root)', () => {
    const result = parseTracesExport(fixture('claude-code-2.1.220-traces-interaction-root.json'), testEmitter())
    expect(result.malformed).toBe(false)
    expect(result.events).toHaveLength(2)

    const byKind = Object.fromEntries(result.events.map((e) => [(e.payload as { kind: string }).kind, e.payload]))
    expect(byKind.interaction).toMatchObject({
      spanId: '41841eca4c564bb3',
      parentSpanId: null,
      name: 'claude_code.interaction',
      tokens: null,
      model: null,
    })
    expect(byKind.llm_request).toMatchObject({
      model: 'claude-opus-5[1m]',
      tokens: { input: 2, output: 12, cacheRead: 24061, cacheCreation: 97 },
      ttftMs: 1367,
      requestId: 'req_011CdfJr8pTyp1wpipkYGe9K',
    })
  })

  it('parses the subagent shape: llm_request nests inside the Agent tool call, carrying agentId and llm_request.context=tool', () => {
    const result = parseTracesExport(fixture('claude-code-2.1.220-traces-subagent.json'), testEmitter())
    expect(result.malformed).toBe(false)
    expect(result.events).toHaveLength(3)

    const byKind = Object.fromEntries(result.events.map((e) => [(e.payload as { kind: string }).kind, e.payload]))
    expect(byKind.llm_request).toMatchObject({
      agentId: 'a454db998135fb4d6',
      tokens: { input: 2, output: 3, cacheRead: 0, cacheCreation: 11949 },
    })
    expect(byKind.tool).toMatchObject({ toolName: 'Agent' })
    expect(byKind.tool_execution).toMatchObject({ tokens: null })

    // tokens present only on the llm_request span across this whole fixture
    for (const [kind, payload] of Object.entries(byKind)) {
      if (kind !== 'llm_request') expect((payload as { tokens: unknown }).tokens).toBeNull()
    }
  })

  it('never lets <REDACTED> prompt text or user.email cross into any emitted event, across all five fixtures', () => {
    const names = [
      'claude-code-2.1.220-traces-llm-request.json',
      'claude-code-2.1.220-traces-tool-pair-a.json',
      'claude-code-2.1.220-traces-tool-pair-b.json',
      'claude-code-2.1.220-traces-interaction-root.json',
      'claude-code-2.1.220-traces-subagent.json',
    ]
    for (const name of names) {
      // Sanity: the raw capture body genuinely carries what we're asserting gets stripped.
      const raw = fixtureRaw(name)
      expect(raw).toContain('user.email')

      const result = parseTracesExport(fixture(name), testEmitter())
      const serialised = JSON.stringify(result.events)
      expect(serialised).not.toContain('<REDACTED>')
      expect(serialised).not.toContain('user.email')
      expect(serialised).not.toContain('lachlan@example.com')
      expect(serialised).not.toContain('organization.id')
      expect(serialised).not.toContain('2cb9f538-6af2-46f5-91e1-a756cb22cb28') // organization.id value
      expect(serialised).not.toContain('user.account')
    }
  })

  it('maps an unrecognised span name to kind "other", never an error — beta churn is data, not schema', () => {
    const body = fixture('claude-code-2.1.220-traces-llm-request.json') as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>
    }
    const mutated = structuredClone(body)
    const span = mutated.resourceSpans[0]?.scopeSpans[0]?.spans[0]
    if (!span) throw new Error('fixture shape changed')
    span.name = 'claude_code.some_future_span'

    const result = parseTracesExport(mutated, testEmitter())
    expect(result.malformed).toBe(false)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.payload).toMatchObject({ name: 'claude_code.some_future_span', kind: 'other' })
  })

  it('maps claude_code.tool.blocked_on_user to tool_blocked and reads its decision', () => {
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'lane', value: { stringValue: '2-core' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'trace-1',
                  spanId: 'span-1',
                  parentSpanId: 'span-0',
                  name: 'claude_code.tool.blocked_on_user',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '1010000000',
                  attributes: [{ key: 'decision', value: { stringValue: 'unknown' } }],
                  status: { code: 0 },
                },
              ],
            },
          ],
        },
      ],
    }
    const result = parseTracesExport(body, testEmitter())
    expect(result.malformed).toBe(false)
    expect(result.events[0]?.payload).toMatchObject({ kind: 'tool_blocked', decision: 'unknown' })
  })

  it('maps OTLP status codes 0/1/2 to unset/ok/error', () => {
    const bodyWithStatus = (code: number | undefined) => ({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 't',
                  spanId: 's',
                  name: 'claude_code.tool',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                  ...(code === undefined ? {} : { status: { code } }),
                },
              ],
            },
          ],
        },
      ],
    })
    expect(parseTracesExport(bodyWithStatus(0), testEmitter()).events[0]?.payload).toMatchObject({ status: 'unset' })
    expect(parseTracesExport(bodyWithStatus(1), testEmitter()).events[0]?.payload).toMatchObject({ status: 'ok' })
    expect(parseTracesExport(bodyWithStatus(2), testEmitter()).events[0]?.payload).toMatchObject({ status: 'error' })
    expect(parseTracesExport(bodyWithStatus(undefined), testEmitter()).events[0]?.payload).toMatchObject({
      status: 'unset',
    })
  })

  it('records one collector.error per malformed span (missing identity) but still processes the rest of the request', () => {
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'lane', value: { stringValue: '2-core' } }] },
          scopeSpans: [
            {
              spans: [
                { name: 'claude_code.tool', startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000' }, // no traceId/spanId
                {
                  traceId: 'trace-1',
                  spanId: 'span-1',
                  name: 'claude_code.tool',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
          ],
        },
      ],
    }
    const result = parseTracesExport(body, testEmitter())
    expect(result.malformed).toBe(false)
    const errors = result.events.filter((e) => e.type === 'collector.error')
    const spans = result.events.filter((e) => e.type === 'trace.span')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.payload).toMatchObject({ collector: 'otel' })
    expect(spans).toHaveLength(1)
  })

  it('records a collector.error for a span with an unparseable start/end time, without throwing', () => {
    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'trace-1',
                  spanId: 'span-1',
                  name: 'claude_code.tool',
                  startTimeUnixNano: 'not-a-number',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
          ],
        },
      ],
    }
    expect(() => parseTracesExport(body, testEmitter())).not.toThrow()
    const result = parseTracesExport(body, testEmitter())
    expect(result.malformed).toBe(false)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.type).toBe('collector.error')
  })

  it('flags a body that is not a valid OTLP traces export as malformed, with one collector.error, and never throws', () => {
    const bad = { notResourceSpans: [] }
    expect(() => parseTracesExport(bad, testEmitter())).not.toThrow()
    const result = parseTracesExport(bad, testEmitter())
    expect(result.malformed).toBe(true)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ type: 'collector.error', payload: { collector: 'otel' } })
  })

  it('never throws on wildly wrong input types', () => {
    for (const body of [null, undefined, 'a string', 42, [], {}]) {
      expect(() => parseTracesExport(body, testEmitter())).not.toThrow()
      expect(parseTracesExport(body, testEmitter()).malformed).toBe(true)
    }
  })

  it('falls back to the unattributed lane when no lane attribute is set', () => {
    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 't',
                  spanId: 's',
                  name: 'claude_code.tool',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
          ],
        },
      ],
    }
    const result = parseTracesExport(body, testEmitter())
    expect(result.events[0]?.payload).toMatchObject({ lane: 'unattributed', role: 'worker' })
  })

  it('falls back to toolUseId from gen_ai.tool.call.id when tool_use_id is absent', () => {
    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 't',
                  spanId: 's',
                  name: 'claude_code.tool',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                  attributes: [{ key: 'gen_ai.tool.call.id', value: { stringValue: 'toolu_fallback' } }],
                },
              ],
            },
          ],
        },
      ],
    }
    const result = parseTracesExport(body, testEmitter())
    expect(result.events[0]?.payload).toMatchObject({ toolUseId: 'toolu_fallback' })
  })
})
