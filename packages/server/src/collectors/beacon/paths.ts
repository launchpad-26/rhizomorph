import path from 'node:path'
import { defaultDataRoot, sessionDirFor } from '../../log/paths.js'

export const BEACONS_DIR_NAME = 'beacons'
export const BEACON_FILE_SUFFIX = '.jsonl'

/**
 * `<dataRoot>/<repoSlug>/beacons` — the one rhizomorph-owned directory a
 * beacon writer appends to (ADR-0036; prd-27 ruling 1 / prd-17 ruling 2).
 *
 * Per repo, not instrument-wide: a beacon from one repo's swarm must never
 * fold into another repo's session. The pi collector learned that scoping the
 * hard way (#609) and had to enforce it by header field; a directory keyed by
 * the repo's slug enforces it structurally, and `repoSlug` carries a hash so
 * two repos sharing a basename still get two directories.
 *
 * Beside the recordings, because prd-17 ruling 2 names "the instrument's own
 * data directory" as the door, and `listSessions` matches only
 * `session-<ts>.jsonl` in the session directory itself — so `beacons/` is
 * invisible to it, to retention and to the lane index, the same posture
 * `snapshots/` and `transcripts/` hold.
 *
 * The collector never creates this directory. Creating one's own input is one
 * step from writing into it; the writer that appends is the one that knows the
 * directory has to exist (`collector.ts`).
 */
export function beaconDirFor(repoPath: string, dataRoot: string = defaultDataRoot()): string {
  return path.join(sessionDirFor(repoPath, dataRoot), BEACONS_DIR_NAME)
}
