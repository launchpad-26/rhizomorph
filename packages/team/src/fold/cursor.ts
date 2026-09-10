import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { FoldFaults } from '../ingest/faults.js'

/**
 * THE FOLD CURSOR — tmp, then rename (prd-51 ruling 4).
 *
 * The cursor is the last journal `seq` whose rows are committed. It is written
 * **after** the commit and never before, and it is written by writing a
 * temporary file and renaming it over the real one: `rename(2)` within a
 * directory is atomic, so a reader sees the old value or the new one and never
 * a half-written number.
 *
 * **It may skip fsync, and ruling 4 says why.** Every reachable post-crash
 * state is behind-or-equal to committed truth: a cursor that lost its last
 * write replays journal records whose rows are already in the database, and
 * those rows dedup. A rewind costs time, not rows. The one ordering that would
 * NOT be safe — cursor first, then commit — is the mutation
 * `worker.test.ts`'s F7 exists to catch.
 *
 * **Garbage reads as a cold start rather than an error.** A truncated, empty or
 * non-numeric cursor file means "start from the beginning", which replays and
 * dedups; refusing to start would turn a recoverable state into an outage. This
 * mirrors the shipper's measured behaviour on the same file shape.
 */

/** The last committed journal seq, or 0 for a cold start. Never throws. */
export function readCursor(path: string): number {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return 0
  }
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return 0
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * Writes the cursor as `<path>.tmp`, then renames it over `<path>`.
 *
 * `afterCursorWriteBeforeRename` fires between the two. A death there must
 * leave the real cursor holding its OLD value — the temporary file is not the
 * cursor, and nothing ever reads it.
 */
export function writeCursor(path: string, seq: number, faults?: FoldFaults): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${seq}\n`, 'utf8')
  try {
    faults?.afterCursorWriteBeforeRename?.()
  } catch (cause) {
    // The temporary file is swept up so a later run cannot mistake a stale one
    // for anything; the cursor itself is untouched, which is the point.
    try {
      unlinkSync(tmp)
    } catch {
      // Nothing to clean up. The cursor is still the cursor.
    }
    throw cause
  }
  renameSync(tmp, path)
}
