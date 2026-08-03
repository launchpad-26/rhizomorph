import { z } from 'zod'
import {
  authorSchema,
  dirtyFileSchema,
  envelope,
  fileChangeSchema,
  nonEmptyString,
  timestampSchema,
} from './common.js'

/** git-sourced events. Raw facts only — nothing derived. */

export const worktreeDiscoveredPayloadSchema = z.object({
  /** Absolute path of the worktree root. The identity of a worktree. */
  path: nonEmptyString,
  /** null when HEAD is detached. */
  branch: nonEmptyString.nullable(),
  head: nonEmptyString.nullable(),
  /** True for the repo's primary worktree (the one that owns .git). */
  isMain: z.boolean(),
  detached: z.boolean().optional(),
  locked: z.boolean().optional(),
  prunable: z.boolean().optional(),
})
export type WorktreeDiscoveredPayload = z.infer<typeof worktreeDiscoveredPayloadSchema>

export const worktreeRemovedPayloadSchema = z.object({
  path: nonEmptyString,
})
export type WorktreeRemovedPayload = z.infer<typeof worktreeRemovedPayloadSchema>

/**
 * A ref the collector's `for-each-ref` snapshot saw last poll and no longer
 * sees. Raw fact only: the branch is gone from the repo, nothing about why
 * (merged, deleted, renamed) — the fold decides what that means for state.
 */
export const branchRemovedPayloadSchema = z.object({
  branch: nonEmptyString,
})
export type BranchRemovedPayload = z.infer<typeof branchRemovedPayloadSchema>

export const branchUpdatedPayloadSchema = z.object({
  branch: nonEmptyString,
  head: nonEmptyString,
  previousHead: nonEmptyString.nullable().optional(),
  worktreePath: nonEmptyString.nullable().optional(),
  /**
   * Commit counts against the merge-base with main, when the collector was
   * able to compute them. Selectors prefer these over stream-derived counts.
   */
  aheadOfMain: z.number().int().nonnegative().nullable().optional(),
  behindMain: z.number().int().nonnegative().nullable().optional(),
})
export type BranchUpdatedPayload = z.infer<typeof branchUpdatedPayloadSchema>

export const commitLandedPayloadSchema = z.object({
  sha: nonEmptyString,
  branch: nonEmptyString,
  message: z.string(),
  author: authorSchema,
  authoredAt: timestampSchema.optional(),
  parents: z.array(nonEmptyString).optional(),
  files: z.array(fileChangeSchema),
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  worktreePath: nonEmptyString.nullable().optional(),
})
export type CommitLandedPayload = z.infer<typeof commitLandedPayloadSchema>

/**
 * The full current uncommitted changed-file set for a worktree — snapshot
 * semantics, not a delta: each event replaces the previous set.
 */
export const worktreeDirtyPayloadSchema = z.object({
  path: nonEmptyString,
  branch: nonEmptyString.nullable().optional(),
  files: z.array(dirtyFileSchema),
})
export type WorktreeDirtyPayload = z.infer<typeof worktreeDirtyPayloadSchema>

export const worktreeDiscoveredEventSchema = envelope(
  'git',
  'worktree.discovered',
  worktreeDiscoveredPayloadSchema,
)
export const worktreeRemovedEventSchema = envelope(
  'git',
  'worktree.removed',
  worktreeRemovedPayloadSchema,
)
export const branchRemovedEventSchema = envelope(
  'git',
  'branch.removed',
  branchRemovedPayloadSchema,
)
export const branchUpdatedEventSchema = envelope(
  'git',
  'branch.updated',
  branchUpdatedPayloadSchema,
)
export const commitLandedEventSchema = envelope(
  'git',
  'commit.landed',
  commitLandedPayloadSchema,
)
export const worktreeDirtyEventSchema = envelope(
  'git',
  'worktree.dirty',
  worktreeDirtyPayloadSchema,
)

export const gitEventSchemas = [
  worktreeDiscoveredEventSchema,
  worktreeRemovedEventSchema,
  branchUpdatedEventSchema,
  branchRemovedEventSchema,
  commitLandedEventSchema,
  worktreeDirtyEventSchema,
] as const
