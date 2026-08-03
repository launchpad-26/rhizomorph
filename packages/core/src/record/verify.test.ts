import { describe, expect, it } from 'vitest'
import { fixtureSession } from '../fixtures.js'
import { buildRecord } from './build.js'
import { verifyRecord } from './verify.js'

const ACTOR = { instance: 'session-alice-1', handle: 'alice', declared: true }

function tamperedRecord() {
  return buildRecord(fixtureSession(), { repoSlug: 'rhizomorph-abc123', actor: ACTOR })
}

describe('verifyRecord', () => {
  it('names the exact line a single flipped byte broke', () => {
    const record = tamperedRecord()
    const tamperIndex = 3
    const tampered = JSON.parse(JSON.stringify(record))
    const original = tampered.body[tamperIndex]!.line
    // Flip one character in the JSON text — same length, different content,
    // so this is purely a content tamper, not a truncation.
    tampered.body[tamperIndex] = {
      ...tampered.body[tamperIndex]!,
      line: `${original.slice(0, -2)}${original.at(-2) === 'a' ? 'b' : 'a'}${original.at(-1)}`,
    }

    const result = verifyRecord(tampered)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected verification to fail')
    expect(result.reason).toBe('chain-broken')
    expect(result.lineNumber).toBe(tamperIndex + 1)
  })

  it('catches a tampered manifest.eventCount even though every line hashes clean', () => {
    const record = tamperedRecord()
    const tampered = JSON.parse(JSON.stringify(record))
    tampered.manifest.eventCount += 1

    const result = verifyRecord(tampered)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected verification to fail')
    expect(result.reason).toBe('manifest-mismatch')
    expect(result.detail).toContain('eventCount')
  })

  it('catches a tampered manifest.chainDigest', () => {
    const record = tamperedRecord()
    const tampered = JSON.parse(JSON.stringify(record))
    tampered.manifest.chainDigest = tampered.manifest.chainDigest.startsWith('a')
      ? `b${tampered.manifest.chainDigest.slice(1)}`
      : `a${tampered.manifest.chainDigest.slice(1)}`

    const result = verifyRecord(tampered)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected verification to fail')
    expect(result.reason).toBe('chain-broken')
  })

  it('catches a tampered actor.instance — it changes the genesis, breaking line 1', () => {
    const record = tamperedRecord()
    const tampered = JSON.parse(JSON.stringify(record))
    tampered.manifest.actor = { ...tampered.manifest.actor, instance: 'session-mallory-1' }

    const result = verifyRecord(tampered)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected verification to fail')
    expect(result.reason).toBe('chain-broken')
    expect(result.lineNumber).toBe(1)
  })

  it('accepts an untampered record', () => {
    const record = tamperedRecord()
    expect(verifyRecord(record)).toEqual({ ok: true })
  })
})
