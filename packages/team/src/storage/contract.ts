/**
 * THE STORAGE PORT (prd-51 ruling 5).
 *
 * Ruling 5 puts the team server's storage on Postgres and keeps one discipline
 * from the SQLite-first design it deviates from: **storage behind an interface,
 * no SQL in route handlers** — so the engine stays a re-deployment rather than a
 * rewrite. This module is that interface.
 *
 * Three things it deliberately is NOT:
 *
 * - **It is not a driver.** Nothing here imports `postgres`, names a driver
 *   type, or returns one. `no-sql-outside-storage-law.test.ts` holds that as a
 *   grep law over this package's sources.
 * - **It is not a query.** No method takes or returns a SQL string, a fragment,
 *   or a builder. Everything crossing this boundary is plain data.
 * - **It is not the ingest route.** Ruling 4's ordering — journal, then
 *   `BEGIN` → insert → `COMMIT`, and only *then* the cursor — is a constraint on
 *   the caller. The port only has to make "one transaction that either wrote the
 *   batch or wrote nothing" expressible, which is what {@link TeamStorage.appendEvents}
 *   is. When it is called, and what happens either side of it, is the ingest
 *   issue's (wave 3).
 *
 * There is no `node:*` here either, and no dependency at all.
 */

/**
 * A value the server will later report as effective (ruling 9).
 *
 * Every configured value names who set it and where, **even where the only
 * setter today is a default** — that is the whole of ruling 9. A default whose
 * provenance is "it is just the default" is the one an operator cannot find.
 */
export interface EffectiveValue<T> {
  /** The field's own name, as a report would print it. */
  readonly name: string
  readonly value: T
  readonly setBy: 'default' | 'environment'
  /** WHERE it was set: a tracked path for a default, an env var name for an override. */
  readonly source: string
  /** What a report may print. Never a secret. */
  readonly display: string
}

/** One row of the runner's own bookkeeping table. */
export interface AppliedMigration {
  /** The migration's id, e.g. `0001_events`. */
  readonly id: string
  /** sha-256 hex of the file text, `\r\n` normalised to `\n` first. */
  readonly checksum: string
  /** ISO-8601 UTC. */
  readonly appliedAt: string
}

/**
 * One row of ruling 5's events table, as the caller hands it over.
 *
 * The write key is `(projectId, actorInstance, n)` — wave 1's
 * `packages/core/src/wire/protocol.ts`, where `n` is a ledger position and
 * never an event id. `eventId` is carried because ruling 5's column list says
 * so; it is stored and never keyed, because event ids restart on session resume
 * and keying on one discarded 74.5 % of a real ledger
 * (`docs/research/2026-08-28-shared-record-s2-shipper.md`).
 */
export interface EventRow {
  readonly projectId: string
  readonly actorInstance: string
  /** The wire's ledger position. Never an event id, never an array index. */
  readonly n: number
  /** Stored because ruling 5 says so. Never a key — see this interface's note. */
  readonly eventId: string
  /** Epoch milliseconds, core's `timestampSchema`. The adapter converts. */
  readonly tsMs: number
  readonly type: string
  readonly source: string
  readonly lane: string | null
  readonly worktree: string | null
  /** Serialized to `jsonb` by the adapter. */
  readonly payload: unknown
  /**
   * VERBATIM. The line `buildRecord` would serialize
   * (`packages/core/src/wire/reserialize.ts`). Nothing may transform it —
   * ruling 5 rests the whole re-export-and-re-verify claim on these bytes.
   */
  readonly line: string
}

/** A half-open-by-inclusive read of one actor's ledger window. */
export interface EventQuery {
  readonly projectId: string
  readonly actorInstance: string
  readonly fromN: number
  readonly toN: number
}

/** The refusal shape this package uses, following `parseIngestRequest` in core's wire. */
export type StorageResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Everything the server can ask a database. No SQL crosses this boundary —
 * not as a string, not as a fragment, not as an object.
 */
export interface TeamStorage {
  /**
   * Reads one Postgres GUC by name. The preflight's only read (ruling 4).
   * Returns the empty string when the setting is unknown.
   */
  readSetting(name: string): Promise<string>

  /** Creates the runner's own bookkeeping table if it is absent. Idempotent. */
  ensureMigrationsTable(): Promise<void>

  listAppliedMigrations(): Promise<AppliedMigration[]>

  /** The migration's statements and its bookkeeping row in ONE transaction: both, or neither. */
  applyMigration(m: { id: string; checksum: string; sql: string }): Promise<void>

  /**
   * Ruling 4's second ordering, made expressible: one transaction, all rows or
   * none. Returns the number of rows written.
   */
  appendEvents(rows: readonly EventRow[]): Promise<number>

  readEvents(q: EventQuery): Promise<EventRow[]>

  /** Tops the monthly window up. `month` is `YYYY-MM`. Idempotent. Wave 3 schedules it. */
  ensureMonthlyPartition(month: string): Promise<void>

  close(): Promise<void>
}
