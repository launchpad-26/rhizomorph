import { z } from 'zod'
import { envelope, envelopeWithSources, nonEmptyString, timestampSchema } from './common.js'

/**
 * prd1 — the money layer. Token, dollar and tool-activity facts, taken from the
 * agents' own native signals.
 *
 * Two collectors produce these, and the envelope's `source` says which:
 *
 * - `sessionlog` — depth. Tails an agent CLI's own transcript file for
 *   per-message tokens by cache tier, model, `requestId`, `durationMs`, tool
 *   calls. Claude Code's `~/.claude/projects/<worktree>/*.jsonl` was the only
 *   dialect until #538; `harness` on the shared attribution (below) names any
 *   other one, absent meaning Claude's. Attribution is structural
 *   (`cwd`/`gitBranch` on every line). Claude's own dialect carries no
 *   dollars; another dialect's `llm.cost` may (pi's session JSONL reports an
 *   authoritative per-turn cost — see `collectors/pi/capabilities.ts`), and
 *   says so with `harness` and `authoritative: true`, same as otel does.
 * - `otel` — authority. An OTLP/HTTP receiver in our own server: real
 *   `cost_usd` computed client-side by the agent CLI, no pricing table needed.
 *   No cwd/branch, so lane attribution comes from a `session.id` join or from
 *   `OTEL_RESOURCE_ATTRIBUTES=lane=<handle>` set at dispatch.
 *
 * Shapes here follow the live captures in
 * `research/2026-07-30-telemetry-capture-routes.md` §S1/§S2.
 */

/**
 * Where a telemetry fact came from. Two collectors and one second hand.
 *
 * `sessionlog` names a *kind* of collector — one that tails an agent CLI's own
 * transcript file — not one specific CLI. Claude Code's collector was the only
 * one that existed when this enum was written, which is why the literal reads
 * claude-ish; #538 keeps it generic rather than adding a second spelling
 * (`'transcript'`) for the same concept, since ADR-0011 forbids migrating the
 * recordings that already carry `source: 'sessionlog'`. A dialect other than
 * Claude's names itself with `harness` on the attribution shared by every
 * telemetry payload (see below) — absent `harness` means Claude Code's own
 * collector, the only meaning `sessionlog` has ever had before this.
 *
 * **`lab` IS NOT A COLLECTOR, AND THAT IS THE WHOLE POINT OF ITS SPELLING**
 * (prd55 ruling 1, #430). The first two members are collectors and are members
 * of `EventSource`; `'lab'` is deliberately neither. `events/lab.ts` states the
 * reason for the lab's own events and it is unchanged here: the laboratory is
 * an explicitly-invoked second hand and "never runs unattended behind a poll
 * loop the way a collector does", so `'lab'` stays out of `eventSourceSchema`
 * where a reader of `common.ts` could mistake it for a seventh collector. A
 * cost the lab BOOKED is the same kind of fact as a checkpoint the lab
 * CAPTURED — not a reading anybody polled — so it names the same actor, by the
 * same literal, kept outside the same enum.
 *
 * Only `llm.cost` may carry it. `llm.usage` and `tool.activity` stay bound to
 * {@link TELEMETRY_SOURCES}, the collector pair, because nothing but a
 * collector has ever produced a token count or a tool call: the R&D hand reads
 * its own spend off the CLI's JSON result and has no transcript and no
 * receiver to take either of the other two readings from. So this enum is the
 * union of everything a telemetry RECORD's `origin` may say, and each event
 * type's own envelope below is what fixes which of them it may say — the same
 * shape `EVENT_SOURCE_BY_TYPE` already has for a primary source, and not a
 * licence for the lab to sign a reading.
 */
export const telemetryOriginSchema = z.enum(['sessionlog', 'otel', 'lab'])
export type TelemetryOrigin = z.infer<typeof telemetryOriginSchema>

/** The two COLLECTOR sources allowed on a telemetry envelope, as a tuple for zod. */
const TELEMETRY_SOURCES = ['sessionlog', 'otel'] as const

/**
 * The sources allowed on an `llm.cost` envelope: the two collectors, plus the
 * lab's own hand (prd55 ruling 1, #430 — see {@link telemetryOriginSchema}).
 *
 * A tuple of its own rather than a third entry in {@link TELEMETRY_SOURCES},
 * because widening that one would have said that the lab may also report token
 * usage and tool activity, which it cannot and does not.
 */
const LLM_COST_SOURCES = ['sessionlog', 'otel', 'lab'] as const

