import type { FoldFaults } from '../ingest/faults.js'
import { readJournal } from '../journal/read.js'
import type { EventRow, TeamStorage } from '../storage/contract.js'
import { readCursor, writeCursor } from './cursor.js'
import { projectionsFor } from './projections.js'
import { toEventRow } from './row.js'

/**
 * ORDERING 2, THE FOLD (prd-51 ruling 4).
 *
 * ```
 * read the journal from the cursor
 *   -> BEGIN -> INSERT ... ON CONFLICT DO NOTHING -> the projections -> COMMIT
 *   -> THEN persist the cursor, tmp-then-rename
 * ```
 *
 * The cursor moves last, and the reason is the executed mutation: under
 * cursor-first, a death between the cursor write and the commit advances past a
 * batch whose rows rolled back, and the restart skips it — 15,000 lines lost
 * across 30 kills. Under commit-first the same death replays a committed batch,
 * which dedups. **A rewind costs time, not rows.**
 *
 * ## THE FOLD NEVER CREATES A PARTITION
 *
 * `migrations/0003_roles_rls.sql` grants `rz_ingest` INSERT on `events` and no
 * CREATE anywhere. A worker that created a partition on demand would fail on
 * the first real host with a permission error — and `CREATE TABLE … PARTITION OF`
 * takes an ACCESS EXCLUSIVE lock on the parent besides, on the hot path. So the
 * monthly window is topped up at **boot** (`../api/main.ts`), and a row whose
 * `ts` falls outside every existing partition fails its insert loudly: the
 * transaction rolls back, the cursor does not move, and an operator sees it.
 * Fail-closed. `worker.test.ts` asserts the recorded statements of a fold
 * contain no `CREATE` at all.
 *
 * ## An unfoldable line aborts the run
 *
 * Ruling 3's invariant is no gaps in `n`. Skipping a line the fold cannot read
 * would manufacture exactly that gap, silently, so the run refuses instead: the
 * cursor stays put, nothing is inserted, and the same record is retried.
 */

export interface FoldDeps {
  readonly journalPath: string
  readonly cursorPath: string
  readonly storage: TeamStorage
  readonly faults?: FoldFaults | undefined
  readonly trace?: ((step: string) => void) | undefined
}

export type FoldResult =
  | {
      ok: true
      /** Journal records folded this run. 0 when the cursor is already at the tail. */
      readonly records: number
      /** Rows the batch carried. */
      readonly rows: number
      /** Rows that actually landed — 0 for a complete replay. */
      readonly inserted: number
      /** Where the cursor now stands. */
      readonly cursor: number
    }
  | { ok: false; error: string }

/** One pass over everything the journal holds past the cursor. Never throws. */
export async function runOnce(deps: FoldDeps): Promise<FoldResult> {
  const cursor = readCursor(deps.cursorPath)

  const journal = readJournal(deps.journalPath, cursor)
  deps.trace?.('fold.read')
  if (!journal.ok) return { ok: false, error: journal.error }
  if (journal.records.length === 0) {
    return { ok: true, records: 0, rows: 0, inserted: 0, cursor }
  }

  const rows: EventRow[] = []
  for (const record of journal.records) {
    for (const entry of record.entry.batch) {
      const row = toEventRow(record.entry.project, record.entry.actorInstance, entry.n, entry.line)
      if (!row.ok) {
        return { ok: false, error: `journal seq ${record.seq}: ${row.error}` }
      }
      rows.push(row.row)
    }
  }

  const target = journal.records[journal.records.length - 1]?.seq ?? cursor

  try {
    deps.faults?.afterReadBeforeBegin?.()

    deps.trace?.('fold.begin')
    const inserted = await deps.storage.appendEvents(rows, (landed) => {
      // Inside the transaction, after the inserts and before the commit — which
      // is exactly where a fault has to fire to prove the rollback, and exactly
      // where the delta has to be computed to be idempotent.
      deps.trace?.('fold.insert')
      deps.faults?.afterInsertBeforeCommit?.()
      return projectionsFor(landed)
    })
    deps.trace?.('fold.commit')

    deps.faults?.afterCommitBeforeCursor?.()

    deps.trace?.('cursor.write')
    writeCursor(deps.cursorPath, target, deps.faults)
    deps.trace?.('cursor.rename')

    return { ok: true, records: journal.records.length, rows: rows.length, inserted, cursor: target }
  } catch (cause) {
    return {
      ok: false,
      error: `fold of journal seq ${target} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}
