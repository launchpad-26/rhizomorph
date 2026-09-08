import type { AppliedMigration, EventQuery, EventRow, TeamStorage } from './contract.js'

/**
 * A PORT DOUBLE — an in-memory `TeamStorage` with a call log.
 *
 * This is not `RecordingSql`, and the two are for different layers. This stands
 * in for the *port*, so everything above it — the migration runner, the
 * bootstrap ordering — can be tested with no driver and no database.
 * `recording-sql.ts` stands in for the *driver*, one layer below.
 *
 * **Its semantics must not be kinder than the adapter's.** `runner.test.ts`'s
 * mid-run-failure and checksum-change cases are only meaningful if this double
 * fails the way Postgres would: {@link FakeTeamStorage.applyMigration} records
 * its bookkeeping row **only after** the migration body succeeds, exactly as
 * the real adapter's single transaction does. `fake.test.ts` holds that, because
 * a double that quietly commits a failed migration would make every runner test
 * above it a lie.
 */

export interface FakeTeamStorageOptions {
  /** What `readSetting` returns, by name. Anything unnamed reads as `''`. */
  readonly settings?: Readonly<Record<string, string>>
  /** Migration ids whose apply throws — the mid-run failure case. */
  readonly failApply?: readonly string[]
  /** Rows already in `_migrations` before the first run. */
  readonly applied?: readonly AppliedMigration[]
}

export class FakeTeamStorage implements TeamStorage {
  /** Every port call, in order. `applyMigration` records its id. */
  readonly calls: string[] = []
  readonly events: EventRow[] = []
  readonly partitions: string[] = []
  migrationsTableExists = false
  closed = false

  /** Migration ids whose apply throws. Mutable, so one fake can fail a run and succeed the next. */
  readonly failApply: Set<string>

  private readonly settings: Readonly<Record<string, string>>
  private readonly applied: AppliedMigration[]

  constructor(options: FakeTeamStorageOptions = {}) {
    this.settings = options.settings ?? {}
    this.failApply = new Set(options.failApply ?? [])
    this.applied = [...(options.applied ?? [])]
  }

  /** Migration ids `applyMigration` was called with, in order — including the ones that threw. */
  get applyAttempts(): string[] {
    return this.calls.filter((c) => c.startsWith('applyMigration:')).map((c) => c.slice('applyMigration:'.length))
  }

  /** Ids that actually committed a `_migrations` row. */
  get committed(): string[] {
    return this.applied.map((m) => m.id)
  }

  async readSetting(name: string): Promise<string> {
    this.calls.push('readSetting')
    return this.settings[name] ?? ''
  }

  async ensureMigrationsTable(): Promise<void> {
    this.calls.push('ensureMigrationsTable')
    this.migrationsTableExists = true
  }

  async listAppliedMigrations(): Promise<AppliedMigration[]> {
    this.calls.push('listAppliedMigrations')
    if (!this.migrationsTableExists) {
      throw new Error('_migrations does not exist — ensureMigrationsTable was never called')
    }
    return [...this.applied].sort((a, b) => a.id.localeCompare(b.id))
  }

  async applyMigration(m: { id: string; checksum: string; sql: string }): Promise<void> {
    this.calls.push(`applyMigration:${m.id}`)
    if (!this.migrationsTableExists) {
      throw new Error('_migrations does not exist — ensureMigrationsTable was never called')
    }
    // The transaction. The bookkeeping row lands only if the body does, which is
    // the property the real adapter gets from `sql.begin`.
    if (this.failApply.has(m.id)) {
      throw new Error(`migration ${m.id} failed`)
    }
    this.applied.push({ id: m.id, checksum: m.checksum, appliedAt: new Date(0).toISOString() })
  }

  async appendEvents(rows: readonly EventRow[]): Promise<number> {
    this.calls.push('appendEvents')
    this.events.push(...rows)
    return rows.length
  }

  async readEvents(q: EventQuery): Promise<EventRow[]> {
    this.calls.push('readEvents')
    return this.events
      .filter(
        (e) =>
          e.projectId === q.projectId &&
          e.actorInstance === q.actorInstance &&
          e.n >= q.fromN &&
          e.n <= q.toN,
      )
      .sort((a, b) => a.n - b.n)
  }

  async ensureMonthlyPartition(month: string): Promise<void> {
    this.calls.push('ensureMonthlyPartition')
    if (!this.partitions.includes(month)) this.partitions.push(month)
  }

  async close(): Promise<void> {
    this.calls.push('close')
    this.closed = true
  }
}