/**
 * Who was spending. The conductor counts: orchestrated setups undercount by
 * omitting the orchestrator's own burn, so `role` is a first-class dimension
 * and not something a selector guesses from a lane name.
 *
 * - `worker` — a fenced lane doing the work (OTel `query_source: main`).
 * - `conductor` — the orchestrator itself, wherever it runs.
 * - `auxiliary` — the CLI's own background calls: titles, summaries, the haiku
 *   traffic the OTel capture showed riding alongside a worker session.
 * - `unattributed` — nobody said. prd2's ruling is that identity is declared at
 *   the source, so a session that declared no role is booked here and shown as
 *   a setup gap, never quietly filed as `worker` (which is what made a
 *   conductor at the repo root read as worker spend in the live baseline).
 */
export const agentRoleSchema = z.enum(['worker', 'conductor', 'auxiliary', 'unattributed'])
export type AgentRole = z.infer<typeof agentRoleSchema>

export const AGENT_ROLES = [
  'worker',
  'conductor',
  'auxiliary',
  'unattributed',
] as const satisfies readonly AgentRole[]

/**
 * Which thread *inside* a session was spending. Both collectors already receive
 * this and prd1 stored neither (audit §C): OTel datapoints carry
 * `query_source` (`main` | `subagent`), and a session-log line marks a
 * subagent turn with `isSidechain: true`.
 *
 * - `main` — the session's own conversation: the agent someone dispatched.
 * - `subagent` — work that agent handed to a Task/subagent thread.
 * - `auxiliary` — the CLI's own background traffic (titles, summaries) riding
 *   inside the same session.
 *
 * prd2's ruling is **sub-rows under the parent lane** — the lane stays the unit
 * of work — so a thread is a dimension of a lane's spend, never a lane of its
 * own. Absent or `null` means *the source did not say*, and a reader must
 * render that as unknown rather than assume `main`. Parsing the two markers
 * into this field is #65's job; the schema, the fold and the sub-totals are
 * here so the value has somewhere to land.
 */
export const agentThreadSchema = z.enum(['main', 'subagent', 'auxiliary'])
export type AgentThread = z.infer<typeof agentThreadSchema>

export const AGENT_THREADS = ['main', 'subagent', 'auxiliary'] as const satisfies readonly AgentThread[]

/**
 * Lane for spend we could not attribute — an OTel datapoint that arrived with
 * no resource attribute and no session we have seen. Kept as a real lane on
 * purpose: unattributed dollars must stay visible, not be silently dropped.
 */
export const UNATTRIBUTED_LANE = 'unattributed'

/**
 * Tokens by cache tier, exactly the four buckets the session JSONL reports per
 * message. All four are required: OTel's `claude_code.token.usage` metric
 * carries a `type` attribute naming exactly one of the four tiers per
 * datapoint, and `parse-metrics.ts` maps all four (`input`, `output`,
 * `cacheRead`, `cacheCreation`) — a single OTel `llm.usage` event reports that
 * one tier's real value and zeros on the rest, never a collector-wide
 * inability to see cache detail.
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
  /**
   * Agent CLI session id — the join key between the two collectors, and the
   * only honest way dollars reach a branch: OTel knows the session and the
   * cost, sessionlog knows the session and the place. The reducer joins them
   * on this (`packages/core/src/reduce.ts`, `resolvePlace`).
   */
  sessionId: nonEmptyString.nullable().optional(),
  worktreePath: nonEmptyString.nullable().optional(),
  branch: nonEmptyString.nullable().optional(),
  /** Which thread of the session spent it; null when the source didn't say. */
  thread: agentThreadSchema.nullable().optional(),
  /**
   * Which agent CLI's transcript this `sessionlog`-sourced fact was tailed
   * from — `'pi'`, `'codex'`, and so on. A free string, not a closed enum: the
   * whole point of #538 is that a new dialect names itself here, entirely
   * inside its own collector, instead of widening `EventSource` and costing a
   * core PR per harness (prd-26 ruling 4).
   *
   * Absent or null means Claude Code's own collector — the one dialect
   * `sessionlog` named before this field existed, and still what every event
   * logged before #538 means by omitting it (see the additive-law test in
   * `telemetry.test.ts`). Meaningless on an `otel`-sourced record, since otel
   * has only ever had the one dialect; left here rather than duplicated per
   * payload so every telemetry fact shares one attribution shape.
   *
   * Trims before checking length, unlike the shared `nonEmptyString` (whose
   * behaviour this deliberately does not change for every other attribution
   * field): a whitespace-only string is exactly as absent a harness name as
   * `''`, and `nonEmptyString`'s bare `.min(1)` would have let it through.
   */
  harness: z.string().trim().min(1).nullable().optional(),
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
 * cost figure — OTel's `cost_usd`, or (since #538) a sessionlog dialect whose
 * transcript reports its own authoritative cost per turn, named by `harness`
 * — no pricing table, no arithmetic of ours either way. `false` means we
 * estimated it from tokens, and the UI must say so. Claude's own sessionlog
 * dialect still carries no dollars at all (its transcript has none to
 * report), which is a fact about that one dialect, not about `sessionlog` as
 * a source.
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
  /**
   * Where the tool touched — repo-relative when the sessionlog's tool_use
   * block reported a path under the lane's worktree, else the raw path
   * exactly as reported. prd11 ruling 2: Edit/Write/Read and kin carry it
   * (their `input.file_path`); Bash and other non-file tools never guess and
   * stay null. Additive: absent on every `tool.activity` logged before prd11.
   */
  filePath: nonEmptyString.nullable().optional(),
  /**
   * The CLI's own `tool_use` id — the same id `trace.span.toolUseId` carries,
   * the join key that marries this causal chain to the OTel waterfall.
   * Additive, same as {@link filePath}.
   */
  toolUseId: nonEmptyString.nullable().optional(),
})
export type ToolActivityPayload = z.infer<typeof toolActivityPayloadSchema>

