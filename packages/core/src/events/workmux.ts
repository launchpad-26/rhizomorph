import { z } from 'zod'
import { envelope, envelopeWithSources, nonEmptyString } from './common.js'

/** workmux-sourced events. Optional source: absent binary just disables it. */

/**
 * The words an `agent.status` may carry — seven since prd-57 ruling 5, three
 * before it.
 *
 * ## Why it widened, and what it is NOT
 *
 * `collectors/sessionlog/lane-state.ts` derives four states internally
 * (`working`, `waiting`, `frozen`, `gone`) and publishes only two of them. Its
 * own comment gives the reason: for a lane whose process died, the only word
 * this enum offered was `done`, and *"publishing `done` for a lane whose
 * process died would convert a crash into a success"*. So the organ went silent
 * in exactly the case the instrument exists for, because it lacked a word.
 *
 * The four additions are that word and the three a harness's own lifecycle hook
 * can declare. They are ADDITIVE: every existing literal keeps its meaning, no
 * reducer arm changes, and an old recording folds to exactly what it always
 * folded to (ADR-0011).
 *
 * **This is the event vocabulary, not the fleet's.** `LaneActivity` in
 * `fleet/types.ts` is a different and deliberately smaller set. Three of these
 * words map onto it (`plumbing.ts`'s `activityOf`); `crashed` does not, and
 * prd-57's 2026-09-15 amendment rules that it becomes a `PathologyKind` rather
 * than a sixth activity — a crash is a thing wrong with a lane, which is what a
 * pathology already is.
 */
export const agentStatusSchema = z.enum([
  'working',
  'waiting',
  'done',
  /** Inside a tool call: `PreToolUse` without its `PostToolUse`. */
  'tool-running',
  /** **Needs you.** A `Notification` carrying a permission request. */
  'waiting-permission',
  /** The session ended on purpose: `SessionEnd`. Distinct from `done`, which is a claim about work. */
  'stopped',
  /**
   * Gone without saying so — a `process.gone` following a `process.seen` with
   * no session end between, and reachable from that pair alone. Never from
   * silence: silence is what `frozen` is for, and a lane that has merely stopped
   * speaking is alive until a witness says otherwise.
   */
  'crashed',
])
export type AgentStatus = z.infer<typeof agentStatusSchema>

export const agentStatusPayloadSchema = z.object({
  /** workmux's handle for the agent — its window/worktree name. */
  handle: nonEmptyString,
  status: agentStatusSchema,
  worktreePath: nonEmptyString.nullable().optional(),
  branch: nonEmptyString.nullable().optional(),
  elapsedSeconds: z.number().int().nonnegative().nullable().optional(),
  detail: z.string().optional(),
})
export type AgentStatusPayload = z.infer<typeof agentStatusPayloadSchema>

/**
 * Who may sign an `agent.status` (ADR-0037, prd-27 ruling 2). `workmux` is the
 * primary — the L4 declaration (`EVENT_SOURCE_BY_TYPE`) — and `sessionlog` is
 * the transcript organ inferring a transition from turn shape. The envelope's
 * `source` is the witness; a reader that needs to know whether a WAITING was
 * declared or inferred reads it there and nowhere else.
 */
export const AGENT_STATUS_SOURCES = ['workmux', 'sessionlog'] as const

export const agentStatusEventSchema = envelopeWithSources(AGENT_STATUS_SOURCES, 'agent.status', agentStatusPayloadSchema)
/** `'workmux' | 'sessionlog'` — the envelope's own source type for this event. */
export type AgentStatusWitness = z.infer<typeof agentStatusEventSchema>['source']

export const agentRemovedPayloadSchema = z.object({
  /** workmux's handle for the agent that no longer appears in `workmux status`. */
  handle: nonEmptyString,
})
export type AgentRemovedPayload = z.infer<typeof agentRemovedPayloadSchema>

export const agentRemovedEventSchema = envelope('workmux', 'agent.removed', agentRemovedPayloadSchema)

export const workmuxEventSchemas = [agentStatusEventSchema, agentRemovedEventSchema] as const
