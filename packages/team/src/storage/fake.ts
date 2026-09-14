import type {
  AppliedMigration,
  CollisionDelta,
  EventQuery,
  EventRow,
  IngestKeyRow,
  LaneStateDelta,
  ProjectionDelta,
  SpendDelta,
  TeamStorage,
} from './contract.js'

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
  /**
   * Makes {@link FakeTeamStorage.findIngestKey} throw — a database that cannot
   * answer *"is this key revoked?"*.
   *
   * Not a kindness for the sake of coverage: the only safe answer to that
   * question going unanswered is to refuse the batch, and the tempting
   * implementation accepts it because the `catch` sits one level above the
   * check. Mutable, so one fake can fail a request and serve the next.
   */
  readonly failFindIngestKey?: boolean
}

export class FakeTeamStorage implements TeamStorage {
  /** Every port call, in order. `applyMigration` records its id. */
  readonly calls: string[] = []
  readonly events: EventRow[] = []
  readonly partitions: string[] = []
  /** `spend_by_project_day`, keyed `projectId day`. */
  readonly spend = new Map<string, SpendDelta>()
  /** `lane_state`, keyed `projectId lane`. */
  readonly lanes = new Map<string, LaneStateDelta>()
  /** `collisions`, keyed `projectId path`. */
  readonly collisions = new Map<string, CollisionDelta>()
  /** The unique index each partition carries: `projectId actorInstance n`. */
  private readonly positions = new Set<string>()
  migrationsTableExists = false
  closed = false

  /** Migration ids whose apply throws. Mutable, so one fake can fail a run and succeed the next. */
  readonly failApply: Set<string>

  /** `ingest_keys`, keyed by hash. Ruling 8's rows, and never a plaintext. */
  readonly ingestKeys = new Map<string, IngestKeyRow>()
  /**
   * Every hash {@link findIngestKey} was asked for, in order.
   *
   * This is what "checked once per batch" is asserted against: its LENGTH after
   * a multi-event batch is 1, and after two batches it is 2. A call log is the
   * only way to falsify "once per event" and "cached across batches" at once —
   * both produce correct responses and a different number of reads.
   */
  readonly keyLookups: string[] = []
  /** See {@link FakeTeamStorageOptions.failFindIngestKey}. */
  failFindIngestKey: boolean

  private readonly settings: Readonly<Record<string, string>>
  private readonly applied: AppliedMigration[]

  constructor(options: FakeTeamStorageOptions = {}) {
    this.settings = options.settings ?? {}
    this.failApply = new Set(options.failApply ?? [])
    this.applied = [...(options.applied ?? [])]
    this.failFindIngestKey = options.failFindIngestKey ?? false
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

  /**
   * Dedups on `(projectId, actorInstance, n)` and maintains the projections,
   * because the adapter does and this double must not be kinder than it.
   *
   * A fake that appended unconditionally would make every replay test above it
   * a lie: the fold's whole rewind story is "a replay costs time, not rows",
   * and against a double that duplicates, a test asserting N rows after two
   * folds would have to assert 2N to pass — i.e. it would certify the defect.
   */
  async appendEvents(
    rows: readonly EventRow[],
    projectionsFor?: (inserted: readonly EventRow[]) => ProjectionDelta,
  ): Promise<number> {
    this.calls.push('appendEvents')
    const inserted: EventRow[] = []
    for (const row of rows) {
      const key = `${row.projectId} ${row.actorInstance} ${row.n}`
      if (this.positions.has(key)) continue
      this.positions.add(key)
      this.events.push(row)
      inserted.push(row)
    }
    if (projectionsFor) this.applyProjections(projectionsFor(inserted))
    return inserted.length
  }

  /** The three projections, folded the way the adapter's upserts would. */
  private applyProjections(delta: ProjectionDelta): void {
    for (const spend of delta.spend) {
      const key = `${spend.projectId} ${spend.day}`
      const current = this.spend.get(key)
      this.spend.set(key, {
        projectId: spend.projectId,
        day: spend.day,
        costUsd: (current?.costUsd ?? 0) + spend.costUsd,
        events: (current?.events ?? 0) + spend.events,
      })
    }
    for (const lane of delta.lanes) {
      const key = `${lane.projectId} ${lane.lane}`
      const current = this.lanes.get(key)
      // The adapter's `WHERE EXCLUDED.last_event_ts >= lane_state.last_event_ts`.
      if (current && lane.lastEventTsMs < current.lastEventTsMs) continue
      this.lanes.set(key, {
        projectId: lane.projectId,
        lane: lane.lane,
        state: lane.state ?? current?.state ?? 'unknown',
        worktree: lane.worktree ?? current?.worktree ?? null,
        lastEventTsMs: lane.lastEventTsMs,
      })
    }
    for (const collision of delta.collisions) {
      const key = `${collision.projectId} ${collision.path}`
      const current = this.collisions.get(key)
      this.collisions.set(key, {
        projectId: collision.projectId,
        path: collision.path,
        lanes: [...new Set([...(current?.lanes ?? []), ...collision.lanes])].sort(),
        firstSeenMs: Math.min(current?.firstSeenMs ?? collision.firstSeenMs, collision.firstSeenMs),
        lastSeenMs: Math.max(current?.lastSeenMs ?? collision.lastSeenMs, collision.lastSeenMs),
      })
    }
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

  /**
   * Idempotent on the hash, because the adapter's insert is
   * `ON CONFLICT (key_hash) DO NOTHING` and this double must not be kinder than
   * it. A re-seed that overwrote the row would silently un-revoke a revoked key.
   */
  async insertIngestKey(row: IngestKeyRow): Promise<void> {
    this.calls.push('insertIngestKey')
    if (this.ingestKeys.has(row.keyHash)) return
    this.ingestKeys.set(row.keyHash, row)
  }

  async findIngestKey(keyHash: string): Promise<IngestKeyRow | null> {
    this.calls.push('findIngestKey')
    this.keyLookups.push(keyHash)
    if (this.failFindIngestKey) {
      throw new Error('the fake storage was told to fail the ingest key read')
    }
    return this.ingestKeys.get(keyHash) ?? null
  }

  /**
   * Skips rows that are already revoked, so `revokedAtMs` records when the key
   * was retired rather than when a boot last noticed — the adapter's predicate
   * says the same thing with `revoked_at IS NULL`.
   */
  async revokeIngestKeys(request: {
    projectId: string
    exceptKeyHash?: string | undefined
    atMs: number
  }): Promise<number> {
    this.calls.push('revokeIngestKeys')
    let changed = 0
    for (const [hash, row] of this.ingestKeys) {
      if (row.projectId !== request.projectId) continue
      if (row.revokedAtMs !== null) continue
      if (request.exceptKeyHash !== undefined && hash === request.exceptKeyHash) continue
      this.ingestKeys.set(hash, { ...row, revokedAtMs: request.atMs })
      changed += 1
    }
    return changed
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
