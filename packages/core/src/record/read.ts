import {
  readEventLineLenient,
  type RhizomorphEvent,
  type UnknownEventLine,
} from '../events/index.js'
import type { RecordLink, SessionRecord } from './schema.js'

/**
 * Reading a record's body back into events — leniently (prd17 ruling 3, item
 * 1). The one reader every consumer of a `SessionRecord`'s body goes through,
 * so "an unrecognized line is counted, preserved and voiced, never dropped" is
 * settled in one place rather than re-argued by the verifier, the merge and the
 * era corpus separately.
 *
 * Before this existed, every one of those three called `lineToEvent` and did
 * something different with a failure: the verifier refused the whole artifact,
 * the merge refused it too, and the CLI's replay path skipped the line with a
 * comment saying the verifier had already vouched for it. That is three
 * behaviours for one fact, and none of them was "count it and say so".
 */
export interface RecordBodyRead {
  /** Everything this era can fold, in body order. */
  events: RhizomorphEvent[]
  /** Everything it counted but could not fold, in body order, byte-for-byte. */
  unknown: UnknownEventLine[]
  /**
   * The FIRST line that is not an event at all — no envelope, or no usable
   * timestamp. Null when there was none.
   *
   * This stays a hard failure rather than becoming a third kind of unknown: a
   * line the chain vouches for and that still carries no envelope is a broken
   * emitter, not a later era, and calling it "from a newer era" would be a
   * comforting lie. Reading continues past it (so a caller that wants the whole
   * picture has it) and only the first one is named — the same "name where it
   * broke, once" discipline `verifyRecord` already follows.
   */
  malformed: { lineNumber: number; detail: string } | null
}

/** Reads a body's links in order. Never throws; a bad line is a value, not an exception. */
export function readRecordBody(body: readonly RecordLink[]): RecordBodyRead {
  const events: RhizomorphEvent[] = []
  const unknown: UnknownEventLine[] = []
  let malformed: RecordBodyRead['malformed'] = null

  for (let i = 0; i < body.length; i += 1) {
    const lineNumber = i + 1
    const parsed = readEventLineLenient(body[i]!.line, lineNumber)
    if (parsed.kind === 'event') {
      events.push(parsed.event)
    } else if (parsed.kind === 'unknown') {
      unknown.push(parsed.unknown)
    } else if (malformed === null) {
      malformed = { lineNumber, detail: parsed.error }
    }
  }

  return { events, unknown, malformed }
}

/** {@link readRecordBody} over a whole record — the shape a caller holding a `SessionRecord` wants. */
export function readRecord(record: SessionRecord): RecordBodyRead {
  return readRecordBody(record.body)
}

/**
 * The timestamps a record's body actually spans, unknowns included.
 *
 * Unknowns count here on purpose: `manifest.startTs`/`endTs` describe every
 * line in the body, so leaving a newer era's events out of the range would make
 * an honest manifest look tampered with — the exact failure that used to make
 * `verifyRecord` refuse such a record outright. Every unknown carries a valid
 * `ts` (a line without one is malformed, not unknown), so this is total.
 */
export function bodyTsRange(read: RecordBodyRead): { minTs: number; maxTs: number } | null {
  let minTs: number | null = null
  let maxTs: number | null = null
  for (const ts of [...read.events.map((event) => event.ts), ...read.unknown.map((entry) => entry.ts)]) {
    minTs = minTs === null ? ts : Math.min(minTs, ts)
    maxTs = maxTs === null ? ts : Math.max(maxTs, ts)
  }
  return minTs === null || maxTs === null ? null : { minTs, maxTs }
}
