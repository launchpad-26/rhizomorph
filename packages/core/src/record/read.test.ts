import { describe, expect, it } from 'vitest'
import { fixtureSession } from '../fixtures.js'
import { buildRecord } from './build.js'
import { sha256Hex } from './hash.js'
import { bodyTsRange, readRecord, readRecordBody } from './read.js'
import type { RecordLink, SessionRecord } from './schema.js'

const ACTOR = { instance: 'session-alice-1', handle: 'alice', declared: true }
const REPO_SLUG = 'rhizomorph-abc123'

/** A line the way a NEWER era's instrument would write it — prd17 ruling 1's own families. */
const FUTURE_LINE =
  '{"id":"evt-future-1","ts":1785930000000,"source":"system","type":"summons.raised","payload":{"lane":"a"}}'

function record(): SessionRecord {
  return buildRecord(fixtureSession(), { repoSlug: REPO_SLUG, actor: ACTOR })
}

/**
 * Splices extra lines into a record's body and RE-CHAINS everything after them,
 * so the result is a record a compatible emitter could genuinely have produced
 * — a newer era's own export, chain intact. Anything less would be testing a
 * tampered artifact, which is a different question.
 */
export function withLinesAt(base: SessionRecord, at: number, lines: readonly string[]): SessionRecord {
  const texts = base.body.map((link) => link.line)
  texts.splice(at, 0, ...lines)

  let prevHash = base.body[0]?.prevHash ?? base.manifest.chainDigest
  const body: RecordLink[] = []
  for (const line of texts) {
    const hash = sha256Hex(prevHash + line)
    body.push({ line, prevHash, hash })
    prevHash = hash
  }

  const stamps = texts.map((line) => (JSON.parse(line) as { ts: number }).ts)
  return {
    manifest: {
      ...base.manifest,
      eventCount: body.length,
      chainDigest: prevHash,
      startTs: Math.min(...stamps),
      endTs: Math.max(...stamps),
    },
    body,
  }
}

describe('readRecordBody', () => {
  it('reads every line of a record entirely from this era', () => {
    const read = readRecord(record())
    expect(read.events).toHaveLength(fixtureSession().length)
    expect(read.unknown).toEqual([])
    expect(read.malformed).toBeNull()
  })

  it('counts a newer era\'s line instead of dropping it, and keeps its bytes', () => {
    const read = readRecord(withLinesAt(record(), 2, [FUTURE_LINE]))
    expect(read.events).toHaveLength(fixtureSession().length)
    expect(read.unknown).toHaveLength(1)
    expect(read.unknown[0]?.line).toBe(FUTURE_LINE)
    expect(read.unknown[0]?.type).toBe('summons.raised')
    expect(read.unknown[0]?.lineNumber).toBe(3)
    expect(read.malformed).toBeNull()
  })

  it('keeps events and unknowns each in body order', () => {
    const second = FUTURE_LINE.replace('evt-future-1', 'evt-future-2').replace(
      'summons.raised',
      'summons.cleared',
    )
    const read = readRecord(withLinesAt(withLinesAt(record(), 1, [FUTURE_LINE]), 4, [second]))
    expect(read.unknown.map((entry) => entry.type)).toEqual(['summons.raised', 'summons.cleared'])
    expect(read.unknown.map((entry) => entry.lineNumber)).toEqual([2, 5])
  })

  it('names the FIRST line that is not an event at all, and keeps reading past it', () => {
    const read = readRecordBody([
      { line: '{"nope":1}', prevHash: 'a'.repeat(64), hash: 'b'.repeat(64) },
      { line: FUTURE_LINE, prevHash: 'b'.repeat(64), hash: 'c'.repeat(64) },
      { line: 'also not json', prevHash: 'c'.repeat(64), hash: 'd'.repeat(64) },
    ])
    expect(read.malformed?.lineNumber).toBe(1)
    // The unknown after it was still counted — a caller wanting the whole
    // picture gets it, rather than everything after the first bad line vanishing.
    expect(read.unknown).toHaveLength(1)
  })

  it('reads an empty body as an empty everything', () => {
    expect(readRecordBody([])).toEqual({ events: [], unknown: [], malformed: null })
  })
})

describe('bodyTsRange', () => {
  it('spans the events of a record from this era', () => {
    const events = fixtureSession()
    const range = bodyTsRange(readRecord(record()))
    expect(range).toEqual({
      minTs: Math.min(...events.map((event) => event.ts)),
      maxTs: Math.max(...events.map((event) => event.ts)),
    })
  })

  it('counts an unknown\'s timestamp too — the manifest describes every line, not just the foldable ones', () => {
    const early = FUTURE_LINE.replace('1785930000000', '1')
    const range = bodyTsRange(readRecord(withLinesAt(record(), 0, [early])))
    expect(range?.minTs).toBe(1)
  })

  it('is null for an empty body — there is no range, and 0-0 would be a claim', () => {
    expect(bodyTsRange(readRecordBody([]))).toBeNull()
  })
})
