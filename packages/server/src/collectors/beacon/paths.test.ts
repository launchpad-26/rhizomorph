import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sessionDirFor } from '../../log/paths.js'
import { beaconDirFor } from './paths.js'

describe('beaconDirFor (ADR-0036)', () => {
  it('keeps beacon files beside the repo recording under the configured data root', () => {
    expect(beaconDirFor('/repo', '/data')).toBe(path.join(sessionDirFor('/repo', '/data'), 'beacons'))
  })

  it('gives two repos that share a basename two different directories — the slug carries a hash', () => {
    expect(beaconDirFor('/one/rhizomorph', '/data')).not.toBe(beaconDirFor('/two/rhizomorph', '/data'))
  })

  it('lives under the data root, never inside the watched repo — asked with path.relative, so a win32 separator cannot fake a miss', () => {
    const dir = beaconDirFor('/repo', '/data')
    const fromRoot = path.relative('/data', dir)
    expect(fromRoot.startsWith('..')).toBe(false)
    expect(path.isAbsolute(fromRoot)).toBe(false)
    expect(path.relative('/repo', dir).startsWith('..')).toBe(true)
  })
})
