import { crc32 } from 'node:zlib'

/**
 * ONE JOURNAL FRAME (ADR-0046, prd-51 ruling 4).
 *
 * ```
 * RZJ1 <seq> <byteLen> <crc32hex>\n
 * <json>\n
 * ```
 *
 * Pure: this module touches no file descriptor. `journal.ts` writes frames and
 * `read.ts` walks them; both get their grammar from here so there is exactly
 * one place the format is written down.
 *
 * **Why a header line rather than plain JSONL.** `byteLen` is what makes a torn
 * tail *decidable*. With plain JSONL a truncated last line and a corrupted
 * interior line are the same observation — a line that will not parse — and
 * ruling 4 requires them to be different verdicts: a tear at EOF is legal and
 * reads as never-acked, a parse failure anywhere earlier aborts loudly. The
 * length says exactly where the next record begins, so "the failure is followed
 * by more bytes" becomes a fact rather than an inference, and the CRC separates
 * a torn write from a flipped byte.
 *
 * `byteLen` counts **bytes**, not characters, and the frame is assembled as a
 * `Buffer` for that reason: a `String.length` implementation of the same field
 * is off by one per astral character, which is the +5-rows defect
 * `docs/research/2026-08-29-shared-record-s2-concurrent-actors.md` measured one
 * layer over.
 */

/** Magic + version. A file whose first frame does not carry this is refused at open, by name. */
export const JOURNAL_MAGIC = 'RZJ1'

/** One entry of one batch, as the wire delivered it. */
export interface JournalBatchEntry {
  readonly n: number
  readonly line: string
}

/** What one journal record carries. `seq` and `receivedAtMs` are the journal's; the rest is the request's. */
export interface JournalEntry {
  readonly seq: number
  readonly receivedAtMs: number
  readonly project: string
  readonly actorInstance: string
  readonly batch: readonly JournalBatchEntry[]
}

export interface JournalHeader {
  readonly seq: number
  readonly byteLen: number
  readonly crc: string
}

export type ParseHeaderResult = { ok: true; header: JournalHeader } | { ok: false; error: string }

export type DecodeEntryResult = { ok: true; entry: JournalEntry } | { ok: false; error: string }

/** `zlib.crc32` as the eight lowercase hex digits the header carries. Node >= 22.2; this repo's floor is 22.22.2. */
export function crc32Hex(payload: Uint8Array): string {
  return (crc32(payload) >>> 0).toString(16).padStart(8, '0')
}

/** The header line for a payload, without its trailing newline. */
export function encodeHeader(seq: number, payload: Uint8Array): string {
  return `${JOURNAL_MAGIC} ${seq} ${payload.byteLength} ${crc32Hex(payload)}`
}

/**
 * One entry to the bytes that go on disk — header line, payload, terminator —
 * as ONE buffer, so a partial write can only ever truncate the tail.
 */
export function encodeFrame(entry: JournalEntry): Buffer {
  const payload = Buffer.from(JSON.stringify(entry), 'utf8')
  const header = Buffer.from(`${encodeHeader(entry.seq, payload)}\n`, 'utf8')
  return Buffer.concat([header, payload, Buffer.from('\n', 'utf8')])
}

/**
 * The header grammar, refusing each part by name.
 *
 * Named refusals rather than one "bad header": the reader turns a header that
 * does not parse into an abort that has to tell an operator which byte offset
 * to look at and what was wrong there, and "malformed" is not that.
 */
export function parseHeaderLine(line: string): ParseHeaderResult {
  const parts = line.split(' ')
  if (parts.length !== 4) {
    return {
      ok: false,
      error: `journal header must be four space-separated fields (magic seq byteLen crc32), saw ${parts.length} in ${JSON.stringify(line.slice(0, 120))}`,
    }
  }
  const [magic = '', seqText = '', lenText = '', crcText = ''] = parts
  if (magic !== JOURNAL_MAGIC) {
    return {
      ok: false,
      error: `journal magic is ${JSON.stringify(magic)}, and this build writes and reads ${JOURNAL_MAGIC} only`,
    }
  }
  if (!/^\d+$/.test(seqText) || Number(seqText) < 1) {
    return { ok: false, error: `journal header seq must be a positive decimal integer, saw ${JSON.stringify(seqText)}` }
  }
  if (!/^\d+$/.test(lenText)) {
    return {
      ok: false,
      error: `journal header byteLen must be a decimal byte count, saw ${JSON.stringify(lenText)}`,
    }
  }
  if (!/^[0-9a-f]{8}$/.test(crcText)) {
    return {
      ok: false,
      error: `journal header crc must be eight lowercase hex digits, saw ${JSON.stringify(crcText)}`,
    }
  }
  return { ok: true, header: { seq: Number(seqText), byteLen: Number(lenText), crc: crcText } }
}

/** The payload bytes to an entry. Shape-checked, because a CRC proves the bytes and not their meaning. */
export function decodeEntry(payload: Uint8Array): DecodeEntryResult {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(payload).toString('utf8'))
  } catch (cause) {
    return { ok: false, error: `journal payload is not JSON: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: `journal payload is not an object, it is ${typeof value}` }
  }
  const record = value as Record<string, unknown>
  if (typeof record.seq !== 'number' || typeof record.receivedAtMs !== 'number') {
    return { ok: false, error: 'journal payload is missing a numeric seq or receivedAtMs' }
  }
  if (typeof record.project !== 'string' || typeof record.actorInstance !== 'string') {
    return { ok: false, error: 'journal payload is missing project or actorInstance' }
  }
  if (!Array.isArray(record.batch)) {
    return { ok: false, error: 'journal payload has no batch array' }
  }
  const batch: JournalBatchEntry[] = []
  for (const raw of record.batch) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: 'journal payload batch holds something that is not an entry' }
    }
    const entry = raw as Record<string, unknown>
    if (typeof entry.n !== 'number' || typeof entry.line !== 'string') {
      return { ok: false, error: 'journal payload batch entry is missing a numeric n or a string line' }
    }
    batch.push({ n: entry.n, line: entry.line })
  }
  return {
    ok: true,
    entry: {
      seq: record.seq,
      receivedAtMs: record.receivedAtMs,
      project: record.project,
      actorInstance: record.actorInstance,
      batch,
    },
  }
}
