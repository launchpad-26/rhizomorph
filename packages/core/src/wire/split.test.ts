import { describe, expect, it } from 'vitest'
import { eraCorpusEntry } from '../eras/corpus.js'
import { parseJsonl } from '../jsonl.js'
import { decodeUtf8, splitLines } from './split.js'

/**
 * `TextEncoder`/`TextDecoder` are used freely **in this file and only in this
 * file**: a test runs in Node or jsdom where both exist, while `split.ts`
 * compiles under `lib: ["ES2022"]` and must assume neither (ADR-0003). That
 * asymmetry is the point — the encoder builds the fixture and the decoder is
 * the oracle, and `decodeUtf8` is the thing under test rather than a wrapper
 * around them.
 */
const enc = new TextEncoder()

/**
 * Three lines, one multibyte character each, with the arithmetic written out
 * so the expected offsets are hand-computed rather than re-derived from the
 * encoder the implementation is being checked against.
 *
 *   line 1  "aéb"   a(1) + é(2) + b(1) = 4 bytes, + \n  →  [ 0,  5)
 *   line 2  "c—d"   c(1) + —(3) + d(1) = 5 bytes, + \n  →  [ 5, 11)
 *   line 3  "e🌱f"  e(1) + 🌱(4) + f(1) = 6 bytes, + \n  →  [11, 18)
 *
 * Extra bytes over UTF-16 code units: é +1, — +2, 🌱 +2  =  +5. That 5 is the
 * whole bug, and case 2 below pins it.
 */
const MULTIBYTE_TEXT = 'aéb\nc—d\ne\u{1F331}f\n'
const MULTIBYTE_BYTES = enc.encode(MULTIBYTE_TEXT)

/**
 * The bug, as a reference implementation: decode the whole chunk, `split('\n')`,
 * and accumulate `string.length`. This is what shipped 25,005 rows for a
 * 25,000-line file (`docs/research/2026-08-29-shared-record-s2-concurrent-actors.md`).
 */
function decodeThenIndex(bytes: Uint8Array): Array<{ line: string; startOffset: number; endOffset: number }> {
  const text = new TextDecoder().decode(bytes)
  const segments = text.split('\n')
  const out: Array<{ line: string; startOffset: number; endOffset: number }> = []
  let offset = 0
  for (let i = 0; i < segments.length - 1; i += 1) {
    const line = segments[i] as string
    out.push({ line, startOffset: offset, endOffset: offset + line.length + 1 })
    offset += line.length + 1
  }
  return out
}

describe('splitLines — the multibyte law', () => {
  it('yields byte offsets that re-slice to each line exactly', () => {
    const result = splitLines(MULTIBYTE_BYTES)

    expect(result.lines.map((l) => l.line)).toEqual(['aéb', 'c—d', 'e\u{1F331}f'])
    expect(result.lines.map((l) => l.n)).toEqual([1, 2, 3])
    expect(result.lines.map((l) => [l.startOffset, l.endOffset])).toEqual([
      [0, 5],
      [5, 11],
      [11, 18],
    ])
    expect(result.nextOffset).toBe(18)
    expect(result.nextN).toBe(3)
    expect(result.partialTailBytes).toBe(0)

    // The offsets are not decoration: re-slicing by them, minus the newline,
    // must give back the line's own bytes.
    for (const line of result.lines) {
      const slice = MULTIBYTE_BYTES.subarray(line.startOffset, line.endOffset - 1)
      expect(new TextDecoder().decode(slice)).toBe(line.line)
      expect(MULTIBYTE_BYTES[line.endOffset - 1]).toBe(0x0a)
    }
  })

  it('diverges from a decode-then-index implementation by exactly the extra-byte count', () => {
    const right = splitLines(MULTIBYTE_BYTES)
    const wrong = decodeThenIndex(MULTIBYTE_BYTES)

    // Same lines, same count — the text is not where the two disagree.
    expect(wrong.map((l) => l.line)).toEqual(right.lines.map((l) => l.line))

    // é +1, — +2, 🌱 +2: the drift accumulates line by line.
    expect(right.lines.map((l) => l.endOffset)).toEqual([5, 11, 18])
    expect(wrong.map((l) => l.endOffset)).toEqual([4, 8, 13])
    const drift = right.lines.map((l, i) => l.endOffset - (wrong[i] as { endOffset: number }).endOffset)
    expect(drift).toEqual([1, 3, 5])
    expect(right.nextOffset - (wrong[wrong.length - 1] as { endOffset: number }).endOffset).toBe(5)
  })
})

