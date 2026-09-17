import { toEpochMs, toNullableString, toTimestamptz } from '../../coerce.js'
import { runDdl } from '../../ddl.js'
import type { SqlLike } from '../../driver.js'
import type { RetentionCeiling, RetentionPort } from './port.js'

/**
 * `events_YYYY_MM`, and nothing else. The gate on the one interpolated identifier here.
 *
 * Same regex and same argument as `ports/events/sql.ts`'s `PARTITION_RE`: a
 * partition name is an IDENTIFIER, identifiers are not bindable, so the pattern
 * is the whole safety story rather than a tidy-up before one.
 */
const PARTITION_RE = /^events_\d{4}_(?:0[1-9]|1[0-2])$/

/**
 * RULING 10'S DROP, AND THE TWO THINGS A READER WILL OTHERWISE GET WRONG.
 *
 * 1. **PostgreSQL has no `ALTER TABLE ... DROP PARTITION`.** Ruling 10's
 *    "`DROP PARTITION`" is spelled `DROP TABLE <partition>` here, and that IS the
 *    statement the ruling measured: it returns the bytes immediately (3.53 s)
 *    rather than leaving dead tuples behind two lock windows for a vacuum
 *    (17.6 s for the `DELETE`).
 *
 * 2. **It takes a brief ACCESS EXCLUSIVE lock on the parent.** Recorded rather
 *    than solved. It is why `sweepRetention` runs after a fold drain has settled
 *    and never on the ingest hot path — the same reason `fold/worker.ts` gives
 *    for topping partitions up at boot instead of on demand.
 *
 * **This is the owner's statement, not `rz_ingest`'s.** `0003_roles_rls.sql`
 * grants `rz_ingest` INSERT on `events` and no DDL anywhere, and dropping a
 * partition needs ownership of it. The app connects as the database owner
 * (`0005_ingest_keys.sql`'s header records that fact and why), so the sweep can
 * issue this and the fold's own statements still sit inside `rz_ingest`'s
 * grants — which is what `fold/worker.test.ts`'s grant law holds over `runOnce`,
 * and why the sweep is deliberately not part of it.
 */
function dropStatement(partition: string): string {
  if (!PARTITION_RE.test(partition)) {
    throw new Error(
      `dropEventPartition: refusing ${JSON.stringify(partition)} — only an events_YYYY_MM partition may be dropped, and the name is interpolated into DDL, so it is checked before a single character of it reaches a statement`,
    )
  }
  return `DROP TABLE IF EXISTS ${partition}`
}

function toCeiling(row: Record<string, unknown>): RetentionCeiling {
  return {
    projectId: String(row.project_id),
    maxAgeDays: Number(row.max_age_days),
    archiveBeforeDrop: row.archive_before_drop === true,
    archiveDir: toNullableString(row.archive_dir),
    setBy: String(row.set_by),
    source: String(row.source),
    setAtMs: toEpochMs(row.set_at),
  }
}

export function createRetentionSql(sql: SqlLike): RetentionPort {
  return {
    async readCeilings(): Promise<RetentionCeiling[]> {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT project_id, max_age_days, archive_before_drop, archive_dir, set_by, source, set_at
        FROM retention_ceilings
        ORDER BY project_id
      `
      return rows.map(toCeiling)
    },

    /**
     * `DO UPDATE`, not `DO NOTHING` — and every column moves, provenance
     * included. See {@link RetentionPort.nameCeiling}: an effective value names
     * the admin who set it LAST. A `DO NOTHING` here would silently keep the
     * first admin's age while the second believed theirs had taken.
     */
    async nameCeiling(ceiling: RetentionCeiling): Promise<void> {
      await sql`
        INSERT INTO retention_ceilings (
          project_id, max_age_days, archive_before_drop, archive_dir, set_by, source, set_at
        )
        VALUES (
          ${ceiling.projectId},
          ${ceiling.maxAgeDays},
          ${ceiling.archiveBeforeDrop},
          ${ceiling.archiveDir},
          ${ceiling.setBy},
          ${ceiling.source},
          ${toTimestamptz(ceiling.setAtMs)}::timestamptz
        )
        ON CONFLICT (project_id) DO UPDATE SET
          max_age_days = EXCLUDED.max_age_days,
          archive_before_drop = EXCLUDED.archive_before_drop,
          archive_dir = EXCLUDED.archive_dir,
          set_by = EXCLUDED.set_by,
          source = EXCLUDED.source,
          set_at = EXCLUDED.set_at
      `
    },

    async clearCeiling(projectId: string): Promise<boolean> {
      const result = await sql`DELETE FROM retention_ceilings WHERE project_id = ${projectId}`
      return result.count > 0
    },

    /**
     * The parent's own children, from the catalogue.
     *
     * `pg_inherits` rather than `information_schema`, which has no view of a
     * partition's parent at all. Ordered by name, which for `events_YYYY_MM` is
     * chronological — so the sweep drops oldest first without sorting again.
     *
     * The filter is the parent's NAME, bound as a parameter, so nothing about
     * this statement's text varies.
     */
    async listEventPartitions(): Promise<string[]> {
      const rows = await sql<{ partition: string }[]>`
        SELECT child.relname AS partition
        FROM pg_inherits
        JOIN pg_class AS child ON child.oid = pg_inherits.inhrelid
        JOIN pg_class AS parent ON parent.oid = pg_inherits.inhparent
        WHERE parent.relname = ${'events'}
        ORDER BY child.relname
      `
      return rows.map((row) => String(row.partition))
    },

    /**
     * `IF EXISTS`, so a sweep that races another operator's manual drop is a
     * no-op rather than a failure. The name is validated before it is
     * interpolated; see {@link dropStatement}.
     */
    async dropEventPartition(partition: string): Promise<void> {
      await runDdl(sql, dropStatement(partition))
    },
  }
}
