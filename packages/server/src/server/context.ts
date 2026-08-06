import type { SessionRecorder } from './recorder.js'

/** Everything the API routes need, threaded through from the CLI bootstrap so routes stay unit-testable. */
export interface ServerContext {
  repoPath: string
  repoName: string
  /** Directory holding this repo's session-*.jsonl files, past and present. */
  sessionDir: string
  recorder: SessionRecorder
  /** Path to the built web app (packages/web/dist), if it should be served statically. */
  webDistDir?: string
  /** Flatline threshold in ms, for routes/selectors that derive agent liveness. Defaults to the core selector's own default. */
  flatlineMs?: number
  /**
   * Injectable clock for the one route that writes (`POST /api/rotate`), so a
   * test can rotate at a pinned instant. Defaults to `Date.now`; no read-only
   * route needs it, since a fold's "now" comes from the events themselves.
   */
  now?: () => number
  /**
   * True when this server is serving a portable session record
   * (`rhizomorph replay`) rather than watching a repo. A record is a finished
   * thing: the recorder's hand (prd16 ruling 2) is refused here, so nothing
   * can rotate a recording someone else made.
   */
  readOnly?: boolean
  /**
   * The per-process capability token (2026-08-06 audit; `api/security.ts`)
   * every mutating route requires. Optional here because `buildApp` mints
   * one at boot when a caller doesn't supply one — a test that needs a
   * specific value (or none at all, to assert the default-generated path)
   * is the only reason to set this directly.
   */
  capabilityToken?: string
}
