import type { AgentThread, EventType, RhizomorphEvent, PayloadOf, SourceOf, TokenUsagePayload } from '@rhizomorph/core'
import { agentThreadSchema, ZERO_TOKENS } from '@rhizomorph/core'
import { resolveLane, resolveRole } from './attribution.js'
import { formatZodIssues } from './format-issues.js'
import { resolveMetricProfile, type HarnessMetricProfile } from './harness-profiles.js'
import { voiceSkips, type ParseSkip } from '../parse-skip.js'
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
  emit: <T extends EventType>(type: T, payload: PayloadOf<T>, source?: SourceOf<T>) => RhizomorphEvent
}

export interface ParseMetricsResult {
  events: RhizomorphEvent[]
  /** True when the body itself isn't a valid `ExportMetricsServiceRequest` — the 400 case. */
  malformed: boolean
}

/**
 * Parses one `POST /v1/metrics` body into `llm.usage` / `llm.cost` /
 * `agent.activeTime` events. Pure: no I/O, no clock — the caller's `emitter`
 * supplies ids and timestamps, same as every other collector.
 *
 * Two failure modes stay distinct on purpose:
 * - the whole body isn't OTLP-shaped → `malformed: true`, no events, the route
 *   answers 400.
 * - one datapoint is malformed (missing model, bad type) inside an otherwise
 *   fine request → a `collector.error` event for that datapoint alone; the
 *   request still succeeds, same as a poll collector logging one bad row
 *   without failing the whole tick.
 *
 * Which metric names this route reads depends on the exporting harness
 * (`harness-profiles.ts`, keyed on the `service.name` resource attribute).
 * A metric name outside a *recognised* harness's profile — or a
 * `gemini_cli.token.usage` `type` value with no tier, per that harness's
 * declared gap — is not silently dropped any more: every such record in one
 * request coalesces into a single trailing `collector.error`, so a chatty
 * exporter posting many unread record kinds costs one event, not one per
 * record (ADR-0025). An entirely unrecognised harness (no `service.name`
 * match) still parses under claude's profile and stays silent when nothing
 * matches — that harness never claimed to be one this receiver knows.
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

  const events: RhizomorphEvent[] = []
  const unread: ParseSkip[] = []

  for (const resourceMetrics of parsed.data.resourceMetrics) {
    const resourceAttrs = resourceMetrics.resource?.attributes
    const { profile, recognized } = resolveMetricProfile(resourceAttrs)
    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      for (const metric of scopeMetrics.metrics ?? []) {
        if (metric.name === profile.tokenUsageMetric) {
          for (const dp of metricDataPoints(metric)) {
            pushBuiltEvent(events, emitter, metric.name, () => buildUsageEvent(emitter, profile, resourceAttrs, dp, unread))
          }
        } else if (profile.costUsageMetric !== null && metric.name === profile.costUsageMetric) {
          for (const dp of metricDataPoints(metric)) {
            pushBuiltEvent(events, emitter, metric.name, () => buildCostEvent(emitter, metric.name, resourceAttrs, dp))
          }
        } else if (profile.activeTimeMetric !== null && metric.name === profile.activeTimeMetric) {
          for (const dp of metricDataPoints(metric)) {
            pushBuiltEvent(events, emitter, metric.name, () => buildActiveTimeEvent(emitter, metric.name, resourceAttrs, dp))
          }
        } else if (recognized) {
          unread.push({ line: `${profile.serviceName} metric "${metric.name}"`, reason: 'not in this receiver\'s profile for that harness' })
        }
      }
    }
  }

  if (unread.length > 0) {
    events.push(
      emitter.emit('collector.error', {
        collector: 'otel',
        // The message is STABLE — no count in it — because `api/otel.ts`'s
        // `recordFault` keys its throttle on exactly this string. The first
        // version read "N records from a known harness…", so a post with 9
        // unread and a post with 8 were different keys and neither collapsed.
        // The varying part belongs in `detail`, and the number of collapsed
        // occurrences arrives as the payload's own `count` from the throttle.
        message: "a known harness sent records this receiver doesn't fully read",
        detail: `${unread.length} record${unread.length === 1 ? '' : 's'}: ${voiceSkips(unread)}`,
      }),
    )
  }

  return { events, malformed: false }
}

/**
 * #510: a datapoint builder throwing for an unforeseen reason (a future
 * attribute shape, a schema change — e.g. an `asInt` string wide enough that
 * `Number(...)` rounds it past `Number.MAX_SAFE_INTEGER`, which
 * `tokenUsageSchema`'s `z.number().int()` then rejects) must not cost every
 * other datapoint in the same request, exactly the hazard `parse-traces.ts`'s
 * per-span loop guards against. One bad datapoint degrades to its own
 * `collector.error` instead.
 *
 * `build` returning `null` means the datapoint was handled without an event
 * of its own — a declared-gap token type recorded itself into the caller's
 * `unread` list instead (see `buildUsageEvent`).
 */