describe('splitLines — real ledger bytes', () => {
  const era1 = eraCorpusEntry('era-1')
  const bytes = enc.encode(era1.recordingText)

  it('counts a real recording exactly, and agrees with the existing parser', () => {
    const result = splitLines(bytes)

    expect(result.lines).toHaveLength(100)
    // Tied to the parser rather than to a literal alone: 100 lines is also 100
    // events, which is the "25,000 rows for 25,000 lines, exact" assertion.
    expect(result.lines).toHaveLength(parseJsonl(era1.recordingText).events.length)
    // Era 1 ends 0a, so there is no tail and the cursor lands on the file's end.
    expect(result.nextOffset).toBe(bytes.length)
    expect(result.nextN).toBe(100)
    expect(result.partialTailBytes).toBe(0)
    // Not a synthetic-only law: era 1 carries a real em dash in a commit subject.
    expect(era1.recordingText).toContain('—')
  })

  it('never yields a torn tail — a half-written last line waits for the next read', () => {
    const full = splitLines(bytes)
    const lastComplete = full.lines[98] as { endOffset: number }
    const torn = bytes.subarray(0, lastComplete.endOffset + 40)

    const result = splitLines(torn)

    expect(result.lines).toHaveLength(99)
    expect(result.nextOffset).toBe(lastComplete.endOffset)
    expect(result.nextN).toBe(99)
    expect(result.partialTailBytes).toBe(40)
    expect(result.lines.at(-1)?.endOffset).toBe(lastComplete.endOffset)
  })

  it('resumes across a chunk boundary that falls inside a multibyte character', () => {
    // The em dash on line 77, cut after its first byte.
    let emDashAt = -1
    for (let i = 0; i + 2 < bytes.length; i += 1) {
      if (bytes[i] === 0xe2 && bytes[i + 1] === 0x80 && bytes[i + 2] === 0x94) {
        emDashAt = i
        break
      }
    }
    expect(emDashAt).toBeGreaterThan(0)

    const first = splitLines(bytes.subarray(0, emDashAt + 1), 0, 0)
    expect(first.lines).toHaveLength(76)
    expect(first.partialTailBytes).toBeGreaterThan(0)

    const second = splitLines(bytes.subarray(first.nextOffset), first.nextOffset, first.nextN)

    const singlePass = splitLines(bytes)
    expect([...first.lines, ...second.lines]).toEqual(singlePass.lines)
    expect(second.nextOffset).toBe(singlePass.nextOffset)
    expect(second.nextN).toBe(singlePass.nextN)
    expect(second.partialTailBytes).toBe(0)
  })

  it('repeats: the same chunk twice is deep-equal, and a third pass over nothing moves nothing', () => {
    const once = splitLines(bytes)
    const twice = splitLines(bytes)
    expect(twice).toEqual(once)

    const nothingAppended = splitLines(bytes.subarray(once.nextOffset), once.nextOffset, once.nextN)
    expect(nothingAppended.lines).toEqual([])
    expect(nothingAppended.nextOffset).toBe(once.nextOffset)
    expect(nothingAppended.nextN).toBe(once.nextN)
    expect(nothingAppended.partialTailBytes).toBe(0)
  })
})

