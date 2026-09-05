import { z } from 'zod'
import { envelope, envelopeWithSources, nonEmptyString } from './common.js'

/** workmux-sourced events. Optional source: absent binary just disables it. */

export const agentStatusSchema = z.enum(['working', 'waiting', 'done'])
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