function pushBuiltEvent(
  events: RhizomorphEvent[],
  emitter: OtelEmitter,
  metricName: string,
  build: () => RhizomorphEvent | null,
): void {
  try {
    const event = build()
    if (event) events.push(event)
  } catch (err) {
    events.push(
      emitter.emit('collector.error', {
        collector: 'otel',
        message: `${metricName} datapoint failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      }),
    )
  }
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
  profile: HarnessMetricProfile,
  resourceAttrs: OtlpKeyValue[] | undefined,
  dp: OtlpNumberDataPoint,
  unread: ParseSkip[],
): RhizomorphEvent | null {
  const type = attrString(dp.attributes, 'type')
  const value = dataPointValue(dp)
  const tier = type ? profile.tokenTypeToTier[type] : undefined
  if (!tier) {
    if (type !== undefined && profile.declaredGapTokenTypes.includes(type)) {
      // A known-but-homeless token type, not malformed data: the harness said
      // exactly what it meant, TokenUsagePayload just has no tier for it yet
      // (ruling 4 — an additive core PR, not this receiver). Counted and
      // surfaced, never silently folded into a tier or dropped.
      unread.push({
        line: `${profile.serviceName} token type "${type}" = ${value ?? 'missing'}`,
        reason: 'no tier in TokenUsagePayload (declared gap, not malformed)',
      })
      return null
    }
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed ${profile.tokenUsageMetric} datapoint: unrecognised type "${type ?? ''}"`,
    })
  }
  if (value === undefined || value < 0) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed ${profile.tokenUsageMetric} datapoint: missing or invalid value`,
    })
  }
  const model = attrString(dp.attributes, 'model')
  if (!model) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed ${profile.tokenUsageMetric} datapoint: missing model attribute`,
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
  metricName: string,
  resourceAttrs: OtlpKeyValue[] | undefined,
  dp: OtlpNumberDataPoint,
): RhizomorphEvent {
  const value = dataPointValue(dp)
  if (value === undefined || value < 0) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed ${metricName} datapoint: missing or invalid value`,
    })
  }
  const model = attrString(dp.attributes, 'model')
  if (!model) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed ${metricName} datapoint: missing model attribute`,
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

/**
 * #141: `claude_code.active_time.total` carries no `model` attribute (unlike
 * the two metrics above), so this is the one datapoint builder in the file
 * that never checks for one. Everything else — lane/role resolution, the
 * `session.id` join key, `thread` — reads through the same attribute
 * allowlist `buildUsageEvent`/`buildCostEvent` already use.
 */
function buildActiveTimeEvent(
  emitter: OtelEmitter,
  metricName: string,
  resourceAttrs: OtlpKeyValue[] | undefined,
  dp: OtlpNumberDataPoint,
): RhizomorphEvent {
  const value = dataPointValue(dp)
  if (value === undefined || value < 0) {
    return emitter.emit('collector.error', {
      collector: 'otel',
      message: `malformed ${metricName} datapoint: missing or invalid value`,
    })
  }

  const lane = resolveLane(resourceAttrs, dp.attributes)
  const querySource = attrString(dp.attributes, 'query_source')
  const role = resolveRole(resourceAttrs, lane, querySource)
  const thread = resolveThread(querySource)
  const sessionId = attrString(dp.attributes, 'session.id') ?? null

  return emitter.emit('agent.activeTime', {
    lane,
    role,
    activeSeconds: value,
    sessionId,
    worktreePath: null,
    branch: null,
    thread,
  })
}
