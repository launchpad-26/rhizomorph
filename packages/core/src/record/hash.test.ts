import { describe, expect, it } from 'vitest'
import { sha256Hex } from './hash.js'

describe('sha256Hex', () => {
  it('matches the known digest of the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('matches the known digest of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('is deterministic and sensitive to every byte', async () => {
    const a = await sha256Hex('rhizomorph')
    const b = await sha256Hex('rhizomorpH')
    expect(a).not.toBe(b)
    expect(await sha256Hex('rhizomorph')).toBe(a)
  })

  it('returns a 64-character lowercase hex string', async () => {
    const digest = await sha256Hex('anything')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })
})
