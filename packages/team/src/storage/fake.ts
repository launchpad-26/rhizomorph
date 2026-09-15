import type { TeamStorage } from './contract.js'
import { type EventsFake, createEventsFake } from './ports/events/fake.js'
import type {
  CollisionDelta,
  EventQuery,
  EventRow,
  LaneStateDelta,
  ProjectionDelta,
  SpendDelta,
} from './ports/events/port.js'
import { type IngestKeysFake, type IngestKeysFakeOptions, createIngestKeysFake } from './ports/ingest-keys/fake.js'
import type { IngestKeyRow } from './ports/ingest-keys/port.js'
import { type LifecycleFake, createLifecycleFake } from './ports/lifecycle/fake.js'
import { type MigrationsFake, type MigrationsFakeOptions, createMigrationsFake } from './ports/migrations/fake.js'
import type { AppliedMigration } from './ports/migrations/port.js'
import { type SettingsFakeOptions, createSettingsFake } from './ports/settings/fake.js'
import type { SettingsPort } from './ports/settings/port.js'

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
 *
 * **It is a composition root, not an implementation.** Every behaviour lives in
 * a port's own `ports/<port>/fake.ts`; what is left here is a shared call log,
 * the aliases the tests reach state through, and one delegation per port method.
 * The delegations are what make the composition load-bearing on this side:
 * remove one and `implements TeamStorage` fails with TS2420.
 */

/**
 * The intersection of the per-port option types, so a wave-9 port declares its
 * own options in its own file rather than editing this one.
 */
export type FakeTeamStorageOptions = SettingsFakeOptions & MigrationsFakeOptions & IngestKeysFakeOptions

export class FakeTeamStorage implements TeamStorage {
  /** Every port call, in order. `applyMigration` records its id. */
  readonly calls: string[] = []

  private readonly settingsPort: SettingsPort
  private readonly migrationsPort: MigrationsFake
  private readonly eventsPort: EventsFake
  private readonly keysPort: IngestKeysFake
  private readonly lifecyclePort: LifecycleFake

  // The port fakes' own objects, aliased rather than copied: tests mutate and
  // read them through that identity (`fake.failApply.clear()`,
  // `storage.ingestKeys.set(...)`, `storage.keyLookups.length = 0`).
  readonly events: EventRow[]
  readonly partitions: string[]
  /** `spend_by_project_day`, keyed `projectId day`. */
  readonly spend: Map<string, SpendDelta>
  /** `lane_state`, keyed `projectId lane`. */
  readonly lanes: Map<string, LaneStateDelta>
  /** `collisions`, keyed `projectId path`. */
  readonly collisions: Map<string, CollisionDelta>
  /** Migration ids whose apply throws. Mutable, so one fake can fail a run and succeed the next. */
  readonly failApply: Set<string>
  /** `ingest_keys`, keyed by hash. Ruling 8's rows, and never a plaintext. */
  readonly ingestKeys: Map<string, IngestKeyRow>
  /** Every hash {@link findIngestKey} was asked for, in order. */
  readonly keyLookups: string[]

  constructor(options: FakeTeamStorageOptions = {}) {
    this.settingsPort = createSettingsFake(this.calls, options)
    this.migrationsPort = createMigrationsFake(this.calls, options)
    this.eventsPort = createEventsFake(this.calls)
    this.keysPort = createIngestKeysFake(this.calls, options)
    this.lifecyclePort = createLifecycleFake(this.calls)

    this.events = this.eventsPort.events
    this.partitions = this.eventsPort.partitions
    this.spend = this.eventsPort.spend
    this.lanes = this.eventsPort.lanes
    this.collisions = this.eventsPort.collisions
    this.failApply = this.migrationsPort.failApply
    this.ingestKeys = this.keysPort.ingestKeys
    this.keyLookups = this.keysPort.keyLookups
  }

  /** Migration ids `applyMigration` was called with, in order — including the ones that threw. */
  get applyAttempts(): string[] {
    return this.calls.filter((c) => c.startsWith('applyMigration:')).map((c) => c.slice('applyMigration:'.length))
  }

  /** Ids that actually committed a `_migrations` row. */
  get committed(): string[] {
    return this.migrationsPort.committed
  }

  get migrationsTableExists(): boolean {
    return this.migrationsPort.migrationsTableExists
  }

  get closed(): boolean {
    return this.lifecyclePort.closed
  }

  /** See `ports/ingest-keys/fake.ts`. A setter as well as a getter: `api/api.test.ts` flips it between requests. */
  get failFindIngestKey(): boolean {
    return this.keysPort.failFindIngestKey
  }

  set failFindIngestKey(value: boolean) {
    this.keysPort.failFindIngestKey = value
  }

  readSetting(name: string): Promise<string> {
    return this.settingsPort.readSetting(name)
  }

  ensureMigrationsTable(): Promise<void> {
    return this.migrationsPort.ensureMigrationsTable()
  }

  listAppliedMigrations(): Promise<AppliedMigration[]> {
    return this.migrationsPort.listAppliedMigrations()
  }

  applyMigration(m: { id: string; checksum: string; sql: string }): Promise<void> {
    return this.migrationsPort.applyMigration(m)
  }

  appendEvents(
    rows: readonly EventRow[],
    projectionsFor?: (inserted: readonly EventRow[]) => ProjectionDelta,
  ): Promise<number> {
    return this.eventsPort.appendEvents(rows, projectionsFor)
  }

  readEvents(q: EventQuery): Promise<EventRow[]> {
    return this.eventsPort.readEvents(q)
  }

  ensureMonthlyPartition(month: string): Promise<void> {
    return this.eventsPort.ensureMonthlyPartition(month)
  }

  insertIngestKey(row: IngestKeyRow): Promise<void> {
    return this.keysPort.insertIngestKey(row)
  }

  findIngestKey(keyHash: string): Promise<IngestKeyRow | null> {
    return this.keysPort.findIngestKey(keyHash)
  }

  revokeIngestKeys(request: { projectId: string; exceptKeyHash?: string | undefined; atMs: number }): Promise<number> {
    return this.keysPort.revokeIngestKeys(request)
  }

  close(): Promise<void> {
    return this.lifecyclePort.close()
  }
}
