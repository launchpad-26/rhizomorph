import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sessionDirFor } from '../../log/paths.js'
import { isInside } from '../../paths/containment.js'
import { beaconDirFor } from './paths.js'

/**
 * `/repo` and `/data` do not exist, and this assertion is about the shape of
 * the path rather than about symlinks, so `isInside` is given the identity
 * canonicalizer and stays purely lexical. It is still the repo's one
 * containment primitive (prd-42 ruling 2, `paths/containment.ts`) rather than
 * a hand-rolled `path.relative(...).startsWith('..')` — that idiom is the
 * known debt `paths/prefix-comparison-law.test.ts` pins, and reinventing it
 * here raised the pin instead of asking the primitive.
 */
const lexical = (candidate: string): string => candidate

describe('beaconDirFor (ADR-0036)', () => {
  it('keeps beacon files beside the repo recording under the configured data root', () => {
    expect(beaconDirFor('/repo', '/data')).toBe(path.join(sessionDirFor('/repo', '/data'), 'beacons'))
  })

  it('gives two repos that share a basename two different directories — the slug carries a hash', () => {
    expect(beaconDirFor('/one/rhizomorph', '/data')).not.toBe(beaconDirFor('/two/rhizomorph', '/data'))
  })

  it('lives under the data root, never inside the watched repo — asked through the containment primitive, so a win32 separator cannot fake either answer', () => {
    const dir = beaconDirFor('/repo', '/data')
    expect(isInside('/data', dir, lexical)).toBe(true)
    expect(isInside('/repo', dir, lexical)).toBe(false)
  })
})
