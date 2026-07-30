import { z } from 'zod'

/**
 * Shared primitives for the event envelope.
 *
 * Every fact the Observatory knows arrives as one event on one append-only
 * log: `{ id, ts, source, type, payload }`. Envelopes are validated at the
 * collector boundary (and again when a JSONL line is read back), so a bad
 * parser is loud instead of silent.
 */

export const eventSourceSchema = z.enum([
  'git',
  'tmux',
  'workmux',
  'system',
  // prd1's two telemetry collectors: sessionlog is depth, otel is authority.
  'sessionlog',
  'otel',
])
export type EventSource = z.infer<typeof eventSourceSchema>

/** Epoch milliseconds. Chosen over ISO strings so liveness maths is subtraction. */
export const timestampSchema = z.number().int().nonnegative()

export const nonEmptyString = z.string().min(1)

/** git's file-change vocabulary, normalised away from single-letter codes. */
export const fileStatusSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'typechange',
  'unmerged',
])
export type FileStatus = z.infer<typeof fileStatusSchema>

/** One file inside a landed commit. */
export const fileChangeSchema = z.object({
  path: nonEmptyString,
  status: fileStatusSchema,
  previousPath: nonEmptyString.optional(),
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
})
export type FileChange = z.infer<typeof fileChangeSchema>

/** One uncommitted file in a worktree — the early-warning half of collisions. */
export const dirtyFileSchema = z.object({
  path: nonEmptyString,
  status: fileStatusSchema,
  staged: z.boolean().optional(),
})
export type DirtyFile = z.infer<typeof dirtyFileSchema>

export const authorSchema = z.object({
  name: nonEmptyString,
  email: z.string().optional(),
})
export type Author = z.infer<typeof authorSchema>

/**
 * Wraps a payload schema in the standard envelope. `source` and `type` stay
 * literals so the whole event union discriminates on `type`.
 */
export function envelope<
  const S extends EventSource,
  const T extends string,
  P extends z.ZodType,
>(source: S, type: T, payload: P) {
  return z.object({
    id: nonEmptyString,
    ts: timestampSchema,
    source: z.literal(source),
    type: z.literal(type),
    payload,
  })
}

/**
 * Like {@link envelope}, but for a type that more than one collector can
 * legitimately produce. prd1's `sessionlog` and `otel` collectors both report
 * token usage; the envelope's `source` stays the honest record of which one
 * saw it, so nothing has to be duplicated into the payload. The union still
 * discriminates on `type`, which is unaffected.
 */
export function envelopeWithSources<
  const S extends readonly [EventSource, ...EventSource[]],
  const T extends string,
  P extends z.ZodType,
>(sources: S, type: T, payload: P) {
  return z.object({
    id: nonEmptyString,
    ts: timestampSchema,
    source: z.enum(sources),
    type: z.literal(type),
    payload,
  })
}
