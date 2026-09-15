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

/**
 * The ceiling on a `Notification`'s `message`, applied by the WRITER before the
 * line is formed — not here.
 *
 * A schema maximum rejects; ADR-0036 says extra content is kept in the file and
 * covered by the digest, so a line that overran would be a line the collector
 * dropped rather than a line trimmed. The runner truncates, the schema states
 * the bound it truncates to, and the two agreeing is what `rhizomorph hook`'s
 * own law asserts.
 */
export const BEACON_MESSAGE_MAX = 512

export const beaconReceivedPayloadSchema = z.object({
  writer: nonEmptyString.max(64),
  kind: nonEmptyString.max(64),
  lane: nonEmptyString.max(256).nullable(),
  detail: z.string().max(512).optional(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  file: nonEmptyString,
  offset: z.number().int().nonnegative(),

  // ── the hook join keys (prd-57 ruling 3) ──────────────────────────────────
  //
  // All four OPTIONAL, and that is not politeness: every beacon writer that
  // existed before prd-57 — the gate, the swarm scripts — supplies none of
  // them, and ADR-0011 means an old recording must fold to exactly what it
  // always folded to. A required key here would retire every line already on
  // disk.
  //
  // What they buy: one hook line joins process -> session -> transcript ->
  // worktree in a single fact, which is ruling 3's DECLARED join. Without them
  // the same join is inferred from an equal cwd and a start-time window, and
  // the actor says which it got. That difference is what ruling 3's rendering
  // law then refuses to let a surface blur.
  sessionId: nonEmptyString.max(256).optional(),
  transcriptPath: nonEmptyString.max(4096).optional(),
  /**
   * CANONICAL when present, and the writer is what makes it so.
   *
   * `canonicalize` lives in `packages/server/src/paths/containment.ts` and
   * imports `node:fs`, which ADR-0003 keeps out of this package — so core can
   * COMPARE this value but can never normalise it. The collector routing these
   * lines is the last place that can, and prd-57 ruling 3 puts the obligation
   * there rather than leaving it to whoever reads the field.
   */
  cwd: nonEmptyString.max(4096).optional(),
  /**
   * The pid of the process that fired the hook, as the runner observed it.
   * Never used to reach that process — ADR-0052 forbids the observer any
   * signal — only to join it to an actor the process witness already saw.
   */
  pid: z.number().int().positive().optional(),
  /**
   * `Notification` only: the short text of a permission prompt, truncated to
   * {@link BEACON_MESSAGE_MAX} by the WRITER before the line is formed.
   *
   * This is the single field in this schema that carries words an agent
   * produced, and it is bounded rather than free. prd-57's non-goals refuse a
   * words plane outright: never `tool_input`, never prompt text, never
   * completion text. A permission prompt's own short sentence is admitted
   * because it is the one thing a human needs in order to answer the thing
   * they are being asked.
   */
  message: z.string().max(BEACON_MESSAGE_MAX).optional(),
})
export type BeaconReceivedPayload = z.infer<typeof beaconReceivedPayloadSchema>

/** The writer's timestamp becomes the envelope timestamp. */
export const beaconReceivedEventSchema = envelope('beacon', 'beacon.received', beaconReceivedPayloadSchema)
export const beaconEventSchemas = [beaconReceivedEventSchema] as const
