import type { RetentionCeiling, RetentionPort } from './port.js'

export interface RetentionFakeOptions {
  /**
   * The partitions this database has, `events_YYYY_MM`.
   *
   * Seeded rather than derived, because the question every retention test asks
   * is *"what does the sweep do to a database that already has these months?"*
   * and building them through `ensureMonthlyPartition` would make the setup the
   * thing under test. Defaults to none — a deployment that has never ingested.
   */
  readonly eventPartitions?: readonly string[]
  /** Ceilings already named, as an admin's earlier run of `deploy/ceiling.ts` would have left them. */
  readonly ceilings?: readonly RetentionCeiling[]
}

export interface RetentionFake extends RetentionPort {
  /** `retention_ceilings`, keyed by project. Empty is the shipped state and means nothing is dropped. */
  readonly ceilings: Map<string, RetentionCeiling>
  /** The partitions that still exist. A drop removes a name from here. */
  readonly eventPartitions: string[]
  /** Every name {@link RetentionPort.dropEventPartition} was called with, in order — including no-ops. */
  readonly droppedPartitions: string[]
}

/**
 * THE RETENTION DOUBLE, AND IT IS NOT KINDER THAN THE ADAPTER.
 *
 * Three places where a kinder double would make the tests above it a lie, so
 * each matches the SQL module deliberately:
 *
 * - **`nameCeiling` overwrites every column, provenance included.** The adapter's
 *   `ON CONFLICT ... DO UPDATE` moves `set_by`, `source` and `set_at` too, so a
 *   double that merged would let a re-name keep the first admin's name while
 *   claiming ruling 9 is satisfied.
 * - **`dropEventPartition` on a name that is not there changes nothing and does
 *   not throw.** The adapter ships `DROP TABLE IF EXISTS`, so a racing manual
 *   drop is a no-op there; a double that threw would invent a failure mode the
 *   real sweep cannot meet.
 * - **`dropEventPartition` validates the name first.** The adapter refuses
 *   anything but `events_YYYY_MM` before a character reaches DDL. A double that
 *   accepted `events` would let a test prove a sweep safe that would have
 *   dropped the whole table on a real host.
 */
const PARTITION_RE = /^events_\d{4}_(?:0[1-9]|1[0-2])$/

export function createRetentionFake(calls: string[], options: RetentionFakeOptions): RetentionFake {
  const ceilings = new Map<string, RetentionCeiling>()
  for (const ceiling of options.ceilings ?? []) ceilings.set(ceiling.projectId, ceiling)
  const eventPartitions = [...(options.eventPartitions ?? [])]
  const droppedPartitions: string[] = []

  return {
    ceilings,
    eventPartitions,
    droppedPartitions,

    async readCeilings(): Promise<RetentionCeiling[]> {
      calls.push('readCeilings')
      return [...ceilings.values()].sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0))
    },

    async nameCeiling(ceiling: RetentionCeiling): Promise<void> {
      calls.push('nameCeiling')
      ceilings.set(ceiling.projectId, ceiling)
    },

    async clearCeiling(projectId: string): Promise<boolean> {
      calls.push('clearCeiling')
      return ceilings.delete(projectId)
    },

    async listEventPartitions(): Promise<string[]> {
      calls.push('listEventPartitions')
      return [...eventPartitions].sort()
    },

    async dropEventPartition(partition: string): Promise<void> {
      calls.push('dropEventPartition')
      if (!PARTITION_RE.test(partition)) {
        throw new Error(
          `dropEventPartition: refusing ${JSON.stringify(partition)} — only an events_YYYY_MM partition may be dropped`,
        )
      }
      droppedPartitions.push(partition)
      const at = eventPartitions.indexOf(partition)
      if (at !== -1) eventPartitions.splice(at, 1)
    },
  }
}
