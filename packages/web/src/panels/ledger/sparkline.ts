import type { UsageRecord } from '@rhizomorph/core'
import { bucketizeSeries, type SeriesEvent } from '../../spark/index.js'

/**
 * #159 — the TOKENS cell's own sparkline: a trailing half hour of a branch's
 * output-token history, sliced the same way the fleet table's OUTPUT column
 * slices a lane's (`fleet/buildFleet.ts`'s `SPARK_WINDOW_MS`/`SPARK_BUCKET_COUNT`)
 * — the two surfaces read different rows (branch here, lane there) but the
 * same window, so a reader who has learned one spark's shape reads the
 * other without a second lesson.
 *
 * Unlike the fleet table, the ledger never joins `state.telemetry.usage` by
 * origin (`row.tokens.output`, the number this spark sits beside, is already
 * unfiltered — `selectSpendByBranch` counts every origin), so this stays
 * unfiltered too: a filtered spark beside an unfiltered headline would draw a
 * shape the number itself does not agree with.
 */
export const LEDGER_SPARK_WINDOW_MS = 30 * 60_000
export const LEDGER_SPARK_BUCKET_COUNT = 10

/** Every usage record with a known branch, grouped for O(1) lookup per row. */
export function usageEventsByBranch(usage: readonly UsageRecord[]): Map<string, SeriesEvent[]> {
  const byBranch = new Map<string, SeriesEvent[]>()
  for (const record of usage) {
    if (record.branch === null) continue
    const list = byBranch.get(record.branch) ?? []
    list.push({ ts: record.ts, value: record.tokens.output })
    byBranch.set(record.branch, list)
  }
  return byBranch
}

/** A branch row's own honest spark: trimmed to `sinceTs` (the row's own `firstTs`). */
export function branchOutputSpark(
  events: readonly SeriesEvent[],
  now: number,
  sinceTs: number | null,
): number[] {
  return bucketizeSeries(events, {
    now,
    windowMs: LEDGER_SPARK_WINDOW_MS,
    bucketCount: LEDGER_SPARK_BUCKET_COUNT,
    sinceTs,
  })
}
