import { z } from 'zod'

/**
 * Shared primitives for the event envelope.
 *
 * Every fact the Rhizomorph knows arrives as one event on one append-only
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
  // `sessionlog` names a KIND of collector — one that tails an agent CLI's
  // own transcript file — not one specific CLI; #538 adds `harness` to
  // telemetry.ts's shared attribution so a dialect other than Claude Code's
  // can name itself without widening this enum per harness.
  'sessionlog',
  'otel',
  // prd-27 wave 1 (#217), landing prd17 ruling 2's door: a collector that
  // tails one rhizomorph-owned directory of one-line JSON beacons
  // (ADR-0036, collectors/beacon/). It runs behind the poll loop and reports
  // what it saw, so it is a collector in exactly the sense this enum has
  // always meant — which is why it joins outright where `lab` and `judge`
  // deliberately do not.
  'beacon',
  // prd17 ruling 1: the landing gate and the dispatch tooling around it —
  // events/gate.ts's three families and the summons pair. Collector-shaped in
  // the sense this enum has always meant: something that watches the swarm and
  // reports what it saw, the way `git`, `tmux` and `workmux` do.
  'gate',
  // prd17 ruling 1: the operator's own hand — events/operator.ts.
  //
  // **This member widens what the enum MEANS, and saying so is the point.**
  // The doc above and `index.ts`'s `source` comment both describe it as "which
  // collector saw it", and `lab.ts` cites exactly that wording as its reason
  // for staying OUT: the lab is explicitly invoked and "never runs unattended
  // behind a poll loop the way a collector does" (prd12 ruling 1). The operator
  // has that same disqualifying property. So this is not a case of `lab` being
  // wrong, and it is NOT the reason `judge` is absent either — `judge.ts` gives
  // its own, narrower one (prd11 ruling 6b, phase 1).
  //
  // What changed is the enum: prd17 ruling 1 puts the operator's decisions in
  // the record as first-class events, and an event has to name the actor that
  // produced it. The enum is therefore an ACTOR union that happens to be mostly
  // collectors, rather than a collector roster. A later lane wanting to fold
  // `lab` in on this precedent should reopen prd12 ruling 1 deliberately, not
  // read this comment as having already done it.
  'operator',
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
