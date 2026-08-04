import type { AgentRole } from '@rhizomorph/core'

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
}
