import { describe, expect, it } from 'vitest'
import { fixtureSession } from '../fixtures.js'
import { lineToEvent } from '../jsonl.js'
import { reduceAll } from '../reduce.js'
import { buildRecord } from './build.js'
import { RECORD_SCHEMA_VERSION, parseRecord } from './schema.js'
import { verifyRecord } from './verify.js'

const ACTOR = { instance: 'session-alice-1', handle: 'alice', declared: true }

describe('buildRecord', () => {
  it('produces a manifest that names its schema, repo, actor and time range', () => {
    const events = fixtureSession()
    const record = buildRecord(events, { repoSlug: 'rhizomorph-abc123', actor: ACTOR })

    expect(record.manifest.schemaVersion).toBe(RECORD_SCHEMA_VERSION)
    expect(record.manifest.repoSlug).toBe('rhizomorph-abc123')
    expect(record.manifest.actor).toEqual(ACTOR)
    expect(record.manifest.eventCount).toBe(events.length)
    expect(record.manifest.startTs).toBe(Math.min(...events.map((e) => e.ts)))
    expect(record.manifest.endTs).toBe(Math.max(...events.map((e) => e.ts)))
    expect(record.manifest.signature).toBeNull()
    expect(record.manifest.chainDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(record.body).toHaveLength(events.length)
  })

  it('holds the log lines verbatim — a round trip through the body reproduces the exact events', () => {
    const events = fixtureSession()
    const record = buildRecord(events, { repoSlug: 'rhizomorph-abc123', actor: ACTOR })

    const recovered = record.body.map((link, i) => {
      const parsed = lineToEvent(link.line, i + 1)
      if (!parsed.ok) throw new Error(parsed.error)
      return parsed.event
    })
    expect(recovered).toEqual(events)
    expect(reduceAll(recovered)).toEqual(reduceAll(events))
  })

  it('verifies clean — export, verify, and the fold it replays are the same fold', () => {
    const events = fixtureSession()
    const record = buildRecord(events, { repoSlug: 'rhizomorph-abc123', actor: ACTOR })

    expect(verifyRecord(record)).toEqual({ ok: true, unknown: [], unknownVoice: null })

    const recovered = record.body.map((link) => {
      const parsed = lineToEvent(link.line)
      if (!parsed.ok) throw new Error(parsed.error)
      return parsed.event
    })
    expect(reduceAll(recovered)).toEqual(reduceAll(events))
  })

  it('survives a JSON round trip (what export writes and replay reads)', () => {
    const events = fixtureSession()
    const record = buildRecord(events, { repoSlug: 'rhizomorph-abc123', actor: ACTOR })

    const roundTripped = JSON.parse(JSON.stringify(record))
    const parsed = parseRecord(roundTripped)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.record).toEqual(record)
    expect(verifyRecord(parsed.record)).toEqual({ ok: true, unknown: [], unknownVoice: null })
  })

  it('closes an empty log to the genesis digest, not an error', () => {
    const record = buildRecord([], { repoSlug: 'rhizomorph-abc123', actor: ACTOR })
    expect(record.manifest.eventCount).toBe(0)
    expect(record.body).toEqual([])
    expect(verifyRecord(record)).toEqual({ ok: true, unknown: [], unknownVoice: null })
  })

  it('two different actors recording the same events produce different chains', () => {
    const events = fixtureSession()
    const a = buildRecord(events, { repoSlug: 'rhizomorph-abc123', actor: ACTOR })
    const b = buildRecord(events, {
      repoSlug: 'rhizomorph-abc123',
      actor: { instance: 'session-bob-1', handle: 'bob', declared: true },
    })
    expect(a.manifest.chainDigest).not.toBe(b.manifest.chainDigest)
  })
})
