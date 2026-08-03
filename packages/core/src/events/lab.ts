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

export const labEventSchemas = [forkCheckpointEventSchema] as const
