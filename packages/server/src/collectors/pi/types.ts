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
   * The session's own working directory, read once from the header line
   * (`type: "session"`) — pi reports this only there, never repeated on a
   * `message` entry the way claude repeats `cwd` on every assistant line
   * (`grammar.ts`'s header comment). `null` until a header read succeeds;
   * never re-attempted once resolved.
   */
  cwd?: string | null
  /** The header's own session id (a UUID), when a header read has resolved one. */
  sessionId?: string | null
  /**
   * The `dev`+`ino` this file had at the last poll that read it. Absent means
   * either a snapshot persisted before this field existed, or a file never
   * read before.
   */
  identity?: TailIdentity
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
  /** Keyed by absolute file path. */
  files: Record<string, PiTailedFileState>
  /** The transcript-tail state machine's reading per lane, rebuilt every poll from `files`. */
  lanes?: Record<string, PiLaneLiveness>
}
