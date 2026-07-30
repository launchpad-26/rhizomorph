import { createHash } from 'node:crypto'
import { agentRoleSchema, UNATTRIBUTED_LANE, type AgentRole } from '@observatory/core'
import { attrString, type OtlpKeyValue } from './types.js'

/**
 * OTel carries no cwd/branch (research §S1's documented gap), so lane and role
 * come entirely from resource/datapoint attributes — `OTEL_RESOURCE_ATTRIBUTES`
 * at dispatch, or the fallbacks below when a lane didn't set one.
 */

/** Eight hex chars is enough to tell sessions apart in a lane column, not to identify anyone. */
export function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}

/**
 * `lane` resource attribute, else a short-hash of the datapoint's `session.id`,
 * else the shared "we don't know" lane — never dropped, per `UNATTRIBUTED_LANE`.
 */
export function resolveLane(
  resourceAttrs: OtlpKeyValue[] | undefined,
  dataPointAttrs: OtlpKeyValue[] | undefined,
): string {
  const lane = attrString(resourceAttrs, 'lane')
  if (lane) return lane

  const sessionId = attrString(dataPointAttrs, 'session.id')
  if (sessionId) return shortHash(sessionId)

  return UNATTRIBUTED_LANE
}

/**
 * Resource `role` wins outright when it's a real role; otherwise a
 * conductor-lane infers itself, then `query_source: auxiliary` maps to the
 * auxiliary role, and anything left over is an ordinary worker.
 */
export function resolveRole(
  resourceAttrs: OtlpKeyValue[] | undefined,
  lane: string,
  querySource: string | undefined,
): AgentRole {
  const declared = attrString(resourceAttrs, 'role')
  if (declared) {
    const parsed = agentRoleSchema.safeParse(declared)
    if (parsed.success) return parsed.data
  }

  if (lane === 'conductor') return 'conductor'
  if (querySource === 'auxiliary') return 'auxiliary'
  return 'worker'
}
