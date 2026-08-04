import { describe, expect, it } from 'vitest'
import { bucketizeSeries } from './bucketize.js'

const NOW = 1_000_000
const WINDOW_MS = 30 * 60_000
const BUCKETS = 10
const BUCKET_MS = WINDOW_MS / BUCKETS

describe('bucketizeSeries', () => {
  it('sums event values into the bucket their timestamp falls in', () => {
    const series = bucketizeSeries(
      [
        { ts: NOW - WINDOW_MS + 1, value: 5 }, // first bucket
        { ts: NOW - WINDOW_MS + 1, value: 3 }, // same bucket, sums
        { ts: NOW, value: 7 }, // last bucket
      ],
      { now: NOW, windowMs: WINDOW_MS, bucketCount: BUCKETS, sinceTs: null },
    )

    expect(series).toHaveLength(BUCKETS)
    expect(series[0]).toBe(8)
    expect(series[BUCKETS - 1]).toBe(7)
    expect(series.slice(1, BUCKETS - 1)).toEqual(new Array(BUCKETS - 2).fill(0))
  })

  it('drops events outside the window entirely', () => {
    const series = bucketizeSeries(
      [
        { ts: NOW - WINDOW_MS - 1, value: 99 }, // just before the window
        { ts: NOW + 1, value: 99 }, // in the future
      ],
      { now: NOW, windowMs: WINDOW_MS, bucketCount: BUCKETS, sinceTs: null },
    )

    expect(series.every((value) => value === 0)).toBe(true)
  })

  it('trims leading buckets to the subject\'s own lifetime — the honesty gate', () => {
    // Lifetime started three bucket-widths into the window: the first three
    // buckets have no subject to have been silent, so they must not appear.
    const sinceTs = NOW - WINDOW_MS + BUCKET_MS * 3
    const series = bucketizeSeries([{ ts: NOW, value: 4 }], {
      now: NOW,
      windowMs: WINDOW_MS,
      bucketCount: BUCKETS,
      sinceTs,
    })

    expect(series).toHaveLength(BUCKETS - 3)
    expect(series.at(-1)).toBe(4)
  })

  it('returns an empty series when the subject only came alive after the window ended', () => {
    const series = bucketizeSeries([], {
      now: NOW,
      windowMs: WINDOW_MS,
      bucketCount: BUCKETS,
      sinceTs: NOW + 1,
    })
    expect(series).toEqual([])
  })

  it('never fabricates data for an empty event list — every real bucket is a real zero', () => {
    const series = bucketizeSeries([], {
      now: NOW,
      windowMs: WINDOW_MS,
      bucketCount: BUCKETS,
      sinceTs: null,
    })
    expect(series).toEqual(new Array(BUCKETS).fill(0))
  })
})
