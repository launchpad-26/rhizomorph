import type { AgentThread, EventType, ObservatoryEvent, PayloadOf, SourceOf, TokenUsagePayload } from '@observatory/core'
import { agentThreadSchema, ZERO_TOKENS } from '@observatory/core'
import { resolveLane, resolveRole } from './attribution.js'
import { formatZodIssues } from './format-issues.js'
import {
  attrString,
  dataPointValue,
  exportMetricsRequestSchema,
  metricDataPoints,
  type OtlpKeyValue,
  type OtlpNumberDataPoint,
} from './types.js'

/**
 * Same shape as `CollectorContext.emit`, plus an optional explicit `source` —
 * `llm.usage`'s primary collector is `sessionlog`, so this receiver has to say
 * `otel` out loud rather than ride the type's default.
 */
export interface OtelEmitter {
  emit: <T extends EventType>(type: T, payload: PayloadOf<T>, source?: SourceOf<T>) => ObservatoryEvent
}

export interface ParseMetricsResult {
  events: ObservatoryEvent[]
  /** True when the body itself isn't a valid `ExportMetricsServiceRequest` — the 400 case. */
  malformed: boolean
}

const TOKEN_USAGE_METRIC = 'claude_code.token.usage'
const COST_USAGE_METRIC = 'claude_code.cost.usage'

/** `type` attribute values `claude_code.token.usage` sends, mapped to the core event's token tiers (research §S1). */
const TOKEN_TYPE_TO_TIER = {
  input: 'input',
  output: 'output',
  cacheRead: 'cacheRead',
  cacheCreation: 'cacheCreation',
} as const satisfies Record<string, keyof TokenUsagePayload>

/**
 * Parses one `POST /v1/metrics` body into `llm.usage` / `llm.cost` events.
 * Pure: no I/O, no clock — the caller's `emitter` supplies ids and timestamps,
 * same as every other collector.
 *
 * Two failure modes stay distinct on purpose:
 * - the whole body isn't OTLP-shaped → `malformed: true`, no events, the route
 *   answers 400.
 * - one datapoint is malformed (missing model, bad type) inside an otherwise
 *   fine request → a `collector.error` event for that datapoint alone; the
 *   request still succeeds, same as a poll collector logging one bad row
 *   without failing the whole tick.
 *
 * A metric name that isn't `claude_code.token.usage` or `claude_code.cost.usage`
 * is ignored silently — not an error, just a signal this receiver doesn't read yet.
 */
export function parseMetricsExport(body: unknown, emitter: OtelEmitter): ParseMetricsResult {
  const parsed = exportMetricsRequestSchema.safeParse(body)
  if (!parsed.success) {
    return {
      events: [
        emitter.emit('collector.error', {
          collector: 'otel',
          message: 'malformed OTLP metrics export request',
          detail: formatZodIssues(parsed.error.issues),
        }),
      ],
      malformed: true,
    }
  }

  const events: ObservatoryEvent[] = []

  for (const resourceMetrics of parsed.data.resourceMetrics) {
    const resourceAttrs = resourceMetrics.resource?.attributes
    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      for (const metric of scopeMetrics.metrics ?? []) {
        if (metric.name === TOKEN_USAGE_METRIC) {
          for (const dp of metricDataPoints(metric)) {
            events.push(buildUsageEvent(emitter, resourceAttrs, dp))
          }
        } else if (metric.name === COST_USAGE_METRIC) {
          for (const dp of metricDataPoints(metric)) {
            events.push(buildCostEvent(emitter, resourceAttrs, dp))
          }
        }
      }
    }
  }

  return { events, malformed: false }
}

/**
 * `query_source` is read to pick a role (see `resolveRole`) and, separately,
 * stored verbatim as `thread` when it's a value the core schema recognises
 * (`main` | `subagent` | `auxiliary`) — null for anything else, including
 * absent, rather than guessing.
 */
function resolveThread(querySource: string | undefined): AgentThread | null {
  const parsed = agentThreadSchema.safeParse(querySource)
  return parsed.success ? parsed.data : null
}

function buildUsageEvent(
  emitter: OtelEmitter,
  resourceAttrs: OtlpKeyValue[] | undefined,
  dp: OtlpNumberDataPoint,
): ObservatoryEvent {
  const type = attrString(dp.attributes, 'type')
  const value = dataPointValue(dp)
  const tier = TOKEN_TYPE_TO_TIER[type as keyof typeof TOKEN_TYPE_TO_TIER]
  if (!tier) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed ${TOKEN_USAGE_METRIC} datapoint: unrecognised type "${type ?? ''}"`,
    })
  }
  if (value === undefined || value < 0) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed ${TOKEN_USAGE_METRIC} datapoint: missing or invalid value`,
    })
  }
  const model = attrString(dp.attributes, 'model')
  if (!model) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed ${TOKEN_USAGE_METRIC} datapoint: missing model attribute`,
    })
  }

  const lane = resolveLane(resourceAttrs, dp.attributes)
  const querySource = attrString(dp.attributes, 'query_source')
  const role = resolveRole(resourceAttrs, lane, querySource)
  const thread = resolveThread(querySource)
  const sessionId = attrString(dp.attributes, 'session.id') ?? null

  // Each datapoint carries exactly one tier's worth of tokens per `type`
  // attribute (research §S1: input/output/cacheRead/cacheCreation) — the
  // other three tiers are zero on this event, same as sessionlog splitting
  // usage across separate messages instead of one combined total.
  const tokens: TokenUsagePayload = {
    ...ZERO_TOKENS,
    [tier]: Math.trunc(value),
  }

  return emitter.emit(
    'llm.usage',
    {
      lane,
      role,
      model,
      tokens,
      // Genuinely absent, not a gap we forgot to fill: `claude_code.token.usage`
      // datapoint attributes are session.id, model, query_source, type, user.id,
      // user.email, organization.id, terminal.type (research
      // 2026-07-30-telemetry-capture-routes.md §S1, a live capture) — no request
      // id, and every fixture in ./fixtures/ agrees. Inventing one (or joining on
      // sessionId+model+token-equality) would risk folding two distinct requests
      // into one in reduce.ts's dedup and silently deleting real spend, so this
      // stays null until OTel actually carries the attribute.
      requestId: null,
      durationMs: null,
      sessionId,
      worktreePath: null,
      branch: null,
      thread,
    },
    'otel',
  )
}

function buildCostEvent(
  emitter: OtelEmitter,
  resourceAttrs: OtlpKeyValue[] | undefined,
  dp: OtlpNumberDataPoint,
): ObservatoryEvent {
  const value = dataPointValue(dp)
  if (value === undefined || value < 0) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed ${COST_USAGE_METRIC} datapoint: missing or invalid value`,
    })
  }
  const model = attrString(dp.attributes, 'model')
  if (!model) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed ${COST_USAGE_METRIC} datapoint: missing model attribute`,
    })
  }

  const lane = resolveLane(resourceAttrs, dp.attributes)
  const querySource = attrString(dp.attributes, 'query_source')
  const role = resolveRole(resourceAttrs, lane, querySource)
  const thread = resolveThread(querySource)
  const sessionId = attrString(dp.attributes, 'session.id') ?? null

  return emitter.emit('llm.cost', {
    lane,
    role,
    model,
    // The agent CLI computes this client-side (research §S1) — no pricing table involved.
    costUsd: value,
    authoritative: true,
    estimateSource: null,
    // Same absence as buildUsageEvent's requestId: null — see the comment there.
    requestId: null,
    sessionId,
    worktreePath: null,
    branch: null,
    thread,
  })
}
