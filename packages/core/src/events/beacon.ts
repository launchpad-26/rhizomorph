import { z } from 'zod'
import { envelope, nonEmptyString } from './common.js'

/** ADR-0036: the v1 line is deliberately small and versioned at its writer. */
export const BEACON_LINE_VERSION = 1

/**
 * prd-27 ruling 4's three words — the attention vocabulary a declaring hook
 * speaks. ADR-0036 left `kind` free-form on purpose and named this wave (#282)
 * as the vocabulary's owner. `waiting`: the harness has stopped for a human.
 * `working`: the harness is acting on a prompt or a tool result. `stopped`:
 * the harness finished its turn and is idle with nothing asked of anyone.
 *
 * The schema stays open: a kind outside this list is carried, never dropped
 * (ADR-0011). This constant is for writers to import and for folds to compare
 * against — never for the parser to refuse by.
 */
export const BEACON_ATTENTION_KINDS = ['waiting', 'working', 'stopped'] as const
export type BeaconAttentionKind = (typeof BEACON_ATTENTION_KINDS)[number]

export const beaconReceivedPayloadSchema = z.object({
  writer: nonEmptyString.max(64),
  kind: nonEmptyString.max(64),
  lane: nonEmptyString.max(256).nullable(),
  detail: z.string().max(512).optional(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  file: nonEmptyString,
  offset: z.number().int().nonnegative(),
})
export type BeaconReceivedPayload = z.infer<typeof beaconReceivedPayloadSchema>

/** The writer's timestamp becomes the envelope timestamp. */
export const beaconReceivedEventSchema = envelope('beacon', 'beacon.received', beaconReceivedPayloadSchema)
export const beaconEventSchemas = [beaconReceivedEventSchema] as const
