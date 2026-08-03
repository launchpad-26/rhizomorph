import { z } from 'zod'
import { envelope, nonEmptyString, timestampSchema } from './common.js'
import { agentRoleSchema, agentThreadSchema, tokenUsageSchema } from './telemetry.js'

/**
 * prd9 — the trace era. One finished span of an agent CLI's own OTLP trace
 * export: the waterfall's atom, and the only event type the trace layer has.
 *
 * Source is always `otel` — these arrive at our own `/v1/traces` receiver, the
 * same door prd1's metrics use. Shapes here follow the live captures in
 * `research/2026-08-03-trace-era-captures.md` §1 (claude 2.1.220): one trace
 * per prompt, `claude_code.interaction` (root) → `llm_request` / `tool` →
 * `tool.blocked_on_user` + `tool.execution`, with lane/role/session attribution
 * riding on every span exactly as prd1's attribution already expects.
 *
 * Three rulings are built into this payload rather than left to a parser's good
 * behaviour:
 *
 * - **Beta churn is data, not schema** (ruling 3). {@link traceSpanPayloadSchema.name}
 *   is the RAW span name string and is never an enum; the stable
 *   {@link spanKindSchema} is what surfaces read. An unrecognised name is
 *   `other`, never an error, so a CLI upgrade that renames a span is a fixture
 *   update and not a migration.
 * - **Spans never feed spend** (ruling 4). `llm_request` spans carry the same
 *   four token tiers `llm.usage` already counts, so the tokens here are
 *   waterfall annotation only. Nothing in `state.traces` is read by any spend
 *   selector, and `reduce.ts` keeps spans out of the telemetry slice entirely —
 *   see the law in `trace.test.ts`.
 * - **Privacy by allowlist-of-construction** (ruling 5). `user.email`,
 *   `user.account_*` and `organization.id` ride on every span both CLIs emit,
 *   and the root span carries a `user_prompt` attribute. So there is no
 *   attributes map here and no field any of them could land in: the fields
 *   below are the whole allowlist, and zod strips everything else off a payload
 *   before it can reach the log. Storing a new fact means adding a named field
 *   here, in the open, on purpose.
 */

/**
 * The parser-derived, stable classification of a span — what every surface
 * switches on, so no display ever depends on a beta name string.
 *
 * - `interaction` — the root span of one prompt (`claude_code.interaction`).
 * - `llm_request` — one model request; the only kind the capture showed
 *   carrying tokens, a model, a `ttft_ms` and a `request_id`.
 * - `tool` — a tool call as a whole.
 * - `tool_blocked` — the permission wait inside it
 *   (`claude_code.tool.blocked_on_user`), which is where `decision` lives.
 * - `tool_execution` — the run itself, once permitted.
 * - `hook` — hook spans, behind the CLI's detailed-tracing beta. Named here so
 *   the enum does not have to change when they are turned on; prd9 ruling 9
 *   keeps them out of scope this week.
 * - `other` — anything the mapping does not recognise. Unknown names land here
 *   and are never dropped and never an error.
 */
export const spanKindSchema = z.enum([
  'interaction',
  'llm_request',
  'tool',
  'tool_blocked',
  'tool_execution',
  'hook',
  'other',
])
export type SpanKind = z.infer<typeof spanKindSchema>

export const SPAN_KINDS = [
  'interaction',
  'llm_request',
  'tool',
  'tool_blocked',
  'tool_execution',
  'hook',
  'other',
] as const satisfies readonly SpanKind[]

/**
 * OTel's span status, normalised. `unset` is the default an exporter sends when
 * nothing went wrong *and* nothing explicitly declared success — it is not a
 * synonym for `ok`, and a reader must not render it as one.
 */
export const spanStatusSchema = z.enum(['ok', 'error', 'unset'])
export type SpanStatus = z.infer<typeof spanStatusSchema>

/**
 * What a human decided about a tool that was blocked on them. `unknown` is what
 * the capture actually shows for a pre-allowed tool ([Ran], §1) — the span
 * exists, the wait was microseconds and nobody was asked — so it is a real
 * value here rather than an absence.
 *
 * Ruling 6: spans export when they END, so this is retrospective-exact. An open
 * permission wait has no span yet and is the attention strip's job, not this
 * event's.
 */
