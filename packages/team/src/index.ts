/**
 * `@rhizomorph/team` — the team server's storage (prd-51 rulings 5 and 13).
 *
 * **This module runs nothing on import.** It exports types and functions and
 * declares no side effect: no connection is opened, no migration is applied, no
 * listener is bound. Ruling 14 keeps the team server a separate package whose
 * HTTP surface arrives with the ingest route in wave 3, and an entrypoint added
 * before that wave can bound it is an entrypoint nobody has scoped.
 *
 * What is here is the substrate waves 3 and 4 build on:
 *
 * - {@link TeamStorage} — the port. No SQL crosses it.
 * - `createPostgresStorage` / `openSql` — the one adapter and the one driver
 *   seam behind it (ADR-0043).
 * - `runMigrations` — tracked SQL files applied in order against `_migrations`.
 * - `resolveTeamConfig` — every value naming who set it and where (ruling 9).
 * - `bootstrapTeamStorage` — the `synchronous_commit` preflight, then the
 *   migrations, in that order and never the other (ruling 4).
 */

export {
  ACCEPTED_SYNCHRONOUS_COMMIT,
  type BootstrapResult,
  type PreflightResult,
  SYNCHRONOUS_COMMIT,
  assertDurableCommit,
  bootstrapTeamStorage,
} from './bootstrap.js'
export {
  DEFAULT_DATABASE_URL,
  ENV_DATABASE_URL,
  ENV_MIGRATIONS_DIR,
  type TeamConfig,
  redactDatabaseUrl,
  resolveTeamConfig,
} from './config/config.js'
export {
  MIGRATIONS_DIR,
  type MigrationFile,
  type ReadMigrationDirResult,
  type RunResult,
  checksumOf,
  readMigrationDir,
  runMigrations,
} from './migrations/runner.js'
export type {
  AppliedMigration,
  EffectiveValue,
  EventQuery,
  EventRow,
  StorageResult,
  TeamStorage,
} from './storage/contract.js'
export { type SqlLike, openSql } from './storage/driver.js'
export { bindLine, buildMonthlyPartitionDdl, createPostgresStorage, toTimestamptz } from './storage/postgres.js'
