import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  ingestAcceptedSchema,
  ledgerKeySchema,
  parseIngestAccepted,
  parseIngestRequest,
} from './protocol.js'

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    project: 'rhizomorph',
    actorInstance: 'session-abc123',
    batch: [
      { n: 1, line: '{"id":"e1"}' },
      { n: 2, line: '{"id":"e2"}' },
    ],
    ...overrides,
  }
}

describe('parseIngestRequest — a well-formed v1 request', () => {
  it('parses, and every field the key is built from survives', () => {
    const result = parseIngestRequest(request())

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.request.protocolVersion).toBe(1)
    expect(result.request.project).toBe('rhizomorph')
    expect(result.request.actorInstance).toBe('session-abc123')
    expect(result.request.batch.map((entry) => entry.n)).toEqual([1, 2])
    expect(result.request.batch.map((entry) => entry.line)).toEqual(['{"id":"e1"}', '{"id":"e2"}'])
  })

  it('accepts a batch whose n values arrive out of order — arrival order is not an invariant', () => {
    // ADR-0033: "Arrival order is not an invariant, because a legitimate gap
    // repair violates it." Only *no gaps and no duplicates* is.
    const result = parseIngestRequest(
      request({ batch: [{ n: 7, line: 'a' }, { n: 3, line: 'b' }, { n: 9, line: 'c' }] }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.request.batch.map((entry) => entry.n)).toEqual([7, 3, 9])
  })
})

describe('parseIngestRequest — the version is refused by name', () => {
  it('names the version it saw and the version this build speaks', () => {
    const result = parseIngestRequest(request({ protocolVersion: 2 }))

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // Both numbers, not the whole sentence: the wording may be improved without
    // editing this test, but it may never stop naming either version.
    expect(result.error).toContain('2')
    expect(result.error).toContain(String(PROTOCOL_VERSION))
  })

  it('answers the version even when the body is also malformed — the order of checks is the contract', () => {
    // A future request whose body differs too must still be told which version
    // this build speaks, rather than complain about a field it never meant to send.
    const result = parseIngestRequest({ protocolVersion: 2, ledger: 'somewhere-else' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('protocol version 2')
    expect(result.error).not.toContain('project')
  })

  it('says which version to send when protocolVersion is absent or not a number', () => {
    for (const value of [{}, request({ protocolVersion: undefined }), request({ protocolVersion: '1' })]) {
      const result = parseIngestRequest(value)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error).toContain('protocolVersion')
      expect(result.error).toContain(String(PROTOCOL_VERSION))
    }
  })

  it('refuses a non-object outright, saying what arrived', () => {
    expect(parseIngestRequest(null)).toEqual({
      ok: false,
      error: 'not an ingest request: expected an object, got object',
    })
    const fromString = parseIngestRequest('{"protocolVersion":1}')
    expect(fromString.ok).toBe(false)
    if (fromString.ok) throw new Error('unreachable')
    expect(fromString.error).toContain('got string')
  })
})

describe('parseIngestRequest — the shape', () => {
  it('refuses an empty batch, a non-positive or fractional n, and an empty line', () => {
    const bad: Array<Record<string, unknown>> = [
      request({ batch: [] }),
      request({ batch: [{ n: 0, line: 'a' }] }),
      request({ batch: [{ n: -1, line: 'a' }] }),
      request({ batch: [{ n: 1.5, line: 'a' }] }),
      request({ batch: [{ n: 1, line: '' }] }),
      request({ project: '' }),
      request({ actorInstance: '' }),
    ]
    for (const value of bad) {
      const result = parseIngestRequest(value)
      expect(result.ok, JSON.stringify(value)).toBe(false)
    }
  })

  it('refuses a batch that repeats an n, and names the repeat', () => {
    // Ruling 4 dedups ACROSS batches for free. A duplicate inside one batch
    // makes the 202's `accepted` count ambiguous and can only be a shipper defect.
    const result = parseIngestRequest(
      request({ batch: [{ n: 4, line: 'a' }, { n: 5, line: 'b' }, { n: 4, line: 'c' }] }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('n=4')
    expect(result.error).not.toContain('n=5')
  })

  it('strips an undeclared key on the request and on a batch entry — zod is the wire’s allowlist', () => {
    // `events/`'s no-open-payload law does not sweep this directory, so a
    // `.loose()` here would be caught by nothing else.
    const result = parseIngestRequest(
      request({
        smuggled: 'REQUEST-EXTRA-91af',
        batch: [{ n: 1, line: 'a', smuggled: 'ENTRY-EXTRA-91af' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(Object.keys(result.request).sort()).toEqual([
      'actorInstance',
      'batch',
      'project',
      'protocolVersion',
    ])
    expect(Object.keys(result.request.batch[0] as object).sort()).toEqual(['line', 'n'])
    expect(JSON.stringify(result.request)).not.toContain('REQUEST-EXTRA-91af')
    expect(JSON.stringify(result.request)).not.toContain('ENTRY-EXTRA-91af')
  })
})

describe('parseIngestAccepted — the 202', () => {
  it('parses { accepted, journalSeq }', () => {
    const result = parseIngestAccepted({ accepted: 500, journalSeq: 12 })
    expect(result).toEqual({ ok: true, response: { accepted: 500, journalSeq: 12 } })
    expect(ingestAcceptedSchema.safeParse({ accepted: 0, journalSeq: 0 }).success).toBe(true)
  })

  it('refuses a negative or absent field', () => {
    for (const value of [
      { accepted: -1, journalSeq: 1 },
      { accepted: 1, journalSeq: -1 },
      { accepted: 1 },
      { journalSeq: 1 },
      { accepted: 1.5, journalSeq: 1 },
      null,
    ]) {
      expect(parseIngestAccepted(value).ok, JSON.stringify(value)).toBe(false)
    }
  })
})

describe('the key is a position, not an identity', () => {
  it('is exactly (project, actorInstance, n)', () => {
    expect(Object.keys(ledgerKeySchema.shape)).toEqual(['project', 'actorInstance', 'n'])
  })

  it('accepts a 1-based position and refuses anything that is not one', () => {
    expect(ledgerKeySchema.safeParse({ project: 'p', actorInstance: 'a', n: 1 }).success).toBe(true)
    for (const n of [0, -3, 2.5, '4', null]) {
      expect(ledgerKeySchema.safeParse({ project: 'p', actorInstance: 'a', n }).success).toBe(false)
    }
  })
})
