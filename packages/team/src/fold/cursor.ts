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
 *
 * ## IT IS PER ACTOR, AND `seq` IS THE LOW-WATER MARK (ruling 16)
 *
 * One number per journal cannot say "actor A is stuck at 5 while actor B is at 20", and ruling
 * 16 folds per actor precisely so one skewed sender cannot stop the others. So the cursor grows
 * an `actors` record and `seq` becomes **the minimum over them** — the point every known actor
 * has committed through, and therefore the only seq `readJournal` may safely start from.
 *
 * The shape deliberately mirrors `packages/server/src/shipper/cursor.ts`, which already solved
 * this on the other side of the wire: a `version` literal and a record keyed by actor instance.
 *
 * A stuck actor holds `seq` back, so the other actors' records in that span are re-read on every
 * pass. They insert nothing — `ON CONFLICT DO NOTHING` dedups them — and `actors` is what keeps
 * the re-read from also being a re-derivation: a record at or below an actor's own mark is
 * skipped before a row is ever built.
 */

export const FOLD_CURSOR_VERSION = 1

export interface FoldCursor {
  /** The journal seq EVERY known actor has committed through — where `readJournal` starts. */
  readonly seq: number
  /** Per actor instance, the last journal seq whose rows for that actor are committed. */
  readonly actors: Readonly<Record<string, number>>
}

const COLD_START: FoldCursor = { seq: 0, actors: {} }

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * The cursor on disk, or a cold start. Never throws.
 *
 * Three arms, in this order:
 *
 * 1. **A bare number** — the format this module wrote before ruling 16, and the format sitting
 *    on any deployment that has already folded. It reads as that seq with no per-actor detail,
 *    rather than as garbage: reading it as garbage would replay from 0, which is safe (rows
 *    dedup) but needlessly slow, and silently so.
 * 2. **Valid v1 JSON** — used as written, with a negative or non-integer per-actor value dropped
 *    rather than invalidating the whole file.
 * 3. **Anything else** — a cold start, per the law above. A future `version` lands here too.
 */
export function readCursor(path: string): FoldCursor {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return COLD_START
  }

  const trimmed = text.trim()
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed)
    return Number.isSafeInteger(value) && value >= 0 ? { seq: value, actors: {} } : COLD_START
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(trimmed)
  } catch {
    return COLD_START
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return COLD_START

  const envelope = decoded as Record<string, unknown>
  if (envelope.version !== FOLD_CURSOR_VERSION) return COLD_START
  const seq = nonNegativeInt(envelope.seq)
  if (seq === null) return COLD_START

  const actorsValue = envelope.actors
  if (typeof actorsValue !== 'object' || actorsValue === null || Array.isArray(actorsValue)) {
    return COLD_START
  }
  const actors: Record<string, number> = {}
  for (const [actorInstance, value] of Object.entries(actorsValue as Record<string, unknown>)) {
    const parsed = nonNegativeInt(value)
    if (parsed !== null) actors[actorInstance] = parsed
  }
  return { seq, actors }
}

/**
 * The low-water mark over a set of per-actor marks: the seq every known actor has committed
 * through. `0` when nothing is known, which is a cold start by another name.
 */
export function lowWaterMark(actors: Readonly<Record<string, number>>): number {
  const seqs = Object.values(actors)
  if (seqs.length === 0) return 0
  return Math.min(...seqs)
}

/**
 * Writes the cursor as `<path>.tmp`, then renames it over `<path>`.
 *
 * `afterCursorWriteBeforeRename` fires between the two. A death there must
 * leave the real cursor holding its OLD value — the temporary file is not the
 * cursor, and nothing ever reads it.
 */
export function writeCursor(path: string, cursor: FoldCursor, faults?: FoldFaults): void {
  const tmp = `${path}.tmp`
  const body = JSON.stringify({
    version: FOLD_CURSOR_VERSION,
    seq: cursor.seq,
    actors: cursor.actors,
  })
  writeFileSync(tmp, `${body}\n`, 'utf8')
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
