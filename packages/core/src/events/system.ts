import { z } from 'zod'
import { envelope, nonEmptyString } from './common.js'

/** system-sourced events: the session itself, and collectors misbehaving. */

export const sessionStartedPayloadSchema = z.object({
  sessionId: nonEmptyString,
  repoPath: nonEmptyString,
  repoName: nonEmptyString,
  /** Branch everything is measured against. Falls back to the main worktree's branch. */
  mainBranch: nonEmptyString.nullable().optional(),
})
export type SessionStartedPayload = z.infer<typeof sessionStartedPayloadSchema>

/**
 * Why a session log ended. prd16 ruling 2 gives the recorder exactly one way
 * to end one — the operator's explicit rotation — so that is the only member
 * today; prd17 ruling 1 may widen this enum additively (a widened enum still
 * parses every log written before it).
 */
export const SESSION_CLOSE_REASONS = ['rotated'] as const
export type SessionCloseReason = (typeof SESSION_CLOSE_REASONS)[number]

/**
 * prd17 ruling 1: "a session's end is an event, not an absence". The last line
 * of a closed log, appended before the file is fsynced and the recorder moves
 * on — so a reader can tell a session the operator ended from one whose writer
 * was killed mid-run (which leaves no such line), without consulting anything
 * beside the log.
 *
 * `sessionId` is the closed session's own id, not the one that follows it: this
 * event belongs to the log it terminates.
 */
export const sessionClosedPayloadSchema = z.object({
  sessionId: nonEmptyString,
  reason: z.enum(SESSION_CLOSE_REASONS),
  /** How many events the closed log holds, counting this one. Optional so a third-party emitter that doesn't count can still close a session honestly. */
  eventCount: z.number().int().positive().optional(),
})
export type SessionClosedPayload = z.infer<typeof sessionClosedPayloadSchema>

export const collectorErrorPayloadSchema = z.object({
  collector: nonEmptyString,
  message: z.string(),
  detail: z.string().optional(),
})
export type CollectorErrorPayload = z.infer<typeof collectorErrorPayloadSchema>

/**
 * Emitted once a collector's consecutive-failure count crosses the resilience
 * policy's disable threshold (see `withResilience` in the server package).
 * `consecutiveFailures` is optional so a collector emitting this directly
 * (bypassing the shared policy) stays valid — every wrapped collector fills it.
 */
export const collectorDisabledPayloadSchema = z.object({
  collector: nonEmptyString,
  reason: z.string(),
  consecutiveFailures: z.number().int().positive().optional(),
})
export type CollectorDisabledPayload = z.infer<typeof collectorDisabledPayloadSchema>

/**
 * Emitted for a poll that failed but hasn't yet reached the disable
 * threshold — the collector is still trying, just degraded. Distinct from
 * `collector.error` (a one-off gripe about a single row or command that
 * doesn't affect the collector's overall health) so the retry/backoff policy
 * has a fact of its own to track and clear.
 */
export const collectorDegradedPayloadSchema = z.object({
  collector: nonEmptyString,
  reason: z.string(),
  consecutiveFailures: z.number().int().positive(),
})
export type CollectorDegradedPayload = z.infer<typeof collectorDegradedPayloadSchema>

/**
 * Emitted the first time a degraded or disabled collector polls
 * successfully again — the fact that lets the provenance bar and gap
 * registry clear themselves without a restart.
 */
export const collectorRecoveredPayloadSchema = z.object({
  collector: nonEmptyString,
  /** Consecutive failures survived before this recovery; 0 if none. */
  consecutiveFailures: z.number().int().nonnegative(),
})
export type CollectorRecoveredPayload = z.infer<typeof collectorRecoveredPayloadSchema>

export const sessionStartedEventSchema = envelope(
  'system',
  'session.started',
  sessionStartedPayloadSchema,
)
export const sessionClosedEventSchema = envelope(
  'system',
  'session.closed',
  sessionClosedPayloadSchema,
)
export const collectorErrorEventSchema = envelope(
  'system',
  'collector.error',
  collectorErrorPayloadSchema,
)
export const collectorDisabledEventSchema = envelope(
  'system',
  'collector.disabled',
  collectorDisabledPayloadSchema,
)
export const collectorDegradedEventSchema = envelope(
  'system',
  'collector.degraded',
  collectorDegradedPayloadSchema,
)
export const collectorRecoveredEventSchema = envelope(
  'system',
  'collector.recovered',
  collectorRecoveredPayloadSchema,
)

export const systemEventSchemas = [
  sessionStartedEventSchema,
  sessionClosedEventSchema,
  collectorErrorEventSchema,
  collectorDisabledEventSchema,
  collectorDegradedEventSchema,
  collectorRecoveredEventSchema,
] as const
