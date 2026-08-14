import { bucketizeSeries as coreBucketizeSeries } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { bucketizeSeries } from './index.js'

/**
 * #509 — `bucketizeSeries` had two copies: one in `core` feeding
 * `buildFleet`'s `recentOutputTokens`, one here feeding the ledger sparkline.
 * They were code-identical when the second was written and would have stayed
 * that way exactly until someone fixed a bucketing edge case in one of them.
 *
 * Identity, not behaviour, is the assertion that can catch that. Two copies
 * agreeing on every input this file could think to try is precisely the state
 * the duplicate was already in; only `toBe` distinguishes "the same function"
 * from "a function that currently agrees".
 */
describe('bucketizeSeries has one home (#509)', () => {
  it('is core\'s own function, re-exported — not a second copy that merely agrees', () => {
    expect(bucketizeSeries).toBe(coreBucketizeSeries)
  })
})
