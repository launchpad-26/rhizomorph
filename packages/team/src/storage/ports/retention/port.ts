/**
 * THE RETENTION PORT — the admin's ceiling, and the partitions it decides over
 * (prd-51 rulings 9 and 10, ruling B of the 2026-09-16 amendment).
 *
 * Five methods split into two halves that deliberately do not know about each
 * other:
 *
 * - **the ceiling** — read, name, clear. Written only by
 *   `packages/team/deploy/ceiling.ts`, an admin act on the host. Ruling B: the
 *   ceiling is named by a command beside `deploy/init.sh` and **not by a route**.
 * - **the partitions** — list and drop. Read and acted on only by
 *   `sweepRetention` in `packages/team/src/fold/worker.ts`.
 *
 * Nothing here takes or returns a SQL string, a fragment or a partition
 * predicate: a partition NAME crosses this boundary because it is the identity
 * of a stored object the admin's report has to be able to print, which is the
 * same reason `EventsPort.ensureMonthlyPartition` takes a month.
 */

/**
 * One project's ceiling, exactly as `retention_ceilings` stores it.
 *
 * {@link setBy} and {@link source} are not decoration and are not nullable
 * anywhere — in this type, in the migration, or in the command that writes them.
 * Ruling 9: *"Every effective value on the server names who set it and where"*,
 * and the clause that matters is the one an implementation drops: **including
 * where the setter is a default**. The default here — no row at all — names its
 * setter through {@link NO_CEILING_SOURCE} rather than through a row, because
 * the absence of a row is itself the value.
 */
export interface RetentionCeiling {
  readonly projectId: string
  /** Strictly positive. The migration's CHECK says so too, so neither side is the only guard. */
  readonly maxAgeDays: number
  /**
   * The admin's archive choice, made ONCE at ceiling time (ruling 10).
   *
   * `true` **withholds every drop**, naming this project. The server does not
   * archive: ruling 11's `seal → archive → verify → tombstone → prune` is a
   * different act on a different machine and is *"not triggered by anything the
   * server decides"*. So the honest behaviour for an admin who asked for an
   * archive first is to stop, say which partitions are waiting, and let them do
   * it — never to drop anyway, and never to silently pretend it archived.
   */
  readonly archiveBeforeDrop: boolean
  /** Where the admin said they would archive to. `null` exactly when {@link archiveBeforeDrop} is false. */
  readonly archiveDir: string | null
  /** WHO named it (ruling 9). Never empty — the command refuses rather than guessing. */
  readonly setBy: string
  /** WHERE they named it (ruling 9): a tracked path, or the host command's own name. */
  readonly source: string
  readonly setAtMs: number
}

/**
 * WHERE THE "no ceiling" DEFAULT IS SET.
 *
 * Ruling 9 applies to defaults too, and a default whose provenance is *"it is
 * just the default"* is the one an operator cannot find. So the no-ceiling
 * verdict names this module as its setter, by tracked path, the same way
 * `config/config.ts`'s `DEFAULTS_SOURCE` does for its own defaults. An operator
 * reading *"nothing is dropped"* can open the file that decided it.
 */
export const NO_CEILING_SOURCE = 'packages/team/src/storage/ports/retention/port.ts'

/**
 * THE STORAGE QUOTA, IN THE HONEST-GAP VOICE (ruling 9).
 *
 * Ruling 9 lets the admin name two ceilings: an age, and *"a storage quota per
 * project"*. This deployment can enforce the first and cannot measure the
 * second, and the difference has a physical cause rather than a missing feature:
 * `events` is `PARTITION BY RANGE (ts)` (`0001_events.sql`), so a partition's
 * size is a fact about a month and never about a project. Attributing bytes to a
 * project would need a scan of every row in every partition, which nothing here
 * does.
 *
 * Said out loud, in one constant, printed by `deploy/ceiling.ts` in **both**
 * states — with a ceiling named and without one — because a gap that only
 * appears in the empty case is a gap the operator sees exactly once.
 */
export const RETENTION_QUOTA_GAP =
  'storage quota per project: NOT KNOWN. events is partitioned by ts and not by project ' +
  '(migrations/0001_events.sql), so this server cannot attribute bytes to a project without a ' +
  'scan it does not do. What it can name is the partition list above. No per-project quota is ' +
  'enforced and nothing here pretends one is.'

export interface RetentionPort {
  /** Every ceiling an admin has named, ordered by project. Empty is the shipped state. */
  readCeilings(): Promise<RetentionCeiling[]>

  /**
   * Names, or re-names, one project's ceiling.
   *
   * An upsert, and it overwrites {@link RetentionCeiling.setBy},
   * {@link RetentionCeiling.source} and {@link RetentionCeiling.setAtMs} along
   * with the age: the effective value names the admin who set it **last**, not
   * the one who set it first. A provenance that records the first setter would
   * be a value an operator cannot find, which is the failure ruling 9 exists to
   * close.
   */
  nameCeiling(ceiling: RetentionCeiling): Promise<void>

  /** Removes a project's ceiling. `true` when there was one to remove. */
  clearCeiling(projectId: string): Promise<boolean>

  /** Every `events_YYYY_MM` partition that currently exists, sorted — which is oldest first. */
  listEventPartitions(): Promise<string[]>

  /**
   * Ruling 10's `DROP PARTITION`. Never a `DELETE`.
   *
   * prd-51's evidence measures 3.53 s with the bytes returned immediately
   * against 17.6 s and two lock windows for the `DELETE` — which is why the
   * verdict is about a whole partition and never about a row.
   */
  dropEventPartition(partition: string): Promise<void>
}