export const spanDecisionSchema = z.enum(['accept', 'reject', 'unknown'])
export type SpanDecision = z.infer<typeof spanDecisionSchema>

/**
 * The same attribution prd1's telemetry payloads carry, mirrored field for
 * field (`events/telemetry.ts`) so one lane index, one session join and one
 * `UNATTRIBUTED_LANE` fallback serve both eras. The capture confirms every one
 * of these survives the trace exporter: `OTEL_RESOURCE_ATTRIBUTES` lands on
 * each span's own attributes, and `session.id` is on every span.
 */
const attribution = {
  /** The swarm handle this span belongs to; `UNATTRIBUTED_LANE` when nobody said. */
  lane: nonEmptyString,
  /** Agent CLI session id — the join key, present on every captured span. */
  sessionId: nonEmptyString.nullable().optional(),
  worktreePath: nonEmptyString.nullable().optional(),
  branch: nonEmptyString.nullable().optional(),
  /** Which thread of the session ran it; null when the source didn't say. */
  thread: agentThreadSchema.nullable().optional(),
}

/**
 * One span. Identity, naming, time, status — then a fixed allowlist of optional
 * facts, every one of which is `null` or absent when the span did not carry it.
 */
export const traceSpanPayloadSchema = z.object({
  ...attribution,
  role: agentRoleSchema,

  // --- identity -------------------------------------------------------------
  /** OTLP trace id, hex as exported. One trace per prompt, in the capture. */
  traceId: nonEmptyString,
  /** OTLP span id. Unique within its trace; `(traceId, spanId)` is the key the fold dedups on. */
  spanId: nonEmptyString,
  /** Parent within the same trace, or `null` for a root. Required so a root says so out loud. */
  parentSpanId: nonEmptyString.nullable(),

  // --- naming ---------------------------------------------------------------
  /**
   * The raw span name, verbatim: `claude_code.llm_request`, `session_task.turn`,
   * whatever the beta emits next. Never an enum — see the module note.
   */
  name: nonEmptyString,
  /** The stable classification a surface reads. Mapping names → kinds is the parser's job. */
  kind: spanKindSchema,

  // --- time and status ------------------------------------------------------
  /** Span start, epoch millis (OTLP exports nanos; the parser divides). */
  startTs: timestampSchema,
  /**
   * Span end, epoch millis. Both ends are known because a span is only exported
   * once it has ended. Duration is `endTs - startTs` and is deliberately not
   * stored: it is a selector's subtraction, like every other derived number.
   */
  endTs: timestampSchema,
  status: spanStatusSchema,

  // --- the allowlist --------------------------------------------------------
  /** `llm_request` only, in the capture. */
  model: nonEmptyString.nullable().optional(),
  /**
   * The four tiers, when the span reported them. Annotation only: these
   * duplicate what `llm.usage` already counts, and ruling 4 forbids them
   * reaching spend.
   */
  tokens: tokenUsageSchema.nullable().optional(),
  /** Time to first token, for an `llm_request`. */
  ttftMs: z.number().int().nonnegative().nullable().optional(),
  /** The CLI's own request id — the JOIN key to a spend record, never a source of one. */
  requestId: nonEmptyString.nullable().optional(),
  /** Subagent identity, when a span belongs to one. */
  agentId: nonEmptyString.nullable().optional(),
  /** The agent that spawned {@link agentId}; documented by the CLI, unobserved in the capture. */
  parentAgentId: nonEmptyString.nullable().optional(),
  /** Tool name as the agent reported it: `Bash`, `Edit`, `Task`, … */
  toolName: nonEmptyString.nullable().optional(),
  toolUseId: nonEmptyString.nullable().optional(),
  /** Which subagent type a `Task` call dispatched to, when the span says. */
  subagentType: nonEmptyString.nullable().optional(),
  /** `tool_blocked` only. See {@link spanDecisionSchema}. */
  decision: spanDecisionSchema.nullable().optional(),
})
export type TraceSpanPayload = z.infer<typeof traceSpanPayloadSchema>

/** Only our own OTLP receiver produces spans, so this one has a single source. */
export const traceSpanEventSchema = envelope('otel', 'trace.span', traceSpanPayloadSchema)

export const traceEventSchemas = [traceSpanEventSchema] as const
