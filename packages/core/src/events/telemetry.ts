import { z } from 'zod'
import { envelopeWithSources, nonEmptyString } from './common.js'

/**
 * prd1 — the money layer. Token, dollar and tool-activity facts, taken from the
 * agents' own native signals.
 *
 * Two collectors produce these, and the envelope's `source` says which:
 *
 * - `sessionlog` — depth. `~/.claude/projects/<worktree>/*.jsonl`: per-message
 *   tokens by cache tier, model, `requestId`, `durationMs`, tool calls.
 *   Attribution is structural (`cwd`/`gitBranch` on every line). No dollars.
 * - `otel` — authority. An OTLP/HTTP receiver in our own server: real
 *   `cost_usd` computed client-side by the agent CLI, no pricing table needed.
 *   No cwd/branch, so lane attribution comes from a `session.id` join or from
 *   `OTEL_RESOURCE_ATTRIBUTES=lane=<handle>` set at dispatch.
 *
 * Shapes here follow the live captures in
 * `research/2026-07-30-telemetry-capture-routes.md` §S1/§S2.
 */

/** Where a telemetry fact came from. A subset of `EventSource`. */
export const telemetryOriginSchema = z.enum(['sessionlog', 'otel'])
export type TelemetryOrigin = z.infer<typeof telemetryOriginSchema>

/** The two sources allowed on a telemetry envelope, as a tuple for zod. */
const TELEMETRY_SOURCES = ['sessionlog', 'otel'] as const

/**
 * Who was spending. The conductor counts: orchestrated setups undercount by
 * omitting the orchestrator's own burn, so `role` is a first-class dimension
 * and not something a selector guesses from a lane name.
 *
 * - `worker` — a fenced lane doing the work (OTel `query_source: main`).
 * - `conductor` — the orchestrator itself, wherever it runs.
 * - `auxiliary` — the CLI's own background calls: titles, summaries, the haiku
 *   traffic the OTel capture showed riding alongside a worker session.
 */
export const agentRoleSchema = z.enum(['worker', 'conductor', 'auxiliary'])
export type AgentRole = z.infer<typeof agentRoleSchema>

export const AGENT_ROLES = ['worker', 'conductor', 'auxiliary'] as const satisfies readonly AgentRole[]

/**
 * Lane for spend we could not attribute — an OTel datapoint that arrived with
 * no resource attribute and no session we have seen. Kept as a real lane on
 * purpose: unattributed dollars must stay visible, not be silently dropped.
 */
export const UNATTRIBUTED_LANE = 'unattributed'

/**
 * Tokens by cache tier, exactly the four buckets the session JSONL reports per
 * message. All four are required: a collector that cannot break out cache
 * detail (OTel's `token.usage` splits `input`/`output` only) sends zeros, and
 * the envelope's `source` says why they are zero.
 */
export const tokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheCreation: z.number().int().nonnegative(),
})
export type TokenUsagePayload = z.infer<typeof tokenUsageSchema>

/** Attribution fields every telemetry payload carries, in one place. */
const attribution = {
  /**
   * The swarm handle this spend belongs to — a workmux handle / branch / window
   * name. Always present; see {@link UNATTRIBUTED_LANE}.
   */
  lane: nonEmptyString,
  /** Agent CLI session id — the join key between the two collectors. */
  sessionId: nonEmptyString.nullable().optional(),
  worktreePath: nonEmptyString.nullable().optional(),
  branch: nonEmptyString.nullable().optional(),
}

/** One model request's token cost. The densest fact prd1 has. */
export const llmUsagePayloadSchema = z.object({
  ...attribution,
  role: agentRoleSchema,
  model: nonEmptyString,
  tokens: tokenUsageSchema,
  /** The CLI's own request id, when the source reports one. */
  requestId: nonEmptyString.nullable().optional(),
  /** Wall-clock for the request, per the session log's `durationMs`. */
  durationMs: z.number().int().nonnegative().nullable().optional(),
})
export type LlmUsagePayload = z.infer<typeof llmUsagePayloadSchema>

/**
 * Dollars. `authoritative: true` means the number came from the agent CLI's own
 * `cost_usd` (OTel) — no pricing table, no arithmetic of ours. `false` means we
 * estimated it from tokens, and the UI must say so; sessionlog-only data carries
 * no dollars at all rather than inventing them.
 */
export const llmCostPayloadSchema = z.object({
  ...attribution,
  role: agentRoleSchema,
  model: nonEmptyString,
  costUsd: z.number().nonnegative(),
  authoritative: z.boolean(),
  /** What produced an estimate, e.g. a pricing-table name and version. */
  estimateSource: nonEmptyString.nullable().optional(),
  requestId: nonEmptyString.nullable().optional(),
})
export type LlmCostPayload = z.infer<typeof llmCostPayloadSchema>

/**
 * One tool call, from a session log's `tool_use` block. The timeline half of
 * prd1: what a lane's tokens were actually spent doing. `ts` is the envelope's.
 */
export const toolActivityPayloadSchema = z.object({
  ...attribution,
  /** Tool name as the agent reported it: `Bash`, `Edit`, `Read`, … */
  tool: nonEmptyString,
  /** Known when the collector knows the lane's role; never guessed. */
  role: agentRoleSchema.nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
})
export type ToolActivityPayload = z.infer<typeof toolActivityPayloadSchema>

export const llmUsageEventSchema = envelopeWithSources(
  TELEMETRY_SOURCES,
  'llm.usage',
  llmUsagePayloadSchema,
)
export const llmCostEventSchema = envelopeWithSources(
  TELEMETRY_SOURCES,
  'llm.cost',
  llmCostPayloadSchema,
)
export const toolActivityEventSchema = envelopeWithSources(
  TELEMETRY_SOURCES,
  'tool.activity',
  toolActivityPayloadSchema,
)

export const telemetryEventSchemas = [
  llmUsageEventSchema,
  llmCostEventSchema,
  toolActivityEventSchema,
] as const

/** Sum of the four tiers — the one number a token total always means. */
export function totalTokens(tokens: TokenUsagePayload): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation
}

export const ZERO_TOKENS: TokenUsagePayload = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
}

export function addTokens(a: TokenUsagePayload, b: TokenUsagePayload): TokenUsagePayload {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  }
}
