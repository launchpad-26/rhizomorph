import { describe, expect, it } from 'vitest'
import { JOURNAL_MAGIC, crc32Hex, decodeEntry, encodeFrame, encodeHeader, parseHeaderLine } from './format.js'

/**
 * THE FRAME, AT BYTE LEVEL (ADR-0046).
 *
 * Everything here is about bytes rather than about strings, because the two
 * differ exactly where the format has to be right: `byteLen` is what makes a
 * torn tail decidable, and a `String.length` implementation of it is off by one
 * per astral character. The emoji corpus is the assertion such an
 * implementation fails.
 */

const ENTRY = {
  seq: 1,
  receivedAtMs: 1785739192632,
  project: 'acme-widgets',
  actorInstance: 'lane-7',
  batch: [{ n: 1, line: '{"type":"llm.cost"}' }],
}

/** Splits a frame back into its header line and its payload bytes. */
function partsOf(frame: Buffer): { header: string; payload: Buffer } {
  const at = frame.indexOf(0x0a)
  return { header: frame.toString('utf8', 0, at), payload: frame.subarray(at + 1, frame.length - 1) }
}

describe('a frame round-trips', () => {
  it('is a header line, the payload, and a terminator — and nothing else', () => {
    const frame = encodeFrame(ENTRY)
    const { header, payload } = partsOf(frame)
    expect(header.startsWith(`${JOURNAL_MAGIC} 1 `)).toBe(true)
    expect(frame[frame.length - 1]).toBe(0x0a)
    const parsed = parseHeaderLine(header)
    expect(parsed.ok && parsed.header.byteLen).toBe(payload.byteLength)
    expect(parsed.ok && parsed.header.crc).toBe(crc32Hex(payload))
    const decoded = decodeEntry(payload)
    expect(decoded.ok && decoded.entry).toEqual(ENTRY)
  })

  it('carries a line containing a newline, a quote and a lone surrogate VERBATIM', () => {
    const line = '{"a":"x\ny","q":"\\"","s":"\\ud83d"}'
    const frame = encodeFrame({ ...ENTRY, batch: [{ n: 4, line }] })
    const decoded = decodeEntry(partsOf(frame).payload)
    expect(decoded.ok && decoded.entry.batch[0]?.line).toBe(line)
    // The embedded newline must not have become a frame boundary: the header's
    // byteLen still describes the WHOLE payload.
    const { header, payload } = partsOf(frame)
    const parsed = parseHeaderLine(header)
    expect(parsed.ok && parsed.header.byteLen).toBe(payload.byteLength)
  })

  it('byteLen counts BYTES, not characters — the assertion a String.length version fails', () => {
    // '🧬' is one astral character: two UTF-16 code units, four UTF-8 bytes.
    const line = '{"e":"🧬🧬🧬"}'
    const json = JSON.stringify({ ...ENTRY, batch: [{ n: 1, line }] })
    expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(json.length)

    const { header, payload } = partsOf(encodeFrame({ ...ENTRY, batch: [{ n: 1, line }] }))
    const parsed = parseHeaderLine(header)
    expect(parsed.ok && parsed.header.byteLen).toBe(Buffer.byteLength(json, 'utf8'))
    expect(parsed.ok && parsed.header.byteLen).not.toBe(json.length)
    expect(payload.byteLength).toBe(Buffer.byteLength(json, 'utf8'))
  })
})

describe('the crc separates a flipped byte from anything else', () => {
  it('changes when exactly one payload byte changes', () => {
    const payload = Buffer.from('{"a":1}', 'utf8')
    const flipped = Buffer.from(payload)
    flipped[3] = (flipped[3] ?? 0) ^ 0x01
    expect(crc32Hex(flipped)).not.toBe(crc32Hex(payload))
    expect(flipped.byteLength).toBe(payload.byteLength)
  })

  it('is eight lowercase hex digits, zero-padded — the header grammar depends on the width', () => {
    // A payload whose crc32 has a leading zero nibble; found by search, not by
    // hope, so the padding branch is actually exercised.
    const padded = Array.from({ length: 4000 }, (_, i) => Buffer.from(`p${i}`, 'utf8')).find(
      (candidate) => (crc32Hex(candidate).startsWith('0')),
    )
    expect(padded).toBeDefined()
    expect(crc32Hex(padded ?? Buffer.alloc(0))).toMatch(/^[0-9a-f]{8}$/)
    expect(crc32Hex(Buffer.from('abc', 'utf8'))).toBe('352441c2')
  })

  it('encodeHeader and the frame agree, so the reader and the writer share one grammar', () => {
    const payload = Buffer.from('{"a":1}', 'utf8')
    expect(encodeHeader(7, payload)).toBe(`${JOURNAL_MAGIC} 7 ${payload.byteLength} ${crc32Hex(payload)}`)
  })
})

describe('the header grammar refuses each part by name', () => {
  it('refuses a wrong magic, naming it', () => {
    const result = parseHeaderLine('RZJ0 1 7 352441c2')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('"RZJ0"')
    expect(result.ok ? '' : result.error).toContain('RZJ1')
  })

  it('refuses a negative or zero seq, naming seq', () => {
    for (const bad of ['RZJ1 -1 7 352441c2', 'RZJ1 0 7 352441c2', 'RZJ1 x 7 352441c2']) {
      const result = parseHeaderLine(bad)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.error).toContain('seq')
    }
  })

  it('refuses a seven-digit crc, naming the crc', () => {
    const result = parseHeaderLine('RZJ1 1 7 352441c')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('crc')
    expect(result.ok ? '' : result.error).toContain('eight lowercase hex')
    // …and an uppercase one, which would otherwise be a second spelling of the
    // same header and break byte-for-byte comparison.
    expect(parseHeaderLine('RZJ1 1 7 352441C2').ok).toBe(false)
  })

  it('refuses a non-numeric byteLen, naming byteLen', () => {
    const result = parseHeaderLine('RZJ1 1 seven 352441c2')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('byteLen')
  })

  it('refuses the wrong number of fields, and says how many it saw', () => {
    expect(parseHeaderLine('RZJ1 1 7').ok).toBe(false)
    expect(parseHeaderLine('RZJ1 1 7 352441c2 extra').ok).toBe(false)
    const result = parseHeaderLine('')
    expect(result.ok ? '' : result.error).toContain('four space-separated fields')
  })

  it('accepts the header the writer actually writes — so the refusals above are not vacuous', () => {
    const { header } = partsOf(encodeFrame(ENTRY))
    expect(parseHeaderLine(header).ok).toBe(true)
  })
})

describe('decodeEntry checks meaning, because a crc only proves bytes', () => {
  it('refuses a payload that is not JSON, is not an object, or is missing a field', () => {
    expect(decodeEntry(Buffer.from('not json', 'utf8')).ok).toBe(false)
    expect(decodeEntry(Buffer.from('42', 'utf8')).ok).toBe(false)
    expect(decodeEntry(Buffer.from('{"seq":1}', 'utf8')).ok).toBe(false)
    expect(decodeEntry(Buffer.from(JSON.stringify({ ...ENTRY, batch: undefined }), 'utf8')).ok).toBe(false)
    expect(decodeEntry(Buffer.from(JSON.stringify({ ...ENTRY, batch: [{ n: 'one', line: 'x' }] }), 'utf8')).ok).toBe(
      false,
    )
  })

  it('accepts the payload the writer writes', () => {
    const decoded = decodeEntry(partsOf(encodeFrame(ENTRY)).payload)
    expect(decoded.ok && decoded.entry.batch.length).toBe(1)
  })
})
