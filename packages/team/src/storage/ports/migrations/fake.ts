import type { AppliedMigration, MigrationsPort } from './port.js'

export interface MigrationsFakeOptions {
  /** Migration ids whose apply throws — the mid-run failure case. */
  readonly failApply?: readonly string[]
  /** Rows already in `_migrations` before the first run. */
  readonly applied?: readonly AppliedMigration[]
}

export interface MigrationsFake extends MigrationsPort {
  /** Mutable, so one fake can fail a run and succeed the next. `runner.test.ts` calls `.clear()`. */
  readonly failApply: Set<string>
  /** Ids that actually committed a `_migrations` row. */
  readonly committed: string[]
  readonly migrationsTableExists: boolean
}

/**
 * **Its semantics must not be kinder than the adapter's.** `runner.test.ts`'s
 * mid-run-failure and checksum-change cases are only meaningful if this double
 * fails the way Postgres would: `applyMigration` records its bookkeeping row
 * **only after** the migration body succeeds, exactly as the real adapter's
 * single transaction does. `fake.test.ts` holds that, because a double that
 * quietly commits a failed migration would make every runner test above it a lie.
 *
 * `committed` and `migrationsTableExists` are getters over closure state, so the
 * composing class can forward a live read. `failApply` is a real `Set` whose
 * identity the composing class shares — `migrations/runner.test.ts` calls
 * `fake.failApply.clear()` and the next `applyMigration` must see it.
 */
export function createMigrationsFake(calls: string[], options: MigrationsFakeOptions): MigrationsFake {
  const failApply = new Set(options.failApply ?? [])
  const applied: AppliedMigration[] = [...(options.applied ?? [])]
  let migrationsTableExists = false

  return {
    failApply,
    get committed(): string[] {
      return applied.map((m) => m.id)
    },
    get migrationsTableExists(): boolean {
      return migrationsTableExists
    },

    async ensureMigrationsTable(): Promise<void> {
      calls.push('ensureMigrationsTable')
      migrationsTableExists = true
    },

    async listAppliedMigrations(): Promise<AppliedMigration[]> {
      calls.push('listAppliedMigrations')
      if (!migrationsTableExists) {
        throw new Error('_migrations does not exist — ensureMigrationsTable was never called')
      }
      return [...applied].sort((a, b) => a.id.localeCompare(b.id))
    },

    async applyMigration(m: { id: string; checksum: string; sql: string }): Promise<void> {
      calls.push(`applyMigration:${m.id}`)
      if (!migrationsTableExists) {
        throw new Error('_migrations does not exist — ensureMigrationsTable was never called')
      }
      // The transaction. The bookkeeping row lands only if the body does, which is
      // the property the real adapter gets from `sql.begin`.
      if (failApply.has(m.id)) {
        throw new Error(`migration ${m.id} failed`)
      }
      applied.push({ id: m.id, checksum: m.checksum, appliedAt: new Date(0).toISOString() })
    },
  }
}