/**
 * Cumulative seconds Claude Code itself considers the agent "active" — OTel's
 * `claude_code.active_time.total` counter, exported on every metrics POST and
 * silently ignored until now (research note §"Live-dashboard gaps"). Only our
 * own OTLP receiver produces this, so `activeSeconds` is always the metric's
 * raw cumulative value, never a delta: a counter can reset to zero when a
 * session restarts, and folding that into a running total is a selector's job
 * (`selectors/activity.ts`), never this event's or the reducer's.
 */
export const activeTimePayloadSchema = z.object({
  ...attribution,
  role: agentRoleSchema,
  activeSeconds: z.number().nonnegative(),
})
export type ActiveTimePayload = z.infer<typeof activeTimePayloadSchema>

/**
 * A telemetry export this Rhizomorph refused: prd2's ruling is one repo, one
 * Rhizomorph, so a POST that does not carry our instance id is a
 * misconfiguration (two servers, a stale env block, another repo's exporter) —
 * surfaced as a setup gap, never silently merged into our numbers and never
 * silently dropped.
 *
 * Recorded at most once per offender per minute with a `count`, not once per
 * post: a misconfigured fleet exports every few seconds and must not be able to
 * flood the log with what is a single standing fault.
 */
export const telemetryRefusedPayloadSchema = z.object({
  /**
   * The instance id the export declared, or `null` when it declared none — the
   * "none" case a reader should render as such rather than as an empty string.
   */
  instance: nonEmptyString.nullable(),
  /** Our instance id: what the export should have carried. */
  expectedInstance: nonEmptyString,
  /**
   * Refusals from this offender since the last one we recorded, this one
   * included. Always ≥ 1; > 1 means the throttle swallowed the rest.
   */
  count: z.number().int().positive(),
})
export type TelemetryRefusedPayload = z.infer<typeof telemetryRefusedPayloadSchema>

export const llmUsageEventSchema = envelopeWithSources(
  TELEMETRY_SOURCES,
  'llm.usage',
  llmUsagePayloadSchema,
)
/**
 * Hand-built rather than via `envelopeWithSources`, for exactly the reason
 * `events/lab.ts`'s schemas are hand-built: that helper's `sources` generic is
 * bound to `EventSource`, and `'lab'` is deliberately not a member of it. The
 * shape below is identical to what `envelopeWithSources(LLM_COST_SOURCES,
 * 'llm.cost', llmCostPayloadSchema)` would have produced if the helper could
 * have taken the lab's literal.
 *
 * `EVENT_SOURCE_BY_TYPE`'s primary for this type stays `otel` and is untouched
 * (prd1: authority for dollars). The lab, like the non-primary collector,
 * names itself by passing `source` to `createEvent`.
 */
export const llmCostEventSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: z.enum(LLM_COST_SOURCES),
  type: z.literal('llm.cost'),
  payload: llmCostPayloadSchema,
})
export const toolActivityEventSchema = envelopeWithSources(
  TELEMETRY_SOURCES,
  'tool.activity',
  toolActivityPayloadSchema,
)

/** Only our own receiver can refuse a post, so this one has a single source. */
export const telemetryRefusedEventSchema = envelope(
  'otel',
  'telemetry.refused',
  telemetryRefusedPayloadSchema,
)

/** Only our own OTLP receiver produces this metric, so this one has a single source too. */
export const agentActiveTimeEventSchema = envelope('otel', 'agent.activeTime', activeTimePayloadSchema)

export const telemetryEventSchemas = [
  llmUsageEventSchema,
  llmCostEventSchema,
  toolActivityEventSchema,
  telemetryRefusedEventSchema,
  agentActiveTimeEventSchema,
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
