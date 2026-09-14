/** THE MIGRATIONS PORT — the runner's own bookkeeping, behind the interface. */

/** One row of the runner's own bookkeeping table. */
export interface AppliedMigration {
  /** The migration's id, e.g. `0001_events`. */
  readonly id: string
  /** sha-256 hex of the file text, `\r\n` normalised to `\n` first. */
  readonly checksum: string
  /** ISO-8601 UTC. */
  readonly appliedAt: string
}

export interface MigrationsPort {
  /** Creates the runner's own bookkeeping table if it is absent. Idempotent. */
  ensureMigrationsTable(): Promise<void>

  listAppliedMigrations(): Promise<AppliedMigration[]>

  /** The migration's statements and its bookkeeping row in ONE transaction: both, or neither. */
  applyMigration(m: { id: string; checksum: string; sql: string }): Promise<void>
}
