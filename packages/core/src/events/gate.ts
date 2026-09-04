import { z } from 'zod'
import { envelope, nonEmptyString } from './common.js'

/**
 * prd17 ruling 1 — the instrument's own judgements: the landing gate's
 * verdict, the brief a lane was dispatched with, and the boundary a lane
 * declared before either ran. All three are additive contracts only; nothing
 * here emits them yet (later work).
 *
 * `source: 'gate'` is a new member of `eventSourceSchema` (`common.ts`) rather
 * than a hand-built literal outside it, the way `lab` and `judge` are in their
 * own files. The instrument these events describe — the landing gate and the
 * dispatch tooling around it — is exactly what the enum already means:
 * something that watches the swarm and reports what it saw, the same shape
 * `git`, `tmux` and `workmux` already are. `lab` is out of the enum for a
 * reason that does not apply here and is not fence reach — see `lab.ts`, and
 * `common.ts`'s note beside the `operator` member.
 */

/** A sha256 hex digest — the same shape `lab.ts`'s `sessionDigest` already uses for the same reason: content lives beside the record, never inside it. */
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest')

/**
 * The landing gate's decision on one lane. Sidecar-for-content (issue DoD):
 * `digest` is a fingerprint of the gate's full output, never the output
 * itself — the log says a verdict happened and what it was, not what
 * `scripts/gate.sh` printed while reaching it.
 */
export const gateVerdictPayloadSchema = z.object({
  /** The lane or PR handle the gate judged. */
  handle: nonEmptyString,
  /** Whether the gate held (blocked landing) or released the lane. */
  held: z.boolean(),
  /** Short category for the verdict, e.g. `'suite-red'`, `'fence-violation'`, `'clean'`. */
  reason: nonEmptyString,
  /** sha256 hex digest of the gate's full output. */
  digest: sha256Hex,
  /**
   * How many load batches the gate ran, when it ran any — `scripts/gate.sh`'s
   * third argument. Named by prd-17 ruling 1 ("load-batch tallies") and added
   * after review found it absent (operator ruling, 2026-09-04): it is a short
   * scalar, so the sidecar-for-content split never justified dropping it, and
   * zod strips undeclared keys, so a later emitter could not have supplied it
   * without changing a shipped contract. Optional because a gate run on a
   * branch that touched no tests legitimately has none.
   */
  loadBatches: z.number().int().nonnegative().optional(),
})
export type GateVerdictPayload = z.infer<typeof gateVerdictPayloadSchema>

/**
 * A lane's dispatch brief, occurred rather than quoted. Same sidecar split as
 * the verdict above: the brief's prose is the operator's own words and can be
 * long and freely edited, so the event says a brief existed and lets a digest
 * prove which version, never carrying the text itself.
 */
export const dispatchBriefPayloadSchema = z.object({
  /** The lane the brief was written for. */
  handle: nonEmptyString,
  /** The issue this brief dispatches, when it closes one. */
  issue: z.number().int().positive().optional(),
  /** sha256 hex digest of the brief's full text. */
  digest: sha256Hex,
  /**
   * The model the lane was dispatched on. Named by prd-17 ruling 1 ("model at
   * dispatch") and added after review found it absent (operator ruling,
   * 2026-09-04). The clearest case of the pair: a digest of the brief's text
   * cannot recover it, and it is a scalar, so no sidecar argument reaches it.
   * Optional because a dispatch without a declared model is a real state.
   */
  model: nonEmptyString.optional(),
})
export type DispatchBriefPayload = z.infer<typeof dispatchBriefPayloadSchema>

/**
 * The declared boundary itself — NOT sidecar'd, unlike the two above. This is
 * the one place the issue's own "Why" names directly: "a trespass can never be
 * re-derived" without the actual paths on the record, so the fence's declared
 * paths are the event's content, not a digest of them.
 */
export const fenceDeclaredPayloadSchema = z.object({
  /** The lane or issue this fence binds. */
  handle: nonEmptyString,
  /** The declared fence: paths the lane may touch. */
  paths: z.array(nonEmptyString).min(1),
})
export type FenceDeclaredPayload = z.infer<typeof fenceDeclaredPayloadSchema>

export const gateVerdictEventSchema = envelope('gate', 'gate.verdict', gateVerdictPayloadSchema)
export const dispatchBriefEventSchema = envelope('gate', 'dispatch.brief', dispatchBriefPayloadSchema)
export const fenceDeclaredEventSchema = envelope('gate', 'fence.declared', fenceDeclaredPayloadSchema)

export const gateEventSchemas = [
  gateVerdictEventSchema,
  dispatchBriefEventSchema,
  fenceDeclaredEventSchema,
] as const