describe('splitLines — positions come from the byte stream, not from content', () => {
  it('an empty segment still consumes an n', () => {
    const result = splitLines(enc.encode('a\n\nb\n'))
    expect(result.lines.map((l) => [l.n, l.line])).toEqual([
      [1, 'a'],
      [2, ''],
      [3, 'b'],
    ])
    expect(result.nextN).toBe(3)
  })

  it('empty input yields nothing and moves neither half of the cursor', () => {
    const result = splitLines(new Uint8Array(0), 4096, 12)
    expect(result.lines).toEqual([])
    expect(result.nextOffset).toBe(4096)
    expect(result.nextN).toBe(12)
    expect(result.partialTailBytes).toBe(0)
  })

  it('fromOffset is where bytes[0] sits in the file, so every offset comes back absolute', () => {
    const result = splitLines(enc.encode('x—y\n'), 1000, 7)
    expect(result.lines).toEqual([{ n: 8, line: 'x—y', startOffset: 1000, endOffset: 1006 }])
    expect(result.nextOffset).toBe(1006)
    expect(result.nextN).toBe(8)
  })
})

describe('decodeUtf8', () => {
  const oracle = new TextDecoder()

  it('agrees with TextDecoder on every line of a real recording', () => {
    const era1 = eraCorpusEntry('era-1')
    const bytes = enc.encode(era1.recordingText)
    const result = splitLines(bytes)
    expect(result.lines.length).toBeGreaterThan(0)

    for (const line of result.lines) {
      const slice = bytes.subarray(line.startOffset, line.endOffset - 1)
      expect(decodeUtf8(bytes, line.startOffset, line.endOffset - 1)).toBe(oracle.decode(slice))
    }
  })

  it('agrees with TextDecoder on hand-written 1-, 2-, 3- and 4-byte sequences', () => {
    const cases: Array<{ bytes: number[]; expected: string }> = [
      { bytes: [0x41], expected: 'A' },
      { bytes: [0xc3, 0xa9], expected: 'é' },
      { bytes: [0xe2, 0x80, 0x94], expected: '—' },
      { bytes: [0xf0, 0x9f, 0x8c, 0xb1], expected: '\u{1F331}' },
      { bytes: [0x41, 0xc3, 0xa9, 0xe2, 0x80, 0x94, 0xf0, 0x9f, 0x8c, 0xb1], expected: 'Aé—\u{1F331}' },
    ]
    for (const { bytes, expected } of cases) {
      const buf = Uint8Array.from(bytes)
      expect(decodeUtf8(buf, 0, buf.length)).toBe(expected)
      expect(decodeUtf8(buf, 0, buf.length)).toBe(oracle.decode(buf))
    }
  })

  it('decodes only the requested slice, never the whole buffer', () => {
    const buf = enc.encode('ab—cd')
    // 'ab' is [0,2); the em dash is [2,5).
    expect(decodeUtf8(buf, 0, 2)).toBe('ab')
    expect(decodeUtf8(buf, 2, 5)).toBe('—')
    expect(decodeUtf8(buf, 5, 7)).toBe('cd')
    expect(decodeUtf8(buf, 3, 3)).toBe('')
  })

  /**
   * The stated limit: replacement, not WHATWG-exact recovery. A ledger line is
   * `JSON.stringify` output and so is always well-formed UTF-8; agreeing with
   * the spec on *how many* U+FFFD an invalid run produces would buy nothing,
   * and asserting it would pin an implementation detail no caller depends on.
   * What is asserted is what callers do depend on: it never throws, and the
   * damage is visible.
   */
  it('replaces malformed input rather than throwing', () => {
    const truncated = Uint8Array.from([0x61, 0xe2, 0x80]) // 'a' + a cut em dash
    const loneContinuation = Uint8Array.from([0x80, 0x62]) // an orphan tail + 'b'
    const badLead = Uint8Array.from([0xff, 0x63])

    for (const buf of [truncated, loneContinuation, badLead]) {
      expect(() => decodeUtf8(buf, 0, buf.length)).not.toThrow()
      expect(decodeUtf8(buf, 0, buf.length)).toContain('�')
    }
    expect(decodeUtf8(truncated, 0, truncated.length)).toContain('a')
    expect(decodeUtf8(loneContinuation, 0, loneContinuation.length)).toContain('b')
    expect(decodeUtf8(badLead, 0, badLead.length)).toContain('c')
  })
})
