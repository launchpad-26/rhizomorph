import type { TeamStorage } from './contract.js'
import type { SqlLike } from './driver.js'
import { createCatalogSql } from './ports/catalog/sql.js'
import { createEventsSql } from './ports/events/sql.js'
import { createIngestKeysSql } from './ports/ingest-keys/sql.js'
import { createLifecycleSql } from './ports/lifecycle/sql.js'
import { createMigrationsSql } from './ports/migrations/sql.js'
import { createQuestionsSql } from './ports/questions/sql.js'
import { createRetentionSql } from './ports/retention/sql.js'
import { createSettingsSql } from './ports/settings/sql.js'

/**
 * THE POSTGRES COMPOSITION ROOT — and the only module that may import a port's SQL.
 *
 * It contains **no SQL of its own**. The modules that may are
 * `ports/<port>/sql.ts`, one per capability, and
 * `no-sql-outside-storage-law.test.ts` holds all of that as a grep law over this
 * package's non-test sources: no `postgres` import outside `driver.ts`, no
 * tagged-template query and no SQL statement literal outside a port's SQL
 * module, exactly one `.unsafe(` call site and it is `ddl.ts`, and — the clause
 * this file is named in — no source but this one may import a `sql.js` at all.
 * The law is what makes ruling 5's "storage behind an interface" a checkable
 * property rather than a habit, and what stops the 450-line adapter regrowing.
 *
 * Every SQL module is typed against {@link SqlLike} — the hand-written driver
 * slice — and not against `postgres.Sql`, so `recording-sql.ts` can stand in for
 * a database and the tests can assert **which statements are sent and which
 * bytes are bound**.
 *
 * ## What this file's tests prove, and what they honestly do not
 *
 * `postgres.test.ts` proves the adapters do not touch the bytes they are given:
 * `line` reaches the bound parameter unchanged, `payload` is a parameter and
 * never interpolated, and the batch and the migration each sit inside one
 * transaction. It does **not** prove that Postgres itself stores and returns
 * those bytes unchanged, nor that `timestamptz` round-trips the converted
 * value. That meets a real host in wave 4, by design — this issue stands up no
 * Postgres service, because `.github/workflows/` belongs to another programme.
 */

export { toTimestamptz } from './coerce.js'
export { bindLine, buildMonthlyPartitionDdl, partitionNameFor } from './ports/events/sql.js'

/**
 * The eight ports, spread into one object.
 *
 * The declared return type is what makes each spread load-bearing: drop one and
 * `tsc` reports TS2322 naming the first method that went missing. Alphabetical,
 * one port per line, so a wave-9 lane adds one line and a cherry-pick collision
 * is a both-sides-add resolved mechanically.
 */
export function createPostgresStorage(sql: SqlLike): TeamStorage {
  return {
    ...createCatalogSql(sql),
    ...createEventsSql(sql),
    ...createIngestKeysSql(sql),
    ...createLifecycleSql(sql),
    ...createMigrationsSql(sql),
    ...createQuestionsSql(sql),
    ...createRetentionSql(sql),
    ...createSettingsSql(sql),
  }
}
