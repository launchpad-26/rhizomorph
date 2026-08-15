import { z } from 'zod'
import { envelope, nonEmptyString } from './common.js'

/** system-sourced events: the session itself, and collectors misbehaving. */

/**
 * THE RUN POINTER (#384) — the seam between two logs that are one run.
 *
 * A rotation's successor is the next log in the SAME directory, so a reader
 * has always been able to find it by looking there. prd20 ruling 5's retarget
 * breaks that inference outright: the session directory is derived from the
 * watched repo (`sessionDirFor(repoPath)` = `<dataRoot>/<repoSlug>`,
 * `server/src/log/paths.ts`), so a retargeted run's successor is under a
 * DIFFERENT slug in a DIFFERENT directory, and nothing in either file said so
 * — one operator intent, two logs, no way to tell they were ever related.
 *
 * The slug, not a path. `repoSlug` is already the portable record's join key
 * (`record/schema.ts`, `docs/record-format.md`), and the slug IS the
 * directory's name under the data root — so a reader holding the log already
 * knows how to resolve it, while an absolute path would bake in one machine's
 * data root. A record moves from one machine to another (ADR-0009, and
 * `docs/record-format.md`'s own "Nothing auto-transmits"), so a pointer only
 * the writing machine can resolve is a pointer that arrives broken.
 *
 * `sessionId` is optional because the close half genuinely cannot know it:
 * rotation's ordering law is close-then-open (`recorder/rotate.ts`), and the
 * successor's id is minted off the clock only after the close has landed. So
 * a `session.closed` names the directory its run continued in and stops
 * there, while the `session.started` on the other side — which knows both —
 * names the predecessor exactly. A reader that wants the closed side of a
 * seam should follow the successor's pointer back, not the other way.
 */
export const sessionLinkSchema = z.object({
  /** The other log's repo slug, which is also the name of its directory under the data root. */
  repoSlug: nonEmptyString,
  /** The other log's session id, when the emitter can know it — see above. */
  sessionId: nonEmptyString.optional(),
})
export type SessionLink = z.infer<typeof sessionLinkSchema>

export const sessionStartedPayloadSchema = z.object({
  sessionId: nonEmptyString,
  repoPath: nonEmptyString,
  repoName: nonEmptyString,
  /** Branch everything is measured against. Falls back to the main worktree's branch. */
  mainBranch: nonEmptyString.nullable().optional(),
  /**
   * Where this run came from, when this session continues one that ended
   * somewhere else — see {@link sessionLinkSchema}. Optional and absent for
   * every ordinary boot: a session that started on its own has no
   * predecessor, and saying so with a field would be inventing a seam.
   */
  predecessor: sessionLinkSchema.optional(),
})
export type SessionStartedPayload = z.infer<typeof sessionStartedPayloadSchema>

/**
 * Why a session log ended. prd16 ruling 2 gave the recorder exactly one way
 * to end one — the operator's explicit rotation — and prd17 ruling 1 reserved
 * the right to widen this enum additively (a widened enum still parses every
 * log written before it, which is the whole reason it widens rather than
 * changes).
 *
 * `retargeted` is that widening, and it is prd20 ruling 5's: switching the
 * watched repo ends the session too, but it is not a rotation and must never
 * be recorded as one. Operator-decided 2026-08-10, at Q2 of
 * `docs/research/2026-08-10-retarget-spike.md`; #384 implements it. The
 * difference a reader depends on is where the successor lives — a rotation's
 * is the next log in this same directory, a retarget's is under another slug
 * entirely, which is why the reason arrives together with
 * {@link sessionLinkSchema}.
 *
 * The recorder that emits it is #385's `retargetSession`; nothing writes this
 * member yet. It is declared first, on purpose, so the vocabulary lands in
 * one additive change a reader can date, rather than inside the machinery.
 */
export const SESSION_CLOSE_REASONS = ['rotated', 'retargeted'] as const
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
  /**
   * Where this run continued, when it continued somewhere this directory
   * cannot imply — see {@link sessionLinkSchema}. Optional and absent for an
   * ordinary rotation, whose successor is the next log right here, and for a
   * close that ends the run outright.
   */
  successor: sessionLinkSchema.optional(),
})
export type SessionClosedPayload = z.infer<typeof sessionClosedPayloadSchema>

export const collectorErrorPayloadSchema = z.object({
  collector: nonEmptyString,
  message: z.string(),
  detail: z.string().optional(),
  /**
   * Occurrences of this same fault since the last one recorded, this one
   * included, for a collector that coalesces repeats rather than recording
   * one event per occurrence (see `telemetry.refused`'s `count` for the
   * precedent). Optional: most `collector.error` emitters record one event
   * per fault and never coalesce, so they carry no count at all.
   */
  count: z.number().int().positive().optional(),
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
