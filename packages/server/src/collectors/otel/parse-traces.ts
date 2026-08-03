import type { RhizomorphEvent, SpanDecision, SpanKind, SpanStatus, TokenUsagePayload } from '@rhizomorph/core'
import { spanDecisionSchema } from '@rhizomorph/core'
import { resolveLane, resolveRole } from './attribution.js'
import { formatZodIssues } from './format-issues.js'
import type { OtelEmitter } from './parse-metrics.js'
import { attrInt, attrString, exportTraceRequestSchema, type OtlpKeyValue, type OtlpSpan } from './types.js'

export interface ParseTracesResult {
  events: RhizomorphEvent[]
  /** True when the body itself isn't a valid `ExportTraceServiceRequest` — the 400 case. */
  malformed: boolean
}

/** Claude profile name→kind mapping (research §1). Any other name is `other`, never an error. */
const NAME_TO_KIND: Record<string, SpanKind> = {
  'claude_code.interaction': 'interaction',
  'claude_code.llm_request': 'llm_request',
  'claude_code.tool': 'tool',
  'claude_code.tool.blocked_on_user': 'tool_blocked',
  'claude_code.tool.execution': 'tool_execution',
  'claude_code.hook': 'hook',
}

function classify(name: string): SpanKind {
  return NAME_TO_KIND[name] ?? 'other'
}

/** OTLP span status: 0 unset, 1 ok, 2 error (research §1 / OTLP spec). Anything else is `unset`. */
function mapStatus(code: number | undefined): SpanStatus {
  if (code === 1) return 'ok'
  if (code === 2) return 'error'
  return 'unset'
}

/**
 * Nanosecond epoch, exported as a decimal string, converted to epoch ms via
 * BigInt division — `Number(nanoString)` loses precision on values this size
 * and is a bug. Returns `undefined` for anything that isn't parseable, which
 * the caller treats as a malformed span.
 */
function nanoToMs(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined
  try {
    const nanos = typeof raw === 'number' ? BigInt(Math.trunc(raw)) : BigInt(raw)
    return Number(nanos / 1_000_000n)
  } catch {
    return undefined
  }
}

/** The four token tiers, present only when at least one of the attributes rode the span (`llm_request` only, in the capture). */
function extractTokens(attrs: OtlpKeyValue[] | undefined): TokenUsagePayload | null {
  const input = attrInt(attrs, 'input_tokens')
  const output = attrInt(attrs, 'output_tokens')
  const cacheRead = attrInt(attrs, 'cache_read_tokens')
  const cacheCreation = attrInt(attrs, 'cache_creation_tokens')
  if (input === undefined && output === undefined && cacheRead === undefined && cacheCreation === undefined) {
    return null
  }
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheCreation: cacheCreation ?? 0,
  }
}

function extractDecision(attrs: OtlpKeyValue[] | undefined): SpanDecision | null {
  const raw = attrString(attrs, 'decision')
  if (raw === undefined) return null
  const parsed = spanDecisionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Parses one `POST /v1/traces` body into `trace.span` events. Pure: no I/O, no
 * clock — the caller's `emitter` supplies ids and timestamps, same as
 * `parse-metrics.ts`.
 *
 * Two failure modes stay distinct, mirroring the metrics receiver:
 * - the whole body isn't OTLP-shaped → `malformed: true`, no events, the
 *   route answers 400.
 * - one span is malformed (missing traceId/spanId/name, or an unparseable
 *   start/end time) inside an otherwise fine request → a `collector.error`
 *   event for that span alone; the request still succeeds.
 *
 * Everything not on `traceSpanPayloadSchema`'s fixed allowlist — `user.email`,
 * `user.account_*`, `organization.id`, `user_prompt`, `gen_ai.*` beyond what's
 * named below — is read here and then never carried further: there is no
 * attributes map on the payload for a stray attribute to land in.
 */
export function parseTracesExport(body: unknown, emitter: OtelEmitter): ParseTracesResult {
  const parsed = exportTraceRequestSchema.safeParse(body)
  if (!parsed.success) {
    return {
      events: [
        emitter.emit('collector.error', {
          collector: 'otel',
          message: 'malformed OTLP traces export request',
          detail: formatZodIssues(parsed.error.issues),
        }),
      ],
      malformed: true,
    }
  }

  const events: RhizomorphEvent[] = []

  for (const resourceSpans of parsed.data.resourceSpans) {
    const resourceAttrs = resourceSpans.resource?.attributes
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        events.push(buildSpanEvent(emitter, resourceAttrs, span))
      }
    }
  }

  return { events, malformed: false }
}

function buildSpanEvent(emitter: OtelEmitter, resourceAttrs: OtlpKeyValue[] | undefined, span: OtlpSpan): RhizomorphEvent {
  const { traceId, spanId, name } = span
  if (!traceId || !spanId || !name) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: 'malformed span: missing traceId, spanId, or name',
    })
  }

  const startTs = nanoToMs(span.startTimeUnixNano)
  const endTs = nanoToMs(span.endTimeUnixNano)
  if (startTs === undefined || endTs === undefined) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed span "${name}": missing or unparseable start/end time`,
    })
  }

  const attrs = span.attributes
  const lane = resolveLane(resourceAttrs, attrs)
  const role = resolveRole(resourceAttrs, lane, undefined)
  const sessionId = attrString(attrs, 'session.id') ?? null

  return emitter.emit('trace.span', {
    lane,
    role,
    sessionId,
    // OTel carries no cwd/branch (attribution.ts), same absence as the metrics parser.
    worktreePath: null,
    branch: null,
    // No query_source-equivalent signal rides on a span in the capture.
    thread: null,

    traceId,
    spanId,
    parentSpanId: span.parentSpanId ?? null,

    name,
    kind: classify(name),

    startTs,
    endTs,
    status: mapStatus(span.status?.code),

    model: attrString(attrs, 'model') ?? null,
    tokens: extractTokens(attrs),
    ttftMs: attrInt(attrs, 'ttft_ms') ?? null,
    requestId: attrString(attrs, 'request_id') ?? null,
    agentId: attrString(attrs, 'agent_id') ?? null,
    parentAgentId: attrString(attrs, 'parent_agent_id') ?? null,
    toolName: attrString(attrs, 'tool_name') ?? null,
    toolUseId: attrString(attrs, 'tool_use_id') ?? attrString(attrs, 'gen_ai.tool.call.id') ?? null,
    subagentType: attrString(attrs, 'subagent_type') ?? null,
    decision: extractDecision(attrs),
  })
}
