/**
 * Turning a scatter of timestamped values into the fixed-width series a
 * sparkline draws. The drawing itself is `web`'s — this is only the honest
 * arithmetic underneath it, kept here because both the fleet table's spark and
 * the ledger's read the same function (#509).
 */

export { bucketizeSeries } from './bucketize.js'
export type { BucketizeOptions, SeriesEvent } from './bucketize.js'
