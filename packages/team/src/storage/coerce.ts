/**
 * THE CONVERSIONS THE SQL MODULES SHARE.
 *
 * Pure `unknown` → value functions, with no driver import and no SQL literal of
 * their own, so this module sits beside `driver.ts` rather than inside
 * `ports/` — `ports/` holds directories only, one per capability, and a helper
 * every port may use is not a capability.
 */

/**
 * Epoch milliseconds to an ISO-8601 UTC string with millisecond precision.
 *
 * Exported because it is the conversion `ts timestamptz` rests on and it is
 * what a test can actually falsify. `timestamptz` is microsecond-precision, so
 * milliseconds widen losslessly; the byte-fidelity claim ruling 5 makes rests on
 * `bindLine` (`ports/events/sql.ts`), not on this.
 */
export function toTimestamptz(tsMs: number): string {
  return new Date(tsMs).toISOString()
}

/** Postgres hands `timestamptz` back as a `Date`; a recorder or a text mode hands back a string. */
export function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'string') return new Date(value).getTime()
  return Number.NaN
}

export function toNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
