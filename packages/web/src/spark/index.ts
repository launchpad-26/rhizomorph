/**
 * The sparkline: the honest bucketing underneath it, and the component that
 * draws it.
 *
 * `bucketizeSeries` itself moved to `@rhizomorph/core` in #509 — the fleet
 * table's spark is derived in `core` by `buildFleet` and the ledger's is
 * derived here, so a function both of them read cannot live in `web`. It is
 * re-exported here so `panels/ledger/sparkline.ts` keeps importing it from
 * this barrel unchanged, and so the two sparklines can never bucket the same
 * events two different ways.
 */

export { bucketizeSeries } from '@rhizomorph/core'
export type { BucketizeOptions, SeriesEvent } from '@rhizomorph/core'
export { Sparkline } from './Sparkline.js'
export type { SparklineProps } from './Sparkline.js'
