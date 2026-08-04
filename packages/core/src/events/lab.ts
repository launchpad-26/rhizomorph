import { z } from 'zod'
import { nonEmptyString, timestampSchema } from './common.js'

/**
 * prd12 ruling 1 — the read-only amendment's two hands. The observer
 * (collectors: git, tmux, workmux, system, sessionlog, otel) stays read-only
 * absolutely and forever, and its source vocabulary lives in
 * `eventSourceSchema` (common.ts) undisturbed. The laboratory is the second,
 * explicitly-invoked hand — a fork engine, never a collector — and this
 * module is its one event type.
 *
 * `source: 'lab'` is deliberately NOT added to `eventSourceSchema`: that enum
 * documents "which collector saw it", and the lab never runs unattended
 * behind a poll loop the way a collector does. Keeping it out is itself part
 * of the amendment's honesty — a reader of `common.ts` should not be able to
 * mistake the lab for a seventh collector.
 *
 * Two event types live here now: `fork.checkpoint` (phase 1, #148 — the
 * capture) and `fork.dispatched` (phase 2, #153 — the launch).
 */

/** Who triggered the capture. `dispatch`/`gate` are conduct-tooling hooks that land later; `operator` is the explicit CLI invocation this keystone ships. */
export const forkCheckpointCapturedBySchema = z.enum(['dispatch', 'gate', 'operator'])
export type ForkCheckpointCapturedBy = z.infer<typeof forkCheckpointCapturedBySchema>

/**
 * Additive keystone event (prd12 ruling 2): binds, at capture time, the
 * rhizomorph event log's own index to a Claude Code session-file byte offset
 * and a git workspace snapshot — the three coordinates a fork needs to scrub
 * to T and resume. Never synthesized after the fact (the spike's keystone
 * finding): a checkpoint event only ever describes a capture that just ran.
 */
export const forkCheckpointPayloadSchema = z.object({
  lane: nonEmptyString,
  checkpointId: nonEmptyString,
  /** The rhizomorph event log's own length at capture — the index this event lands at. */
  eventIndex: z.number().int().nonnegative(),
  /** Absolute path to the lane's Claude Code session JSONL, native on disk — referenced, never copied (spike Q3). */
  sessionFile: nonEmptyString,
  /** Byte offset into `sessionFile` at capture time — a fork cuts the file here. */
  sessionCutByte: z.number().int().nonnegative(),
  /** sha256 hex digest of `sessionFile`'s first `sessionCutByte` bytes. */
  sessionDigest: z.string().regex(/^[0-9a-f]{64}$/, 'sessionDigest must be a sha256 hex digest'),
  /** The namespaced ref the snapshot commit lives under — ruling 1's write fence, enforced at the schema too. */
  snapshotRef: z
    .string()
    .regex(/^refs\/rhizomorph\/checkpoints\/.+$/, 'snapshotRef must be under refs/rhizomorph/checkpoints/'),
  /** The synthetic commit-tree object the temp-index recipe produced (working tree untouched to make it). */
  snapshotSha: nonEmptyString,
  /** HEAD at capture time — the snapshot commit's parent. */
  headSha: nonEmptyString,
  capturedBy: forkCheckpointCapturedBySchema,
})
export type ForkCheckpointPayload = z.infer<typeof forkCheckpointPayloadSchema>

/**
 * Hand-built rather than via `envelope()`: that helper's `source` generic is
 * bound to `EventSource` (`common.ts`), and `'lab'` is deliberately not a
 * member of it (see the module doc above). The shape below is identical to
 * what `envelope('lab', 'fork.checkpoint', forkCheckpointPayloadSchema)`
 * would have produced.
 */
export const forkCheckpointEventSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: z.literal('lab'),
  type: z.literal('fork.checkpoint'),
  payload: forkCheckpointPayloadSchema,
})

/** A sha256 hex digest — the same shape `sessionDigest` above requires. */
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest')

/**
 * What was VARIED for one arm — prd12 ruling 4's "treatment". Both fields are
 * nullable because an arm may vary neither (the control arm: same model, same
 * prompt as the parent lane would have run).
 *
 * The prompt is carried as a digest, never as text: a prompt file can be
 * long, can be edited after the fact, and belongs to the operator — the log
 * needs to say "these two arms ran the same prompt" and "this arm's prompt
 * differed", which a digest answers exactly, without copying the operator's
 * words into an artifact they may later hand to someone else.
 */
export const forkTreatmentSchema = z.object({
  /** Model handle the arm's agent runs, as passed to the agent CLI. Null when the arm inherits the fleet default. */
  model: nonEmptyString.nullable(),
  /** sha256 of the prompt file's bytes. Null when the arm was dispatched without one. */
  promptDigest: sha256Hex.nullable(),
})
export type ForkTreatment = z.infer<typeof forkTreatmentSchema>

/**
 * Additive phase-2 event (prd12 ruling 3): one per ARM, emitted at the moment
 * the lab hands that arm to the existing workmux machinery. Its existence is
 * what marks a lane synthetic — there is no separate "please mark me" flag to
 * forget, and no way for a lane to be a fork without the log saying so. The
 * reducer reads exactly this to set `synthetic: true`.
 *
 * `worktreePath` is here beyond the fields prd12 names because a comparison
 * surface must be able to go BACK to the arm it is reporting on — run its
 * gate command, count its commits — and re-deriving that path from a naming
 * convention would silently break the day the convention moves. The log says
 * where the arm lives, so nothing downstream has to guess.
 */
export const forkDispatchedPayloadSchema = z
  .object({
    /** Groups the arms of one fork. Every arm of a dispatch shares it. */
    forkId: nonEmptyString,
    /** The lane that was forked — the real one, whose checkpoint this arm resumes from. */
    parentLane: nonEmptyString,
    /** The `fork.checkpoint` this arm was restored from. */
    checkpointId: nonEmptyString,
    /** 1-based arm number within the fork. */
    arm: z.number().int().positive(),
    treatment: forkTreatmentSchema,
    /** The synthetic lane handle this arm runs under — what the observer will see it as. */
    laneHandle: nonEmptyString,
    /** Absolute path of the restored worktree the arm runs in. */
    worktreePath: nonEmptyString,
  })
  .refine((p) => p.laneHandle !== p.parentLane, {
    message: 'laneHandle must differ from parentLane — an arm may never claim the lane it forked',
    path: ['laneHandle'],
  })
export type ForkDispatchedPayload = z.infer<typeof forkDispatchedPayloadSchema>

/** Hand-built for the same reason `forkCheckpointEventSchema` is — see its doc comment. */
export const forkDispatchedEventSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: z.literal('lab'),
  type: z.literal('fork.dispatched'),
  payload: forkDispatchedPayloadSchema,
})

export const labEventSchemas = [forkCheckpointEventSchema, forkDispatchedEventSchema] as const
