import { describe, expect, it } from 'vitest'
import { fixtureSession } from '../fixtures.js'
import { buildRecord } from './build.js'
import { withLinesAt } from './read.test.js'
import { verifyRecord } from './verify.js'

const ACTOR = { instance: 'session-alice-1', handle: 'alice', declared: true }

/** A line the way a NEWER era's instrument would write it — prd17 ruling 1's own families. */
const FUTURE_LINE =
  '{"id":"evt-future-1","ts":1785930000000,"source":"system","type":"summons.raised","payload":{"lane":"a"}}'

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

/**
 * prd17 ruling 3, item 1 — the portable-record half. This function used to
 * REFUSE THE WHOLE ARTIFACT over one line it did not recognise: a foreign
 * actor's record from a later version of the same instrument was unreplayable,
 * and the operator was told only "verification failed (malformed-line)".
 *
 * Now: verify the chain, count the unknowns, voice them.
 */
describe('verifyRecord — a newer era is voiced, not refused', () => {
  it('verifies a record carrying a family this era has never heard of', () => {
    const result = verifyRecord(withLinesAt(tamperedRecord(), 2, [FUTURE_LINE]))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.detail)
    expect(result.unknown ?? []).toHaveLength(1)
    expect(result.unknown?.[0]?.line).toBe(FUTURE_LINE)
    expect(result.unknownVoice).toBe(
      '1 event from a newer era was preserved but not understood (summons.raised)',
    )
  })

  it('still names where the chain broke when a newer era\'s line is TAMPERED with', () => {
    const withFuture = withLinesAt(tamperedRecord(), 2, [FUTURE_LINE])
    const tampered = JSON.parse(JSON.stringify(withFuture)) as typeof withFuture
    tampered.body[2] = { ...tampered.body[2]!, line: FUTURE_LINE.replace('"lane":"a"', '"lane":"b"') }

    const result = verifyRecord(tampered)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected verification to fail')
    expect(result.reason).toBe('chain-broken')
    expect(result.lineNumber).toBe(3)
  })

  it('accepts a manifest whose time range is set by an unknown line', () => {
    // The unknown is the OLDEST line in the body, so `startTs` is its `ts`. If
    // the timestamp pass counted only foldable events, an honest manifest would
    // read as tampered here — which is how refusing unknowns used to look from
    // the far side.
    const early = FUTURE_LINE.replace('1785930000000', '1')
    const result = verifyRecord(withLinesAt(tamperedRecord(), 0, [early]))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.detail)
    expect(result.unknown ?? []).toHaveLength(1)
  })

  it('is ADDITIVE — a record from this era still verifies to exactly `{ ok: true }`, key for key', () => {
    // The reason the two fields are absent-unless-present rather than empty:
    // records are already exported and read by tooling outside this repo, so
    // growing the result shape for the common case would be a breaking change
    // dressed as a feature. Same rule as `AgentState.synthetic` (prd12 ruling 3).
    const result = verifyRecord(tamperedRecord())
    expect(result).toEqual({ ok: true })
    expect(Object.keys(result)).toEqual(['ok'])
    expect(result.ok && result.unknownVoice).toBeUndefined()
  })

  it('still refuses a line that is not an event at all — that is a broken emitter, not a later era', () => {
    const result = verifyRecord(withLinesAt(tamperedRecord(), 1, ['{"just":"an object"}']))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected verification to fail')
    expect(result.reason).toBe('malformed-line')
    expect(result.lineNumber).toBe(2)
    expect(result.detail).toContain('not an event at all')
  })
})
