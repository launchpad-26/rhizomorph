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
}
