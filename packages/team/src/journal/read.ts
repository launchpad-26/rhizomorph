import { readFileSync } from 'node:fs'
import { type JournalEntry, crc32Hex, decodeEntry, parseHeaderLine } from './format.js'

/**
 * READING THE JOURNAL BACK — torn versus corrupt (prd-51 ruling 4, ADR-0046).
 *
 * Ruling 4: *"a torn tail on the journal is legal only at EOF and reads as
 * never-acked; a parse failure anywhere earlier aborts loudly."* Those are two
 * verdicts on what a naive reader sees as one observation, and separating them
 * is the whole reason the frame carries a byte length and a CRC.
 *
 * **"Torn implies never-acked" is not an extra rule — it is a consequence of
 * the write ordering.** A record only becomes complete-and-fsynced *before* its
 * 202 is written (`journal.ts`'s `append`, and `../ingest/handle.ts`'s
 * ordering), so a record that is torn at EOF can never have been acked. That
 * sentence is the whole durability argument, and it is why the reader is
 * allowed to drop a torn tail rather than escalate it.
 *
 * The walk is over a `Buffer` and never over a decoded string. Decoding first
 * and indexing the result is the defect
 * `docs/research/2026-08-29-shared-record-s2-concurrent-actors.md` measured as
 * five extra rows on a 25,000-line file: a byte offset and a UTF-16 code-unit
 * offset are not the same number.
 *
 * Refusals are `{ ok: false, error }` and never a throw — the shape
 * `parseIngestRequest` and `runMigrations` already use.
 *
 * ## The decision table, in the order the code applies it
 *
 * | observation | verdict |
 * |---|---|
 * | zero bytes remain | clean EOF |
 * | header line has no `\n` before EOF | torn |
 * | header line is complete but does not match the grammar | corrupt |
 * | header parses, fewer than `byteLen + 1` bytes remain | torn |
 * | header parses, CRC mismatches, nothing follows this record | torn |
 * | header parses, CRC mismatches, bytes follow it | corrupt |
 * | header parses, CRC matches, the terminator is not `\n` | corrupt |
 * | header parses, CRC matches, payload will not decode | corrupt |
 * | header parses, CRC matches, `seq` is not `previous + 1` | corrupt |
 */

/** One record read back, with the byte offset its header started at. */
export interface JournalRecord {
  readonly seq: number
  readonly offset: number
  readonly entry: JournalEntry
}

/** `clean` — the file ended on a record boundary. `torn` — the last record was never completed. */
export type JournalVerdict = 'clean' | 'torn'

export type ReadJournalResult =
  | { ok: true; verdict: JournalVerdict; records: JournalRecord[]; lastSeq: number }
  | { ok: false; error: string }

const NEWLINE = 0x0a

/** Reads the file, treating a missing file as an empty journal rather than an error. */
function readBytes(path: string): { ok: true; bytes: Buffer } | { ok: false; error: string } {
  try {
    return { ok: true, bytes: readFileSync(path) }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, bytes: Buffer.alloc(0) }
    return {
      ok: false,
      error: `journal ${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}

/**
 * Walks the whole journal from byte 0 and returns the records after `fromSeq`.
 *
 * The walk always starts at 0 even when `fromSeq` skips most of it, because
 * `seq = previous + 1` is a property of the *chain*: starting mid-file would
 * make a gap unobservable, and a gap is exactly the corruption this reader is
 * for.
 */
export function readJournal(path: string, fromSeq = 0): ReadJournalResult {
  const read = readBytes(path)
  if (!read.ok) return { ok: false, error: read.error }
  const bytes: Buffer = read.bytes

  const records: JournalRecord[] = []
  let offset = 0
  let previousSeq = 0

  const torn = (): ReadJournalResult => ({
    ok: true,
    verdict: 'torn',
    records: records.filter((r) => r.seq > fromSeq),
    lastSeq: previousSeq,
  })
  const corrupt = (at: number, why: string): ReadJournalResult => ({
    ok: false,
    error: `journal ${path} is corrupt at byte offset ${at}, and bytes follow it, so this is not a torn tail: ${why}`,
  })

  while (offset < bytes.length) {
    const newlineAt = bytes.indexOf(NEWLINE, offset)
    if (newlineAt === -1) return torn()

    const headerText = bytes.toString('utf8', offset, newlineAt)
    const header = parseHeaderLine(headerText)
    if (!header.ok) return corrupt(offset, header.error)

    const payloadStart = newlineAt + 1
    const payloadEnd = payloadStart + header.header.byteLen
    // The record is complete only with its terminator: `byteLen + 1` bytes.
    if (payloadEnd + 1 > bytes.length) return torn()

    const payload = bytes.subarray(payloadStart, payloadEnd)
    const isLast = payloadEnd + 1 === bytes.length
    if (crc32Hex(payload) !== header.header.crc) {
      if (isLast) return torn()
      return corrupt(offset, `crc32 is ${crc32Hex(payload)} but the header claims ${header.header.crc}`)
    }
    if (bytes[payloadEnd] !== NEWLINE) {
      return corrupt(offset, `the byte after the ${header.header.byteLen}-byte payload is not the frame terminator`)
    }

    const decoded = decodeEntry(payload)
    if (!decoded.ok) return corrupt(offset, decoded.error)
    if (decoded.entry.seq !== header.header.seq) {
      return corrupt(offset, `header seq ${header.header.seq} disagrees with payload seq ${decoded.entry.seq}`)
    }
    if (header.header.seq !== previousSeq + 1) {
      return corrupt(offset, `seq ${header.header.seq} does not follow ${previousSeq}; the journal is a gapless chain`)
    }

    records.push({ seq: header.header.seq, offset, entry: decoded.entry })
    previousSeq = header.header.seq
    offset = payloadEnd + 1
  }

  return { ok: true, verdict: 'clean', records: records.filter((r) => r.seq > fromSeq), lastSeq: previousSeq }
}
