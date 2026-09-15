import { toEpochMs } from '../../coerce.js'
import { runDdl } from '../../ddl.js'
import type { SqlLike } from '../../driver.js'
import type { AppliedMigration, MigrationsPort } from './port.js'

/**
 * The runner's own bookkeeping table.
 *
 * It cannot itself be a tracked migration: the runner has to read this table to
 * know which migrations to run. That chicken-and-egg is resolved by putting the
 * DDL in a module the law permits SQL in, rather than by giving the runner a
 * `0000` file it must special-case.
 */
const MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS _migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`

export function createMigrationsSql(sql: SqlLike): MigrationsPort {
  return {
    async ensureMigrationsTable(): Promise<void> {
      await runDdl(sql, MIGRATIONS_TABLE_DDL)
    },

    async listAppliedMigrations(): Promise<AppliedMigration[]> {
      const rows = await sql<{ id: string; checksum: string; applied_at: unknown }[]>`
        SELECT id, checksum, applied_at FROM _migrations ORDER BY id
      `
      return rows.map((row) => ({
        id: row.id,
        checksum: row.checksum,
        appliedAt: new Date(toEpochMs(row.applied_at)).toISOString(),
      }))
    },

    async applyMigration(m: { id: string; checksum: string; sql: string }): Promise<void> {
      await sql.begin(async (tx) => {
        await runDdl(tx, m.sql)
        await tx`INSERT INTO _migrations (id, checksum) VALUES (${m.id}, ${m.checksum})`
      })
    },
  }
}
