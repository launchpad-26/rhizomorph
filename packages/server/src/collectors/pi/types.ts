import type { AgentRole } from '@rhizomorph/core'
import type { LaneState, LaneStateReading } from '../sessionlog/lane-state.js'
import type { TailIdentity } from '../sessionlog/tail.js'
import type { TurnShapeState } from '../sessionlog/turn-shape.js'

/** Internal snapshot shape for the pi collector — opaque to the poll loop. */

export interface PiTailedFileState {
  /** Bytes already parsed; only what's appended past this is read next poll. */
  offset: number
  /**
   * The transcript organ's fold over this file's lines so far (prd15 ruling 1),
   * reused unchanged from sessionlog's tail-shape machinery — `TurnEntry` is a
   * generic contract, not a claude-specific one.
   */
  turnShape?: TurnShapeState
  /** The file's mtime at the last poll that read it — the heartbeat witness. */
  lastWriteTs?: number | null
  /** Lane this file's transcript belongs to, as last resolved. */
  lane?: string | null
  /**
   * The **watched worktree** this session's `cwd` was resolved to — never the
   * raw `cwd` itself (#609). A file only reaches this state at all once its
   * header `cwd` fell inside a worktree of the watched repo, so this is always
   * one of `PiSnapshot.knownWorktrees`' keys, and it is what the lane key, the
   * `worktreePath` attribution and the process probe are all taken from.
   */
  worktreePath?: string | null
  /**
   * The `dev`+`ino` this file had at the last poll that read it. Absent means
   * either a snapshot persisted before this field existed, or a file never
   * read before.
   */
  identity?: TailIdentity
}

/**
 * A parsed session header (`type: "session"`) — the one line pi's own `cwd` and
 * session id live on, since pi never repeats them on a `message` line the way
 * claude repeats `cwd` on every assistant line (`grammar.ts`'s header comment).
 * Cached in the snapshot per file so a session belonging to some *other*
 * project is not re-opened and re-read on every poll just to be re-rejected.
 */
export interface PiHeader {
  cwd: string | null
  sessionId: string | null
}

/**
 * One lane's transcript-derived liveness (prd15 ruling 1) as of the last poll,
 * mirroring sessionlog's `LaneLiveness` — the derivation itself
 * (`deriveLaneState`) is shared, unmodified machinery.
 */
export interface PiLaneLiveness extends LaneStateReading {
  lane: string
  worktreePath: string | null
  /** Which transcript spoke for the lane — its freshest one. */
  sessionFile: string
  /** Tick clock this reading was derived at, so `quietMs` can be re-checked. */
  derivedAt: number
  /** The state this lane held at the previous poll, or null when first seen. */
  previousState: LaneState | null
}

export interface PiSnapshot {
  /** Set once the pi sessions root is confirmed unusable. */
  disabled: boolean
  /** Keyed by absolute file path. Only sessions inside a watched worktree are ever recorded here. */
  files: Record<string, PiTailedFileState>
  /** The transcript-tail state machine's reading per lane, rebuilt every poll from `files`. */
  lanes?: Record<string, PiLaneLiveness>
  /**
   * Every worktree of the watched repo this collector has ever seen live, with
   * the role it carried — the same fold sessionlog keeps (#165), and for the
   * same reason: a lane's worktree is removed once its work lands, and its
   * transcript must stay attributable afterwards. It is also the **scope**:
   * a pi session whose `cwd` falls inside none of these keys is not this
   * repo's business and is never tailed (#609).
   */
  knownWorktrees?: Record<string, AgentRole>
  /**
   * Header line per session file, keyed by absolute path and pruned to the
   * files still on disk. Only a header that resolved a `cwd` is cached — an
   * unreadable or not-yet-written one is retried next poll, never remembered
   * as absent.
   */
  headers?: Record<string, PiHeader>
}
