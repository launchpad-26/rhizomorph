import { z } from 'zod'
import { envelope, nonEmptyString } from './common.js'

/** ADR-0036: the v1 line is deliberately small and versioned at its writer. */
export const BEACON_LINE_VERSION = 1

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
