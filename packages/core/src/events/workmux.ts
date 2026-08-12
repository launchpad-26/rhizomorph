import { z } from 'zod'
import { envelope, nonEmptyString } from './common.js'

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

export const agentStatusEventSchema = envelope('workmux', 'agent.status', agentStatusPayloadSchema)

export const agentRemovedPayloadSchema = z.object({
  /** workmux's handle for the agent that no longer appears in `workmux status`. */
  handle: nonEmptyString,
})
export type AgentRemovedPayload = z.infer<typeof agentRemovedPayloadSchema>

export const agentRemovedEventSchema = envelope('workmux', 'agent.removed', agentRemovedPayloadSchema)

export const workmuxEventSchemas = [agentStatusEventSchema, agentRemovedEventSchema] as const
