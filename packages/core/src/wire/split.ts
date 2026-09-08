/**
 * THE BYTE SCAN — how a ledger becomes lines with positions (prd-51 ruling 3,
 * ADR-0033).
 *
 * The shipper reads a chunk of the ledger file and has to answer two things:
 * which complete lines are in it, and where the cursor now sits. Ruling 3's
 * cursor is *offset **and** `n`*, and both halves have to come out of the same
 * scan or they drift.
 *
 * **Scan the bytes, never the decoded string.** A `TextDecoder`-then-`split`
 * implementation shipped 25,005 rows for a 25,000-line file, because
 * `string.length` counts UTF-16 code units and a file offset counts bytes
 * (`docs/research/2026-08-29-shared-record-s2-concurrent-actors.md`, the
 * smoke-test bug). Every offset here is a byte offset produced by comparing
 * `bytes[i] === 0x0a`, and `split.test.ts` pins the divergence from the wrong
 * implementation at the exact multibyte count.
 *
 * No `node:*`, no `Buffer`, no dependency (ADR-0003). Ruling 3's word "Buffer"
 * means raw bytes; in `packages/core` that is `Uint8Array`. Cursor
 * *persistence* is the shipper's, in `packages/server`, where Node exists.
 */

/** One complete, newline-terminated line of a ledger, with its position and its byte span. */
export interface LedgerLine {
  /** 1-based position in the source ledger — the wire's `n`. */
  n: number
  /** The line's own bytes decoded as UTF-8, without its terminating newline. */
  line: string
  /** Absolute ledger byte offset of the line's first byte. */
  startOffset: number
  /** Absolute ledger byte offset one past the terminating newline — the next cursor. */
  endOffset: number
}

export interface SplitLinesResult {
  lines: LedgerLine[]
  /** Where the cursor lands: one past the last COMPLETE line. Write this to the cursor file. */
  nextOffset: number
  /** `n` of the last complete line. Zero if none has been seen yet. */
  nextN: number
  /** Bytes after `nextOffset` — a line still being appended. Never yielded. */
  partialTailBytes: number
}

const REPLACEMENT = '�'
const NEWLINE = 0x0a

/**
 * Splits a chunk of ledger bytes into complete lines, numbered and located.
 *
 * `fromOffset` is **the absolute ledger offset at which `bytes[0]` sits** — the
 * chunk's position in the file, not an index to start scanning from. Scanning
 * always begins at `bytes[0]`; every offset returned is absolute. That is the
 * only reading under which `nextOffset` can be written straight into ruling
 * 3's cursor and handed to the next read, and the only one that does not
 * require the shipper to hold the whole ledger in memory.
 *
 * ```ts
 * const cold   = splitLines(chunk, 0, 0)                        // cold start
 * const resume = splitLines(chunk, cursor.offset, cursor.n)     // resume
 * ```
 *
 * `fromN` exists because ruling 3's cursor is offset *and* `n`: without it
 * every poll restarts `n` at 1 and the `(project, actorInstance, n)` key
 * silently collides. It is the third parameter with a default so the
 * two-argument spelling still reads correctly.
 *
 * Three behaviours worth stating, each of them a test case:
 *
 * - **Only newline-terminated segments are yielded.** A trailing fragment is
 *   left for the next call and reported as `partialTailBytes`; a half-written
 *   last line is the normal shape of a live ledger (`jsonl.ts` says so).
 * - **An empty segment still consumes an `n`.** `n` is a position in the byte
 *   stream; skipping blank lines would make it depend on content, which is how
 *   a cursor desyncs. Whether a blank line means anything is
 *   {@link reserializeLine}'s question, and its answer is `malformed`.
 * - **Each line is decoded from its own byte slice only.** A chunk boundary can
 *   fall inside a multibyte character; a per-line decode can never be asked to
 *   decode a partial one.
 */
export function splitLines(bytes: Uint8Array, fromOffset = 0, fromN = 0): SplitLinesResult {
  const lines: LedgerLine[] = []
  let n = fromN
  let segmentStart = 0
  let consumed = 0

  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== NEWLINE) continue
    n += 1
    lines.push({
      n,
      line: decodeUtf8(bytes, segmentStart, i),
      startOffset: fromOffset + segmentStart,
      endOffset: fromOffset + i + 1,
    })
    segmentStart = i + 1
    consumed = i + 1
  }

  return {
    lines,
    nextOffset: fromOffset + consumed,
    nextN: n,
    partialTailBytes: bytes.length - consumed,
  }
}

/**
 * Decodes `bytes[start, end)` as UTF-8.
 *
 * Hand-written for the same reason `record/hash.ts` hand-writes its UTF-8
 * *encoder*: `TextDecoder` is a DOM/Node global this package does not assume,
 * and `packages/core` compiles under `lib: ["ES2022"]` where it is not even in
 * scope (ADR-0003). This is the decoder half of the same precedent.
 *
 * Malformed input yields `U+FFFD` and never throws. The **stated limit**: this
 * does not chase byte-exact WHATWG agreement on how many replacement
 * characters an invalid run produces. A ledger line is `JSON.stringify` output
 * and is always well-formed UTF-8, so spec-exact error recovery would buy
 * nothing; the tests assert oracle equality on valid input and only
 * "does not throw, contains U+FFFD" on invalid.
 */
export function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  const from = Math.max(0, start)
  const to = Math.min(end, bytes.length)
  let out = ''
  let i = from

  while (i < to) {
    const b0 = bytes[i] as number
    if (b0 < 0x80) {
      out += String.fromCharCode(b0)
      i += 1
      continue
    }

    let continuations: number
    let codePoint: number
    let lowerBound: number
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      continuations = 1
      codePoint = b0 & 0x1f
      lowerBound = 0x80
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      continuations = 2
      codePoint = b0 & 0x0f
      lowerBound = 0x800
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      continuations = 3
      codePoint = b0 & 0x07
      lowerBound = 0x10000
    } else {
      // A lone continuation byte (0x80–0xbf), an overlong lead (0xc0/0xc1), or
      // a lead outside the encodable range (0xf5–0xff).
      out += REPLACEMENT
      i += 1
      continue
    }

    let complete = true
    for (let k = 1; k <= continuations; k += 1) {
      const next = i + k < to ? (bytes[i + k] as number) : -1
      if (next < 0 || (next & 0xc0) !== 0x80) {
        complete = false
        break
      }
      codePoint = (codePoint << 6) | (next & 0x3f)
    }

    // Overlong encodings, surrogates and out-of-range code points are as
    // invalid as a truncated sequence, and get the same answer.
    const valid =
      complete &&
      codePoint >= lowerBound &&
      codePoint <= 0x10ffff &&
      !(codePoint >= 0xd800 && codePoint <= 0xdfff)
    if (!valid) {
      out += REPLACEMENT
      i += 1
      continue
    }

    out += String.fromCodePoint(codePoint)
    i += 1 + continuations
  }

  return out
}
