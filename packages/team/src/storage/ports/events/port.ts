import type { UnknownEventReason } from '@rhizomorph/core/src/events/index.js'

/** THE EVENTS PORT — ruling 5's events table and the three projections over it. */

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
  /**
   * Which verdict made this row unfoldable, or absent when the build folded it (ruling 16).
   *
   * A FOLD-TIME FACT, NOT A COLUMN. The adapter neither writes nor reads it: a `fold_status`
   * column is rejected by ruling 16, because it would spend the wave's single migration and
   * persist a fact about THIS BUILD's vocabulary as though it were a fact about the event. A row
   * read back through {@link EventsPort.readEvents} therefore has it absent, always — `line` is
   * the durable record, and a later build that can fold the type re-derives everything from it.
   *
   * Optional rather than `| null` for that reason: absent is the honest shape for a field that
   * does not round-trip through storage.
   */
  readonly unfoldable?: UnknownEventReason
}

/**
 * One day's spend for one project — the incremental half of
 * `spend_by_project_day`.
 *
 * `costUsd` and `events` are **deltas to add**, not totals: the upsert sums
 * them into whatever is already there. That is why they are derived from the
 * rows a transaction actually inserted rather than from the batch it was
 * handed — see {@link EventsPort.appendEvents}.
 */
export interface SpendDelta {
  readonly projectId: string
  /** UTC `YYYY-MM-DD`. */
  readonly day: string
  readonly costUsd: number
  readonly events: number
}

/** One lane's latest observed state — the incremental half of `lane_state`. */
export interface LaneStateDelta {
  readonly projectId: string
  readonly lane: string
  /** `null` when this batch carried no `agent.status` for the lane: the stored state is then left alone. */
  readonly state: string | null
  readonly worktree: string | null
  /** Epoch milliseconds of the newest event this batch carried for the lane. */
  readonly lastEventTsMs: number
}

/** One path and the lanes seen touching it — the incremental half of `collisions`. */
export interface CollisionDelta {
  readonly projectId: string
  readonly path: string
  /** Distinct and sorted. Unioned with whatever the row already holds. */
  readonly lanes: readonly string[]
  readonly firstSeenMs: number
  readonly lastSeenMs: number
}

/**
 * Everything the three projections need for one transaction, as plain data.
 *
 * This type is ruling 5's answer to ruling 4's second ordering: keeping the
 * projections inside the same transaction as the insert costs the port no SQL
 * string, no fragment, no driver type and no promise. It is a value and a pure
 * function over rows, and that is all.
 */
export interface ProjectionDelta {
  readonly spend: readonly SpendDelta[]
  readonly lanes: readonly LaneStateDelta[]
  readonly collisions: readonly CollisionDelta[]
}

/** A half-open-by-inclusive read of one actor's ledger window. */
export interface EventQuery {
  readonly projectId: string
  readonly actorInstance: string
  readonly fromN: number
  readonly toN: number
}

export interface EventsPort {
  /**
   * Ruling 4's second ordering, made expressible: one transaction, all rows or
   * none. Returns **the number of rows actually inserted** — 0 for a complete
   * replay, because the insert dedups on `(project_id, actor_instance, n)`.
   *
   * `projectionsFor` is called **inside** that transaction, with exactly the
   * rows that landed, and its result is upserted before the commit. Two things
   * about that are load-bearing:
   *
   * - **It is a callback rather than a value the caller computes.**
   *   `spend_by_project_day.cost_usd` is a sum, and a delta derived from the
   *   *batch* double-counts on every replay: the events dedup and the money
   *   does not. Only the transaction knows which rows landed.
   * - **It is pure `(rows) => plain data`.** Nothing about SQL, the driver or
   *   the transaction reaches it, so ruling 5's boundary is intact.
   *
   * A caller that omits it inserts events and maintains no projection — which
   * is what the migration runner's own tests want, and what the fold worker
   * never does.
   *
   * **The month's partition is derived inside the adapter**, from `tsMs`. A
   * caller naming a partition would be a physical storage detail leaking past
   * the port, which is precisely what ruling 5 forbids.
   */
  appendEvents(
    rows: readonly EventRow[],
    projectionsFor?: (inserted: readonly EventRow[]) => ProjectionDelta,
  ): Promise<number>

  readEvents(q: EventQuery): Promise<EventRow[]>

  /** Tops the monthly window up. `month` is `YYYY-MM`. Idempotent. Wave 3 schedules it. */
  ensureMonthlyPartition(month: string): Promise<void>
}
