import { createHash } from 'node:crypto'
import { agentRoleSchema, UNATTRIBUTED_LANE, type AgentRole } from '@rhizomorph/core'
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
 * `lane` resource attribute, else the shared "we don't know" lane — never a
 * hash of the datapoint's `session.id`. A hash-of-session-id fallback mints a
 * new lane every restart (the session id changes; the hash follows it), so
 * an untagged agent must land on the one stable `UNATTRIBUTED_LANE` bucket
 * instead, even across restarts. `dataPointAttrs` is accepted for call-site
 * symmetry with `resolveRole` but is no longer consulted.
 */
export function resolveLane(
  resourceAttrs: OtlpKeyValue[] | undefined,
  dataPointAttrs: OtlpKeyValue[] | undefined,
): string {
  const lane = attrString(resourceAttrs, 'lane')
  if (lane) return lane

  return UNATTRIBUTED_LANE
}

/**
 * Resource `role` wins outright when it's a real role; otherwise
 * `query_source: auxiliary` maps to the auxiliary role, and anything left
 * over is an ordinary worker. Role is never inferred from the lane string —
 * a lane literally named `conductor` is not evidence of anything; only the
 * declared `role` resource attribute is. `rhizomorph env` emits `role` for
 * every lane we launch, so post-#60 every accepted post already carries it —
 * the `worker` default below is a backstop for a post that skipped that
 * block, not a channel anyone should rely on for real attribution.
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

  if (querySource === 'auxiliary') return 'auxiliary'
  return 'worker'
}
