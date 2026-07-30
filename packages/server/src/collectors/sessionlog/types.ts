import type { AgentRole } from '@observatory/core'

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
}
