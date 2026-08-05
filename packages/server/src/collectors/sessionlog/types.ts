import type { AgentRole } from '@rhizomorph/core'
import type { LaneState, LaneStateReading } from './lane-state.js'
import type { TurnShapeState } from './turn-shape.js'

/** Internal snapshot shape for the sessionlog collector — opaque to the poll loop. */

export interface TailedFileState {
  /** Bytes already parsed; only what's appended past this is read next poll. */
  offset: number
  /**
   * `requestId` of the last `llm.usage` emitted for this file. A single
   * reply can span several lines that all repeat the same `requestId` and
   * `usage` block; comparing against just the last one is enough because
   * every real capture keeps those lines contiguous.
   */
  lastUsageRequestId: string | null
  /**
   * The transcript organ's fold over this file's lines so far (prd15 ruling 1).
   * Carried in the snapshot for the same reason `offset` is: the collector
   * reads only new bytes each poll, so the shape has to survive between them
   * — and folding the tail incrementally is what makes the derivation
   * prefix-consistent (`turn-shape.ts`).
   */
  turnShape?: TurnShapeState
  /** The file's mtime at the last poll that read it — the heartbeat witness. */
  lastWriteTs?: number | null
  /** Lane this file's transcript belongs to, as last resolved. */
  lane?: string | null
  /** Worktree the lane lives in — what the process probe is asked about. */
  worktreePath?: string | null
  /** Branch as the transcript itself reported it, when it did. */
  branch?: string | null
}

/**
 * One lane's transcript-derived liveness (prd15 ruling 1) as of the last poll.
 *
 * This is the organ's OUTPUT. It is not published as an event yet — see the
 * BLOCKED note on `agentStatusEmissionFor` in `lane-state.ts` — so the snapshot
 * is where a lane's derived state is legible today, and what
 * `tmuxless-boot.test.ts` reads.
 */
export interface LaneLiveness extends LaneStateReading {
  lane: string
  worktreePath: string | null
  branch: string | null
  /** Which transcript spoke for the lane — its freshest one. */
  sessionFile: string
  /** Tick clock this reading was derived at, so `quietMs` can be re-checked. */
  derivedAt: number
  /**
   * The state this lane held at the previous poll, or null when first seen.
   * Kept so publication stays edge-triggered once it is unblocked, and so a
   * transition is visible to a reader of the snapshot alone.
   */
  previousState: LaneState | null
}

export interface SessionlogSnapshot {
  /** Set once the session log root (or git itself) is confirmed unusable. */
  disabled: boolean
  /** Keyed by absolute file path. */
  files: Record<string, TailedFileState>
  /**
   * Keyed by the raw `--extra-sessions` spec string. Set once a spec resolves
   * to neither a direct session dir nor a slug-inferred fallback, so the
   * `collector.error` for it fires once, not every poll. Cleared the moment a
   * spec resolves again, so recovery doesn't need its own bookkeeping.
   */
  erroredExtraSessionDirs: Record<string, true>
  /**
   * Every worktree `git worktree list` has ever named for this repo, keyed by
   * path, remembered past the worktree's own removal (#165). `git worktree
   * list` only ever answers "what exists now" — the moment a lane lands and
   * its worktree is removed, it drops out of that list, and a tail set built
   * from the list alone would stop attributing (and eventually locating) a
   * transcript that is still sitting on disk. This is the fold's own memory
   * of what it has seen, so a folded lane's slug stays in the tail set
   * forever, not just while `git` still lists it. Cheap to keep: once a
   * folded worktree's session file has been fully read, tailing it again on a
   * later poll costs one `stat` and one `readdir`, never an open file handle
   * (`tailProjectDir` only opens a file when there are unread bytes).
   */
  knownWorktrees: Record<string, AgentRole>
  /**
   * The transcript-tail state machine's reading per lane, keyed by lane
   * (prd15 ruling 1). Rebuilt every poll from `files`, so it never carries a
   * fact older than the transcripts it was derived from.
   *
   * Optional for the same reason the organ's fields on {@link TailedFileState}
   * are: snapshots are persisted as JSON between runs
   * (`server/snapshot-store.ts`), so a snapshot written before this organ
   * existed rehydrates without them. Every read treats absence as "start
   * folding now" rather than as a fact, which is the same contract `offset`
   * has always had.
   */
  lanes?: Record<string, LaneLiveness>
}
