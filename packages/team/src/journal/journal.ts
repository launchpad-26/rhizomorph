import { closeSync, fsyncSync, ftruncateSync, openSync, writeSync } from 'node:fs'
import path from 'node:path'
import type { JournalFaults } from '../ingest/faults.js'
import { type JournalBatchEntry, encodeFrame } from './format.js'
import { readJournal } from './read.js'

/**
 * THE JOURNAL WRITE — real `writeSync`, real `fsyncSync` (prd-51 ruling 4).
 *
 * Ruling 4 makes the ingest 202 mean one thing: the batch is in a durable
 * journal. The measured alternative — accept fast into memory — lost exactly
 * one 500-line batch when the server died after its 202; ack-after-write-and-
 * fsync lost none in 75 kills across 1,129,197 lines
 * (`docs/research/2026-08-29-shared-record-s2-ack-after-journal.md`).
 *
 * So the syscalls here are the real ones, against a real file. Nothing in this
 * module is mocked in any test: the fault points in
 * `../ingest/faults.ts` inject *timing*, never a fake `writeSync`. A test that
 * replaced the syscall would be a test of the test double.
 *
 * ## ROTATION IS OUT OF SCOPE FOR v1, and this is where a reader looks for it
 *
 * Ruling 4's last sentence leaves journal rotation out of v1. Nothing here
 * truncates, renames, compacts or ages out a journal file, so a long-lived
 * server's journal grows without bound; ADR-0046 records that as known debt.
 * Adding rotation is a change to the *reader's* contract as much as the
 * writer's — `read.ts`'s chain rule is `seq = previous + 1` from byte 0, and a
 * rotated file breaks that by construction — so it is a decision with its own
 * ruling, not a helper someone drops in beside `append`.
 */

/** What a caller hands over; `seq` and `receivedAtMs` are the journal's to assign. */
export interface JournalAppendInput {
  readonly project: string
  readonly actorInstance: string
  readonly batch: readonly JournalBatchEntry[]
  readonly receivedAtMs: number
}

export interface AppendResult {
  readonly ok: true
  readonly seq: number
}

export interface Journal {
  readonly path: string
  /** The seq of the last durable record. 0 on an empty journal. */
  lastSeq(): number
  append(input: JournalAppendInput): AppendResult
  close(): void
}

export interface OpenJournalOptions {
  readonly path: string
  readonly hooks?: JournalFaults | undefined
  readonly trace?: ((step: string) => void) | undefined
}

export type OpenJournalResult = { ok: true; journal: Journal } | { ok: false; error: string }

/**
 * `writeSync` may write fewer bytes than it was given — that is legal on POSIX
 * and it is not an error. Looping is the difference between a short write being
 * invisible and a short write being a torn record every reader after it aborts on.
 */
function writeAll(fd: number, frame: Buffer): void {
  let written = 0
  while (written < frame.byteLength) {
    written += writeSync(fd, frame, written, frame.byteLength - written)
  }
}

/**
 * Makes the file's own directory entry durable.
 *
 * Skipped on Windows, and named rather than silently platform-sniffed: Windows
 * cannot open a directory as a file descriptor, so `openSync(dir)` fails with
 * EISDIR/EPERM there. The consequence is honest and small — on Windows a crash
 * between file creation and the first fsync can lose the *file*, not a record
 * inside it — and wave 4 is where this meets a real host.
 */
function fsyncDirectory(filePath: string): void {
  if (process.platform === 'win32') return
  const dirFd = openSync(path.dirname(filePath), 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/**
 * Truncates a torn tail away and makes the truncation itself durable.
 *
 * Its own `r+` descriptor rather than the append one below, deliberately:
 * `ftruncateSync` on an `O_APPEND` fd is a shape this repo has no reason to
 * rely on across three platforms, and ruling 7 makes Windows first class. The
 * `fsyncSync` is what stops a crash between the repair and the first append
 * from leaving the tear behind for the next boot to hit again.
 */
function truncateTorn(filePath: string, completeBytes: number): { ok: true } | { ok: false; error: string } {
  try {
    const fd = openSync(filePath, 'r+')
    try {
      ftruncateSync(fd, completeBytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return { ok: true }
  } catch (cause) {
    return {
      ok: false,
      error: `journal ${filePath} has a torn tail at byte ${completeBytes} that could not be truncated: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    }
  }
}

/**
 * Opens (or creates) a journal for appending.
 *
 * Refuses a file it cannot read back, by name — a wrong magic, a corrupt
 * interior record, a broken chain. Appending to a journal whose prefix cannot
 * be replayed would write records nobody can ever fold.
 *
 * **A torn tail is repaired here, not merely tolerated (#398).** `read.ts`
 * calls a torn tail legal — ruling 4 says a crash legitimately leaves one —
 * but "legal to read" and "safe to append to" are different claims, and the
 * gap between them is a `seq` collision that is guaranteed rather than
 * unlikely. A torn record was assigned `lastSeq + 1` before it was cut off, so
 * the next append is assigned that SAME number and writes it at the torn
 * record's own offset boundary. The result is a crc the reader cannot
 * reconcile with bytes following it — the definition of `corrupt` — and from
 * then on `readJournal` aborts at that offset, the complete records ahead of
 * it become unreadable through the normal path, and `api/main.ts`'s boot
 * returns `{ok:false}` on every subsequent start. One crash mid-write plus one
 * accepted batch is the whole recipe. So the torn bytes are truncated away
 * before the descriptor is opened for append, `fsync`ed, and the chain
 * continues gaplessly from the last complete record.
 *
 * This is NOT rotation, which ruling 4 leaves out of v1 and the module
 * docblock above records as known debt. Truncating a tail nothing ever acked
 * discards no acknowledged record; rotation ages out records that were.
 */
export function openJournal(options: OpenJournalOptions): OpenJournalResult {
  const existing = readJournal(options.path)
  if (!existing.ok) return { ok: false, error: `refusing to open journal: ${existing.error}` }

  if (existing.verdict === 'torn') {
    // #398: a torn tail is repaired here, not tolerated. Leaving the bytes in
    // place and opening 'a' is what escalates a LEGAL state into a permanent
    // one — see the seq argument in the docblock above.
    const repaired = truncateTorn(options.path, existing.completeBytes)
    if (!repaired.ok) return { ok: false, error: repaired.error }
    options.trace?.('journal.repair')
  }

  let seq = existing.lastSeq
  const fd = openSync(options.path, 'a')
  try {
    fsyncDirectory(options.path)
  } catch (cause) {
    closeSync(fd)
    return {
      ok: false,
      error: `journal ${options.path} could not be made durable: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }

  return {
    ok: true,
    journal: {
      path: options.path,

      lastSeq(): number {
        return seq
      },

      /**
       * The write, in this order and no other. Ordering 1's first half.
       *
       * Each hook is the instant a process death is simulated at; see
       * `../ingest/faults.ts`. The frame is one buffer, so a partial write can
       * only truncate the tail — which `read.ts` reads as torn, i.e. as
       * never-acked, because the 202 is written by the caller only after this
       * function returns.
       */
      append(input: JournalAppendInput): AppendResult {
        const next = seq + 1
        const frame = encodeFrame({
          seq: next,
          receivedAtMs: input.receivedAtMs,
          project: input.project,
          actorInstance: input.actorInstance,
          batch: input.batch,
        })

        options.hooks?.beforeWrite?.()
        writeAll(fd, frame)
        // The chain position advances with the BYTES, not with the fsync. They
        // are different facts: `fsyncSync` is where durability begins, and this
        // is where the file stops being able to accept `next` a second time. A
        // process that survives a fault between the two must not reuse the seq
        // it has already written, or the reader's `previous + 1` chain breaks.
        seq = next
        options.trace?.('journal.write')
        options.hooks?.afterWriteBeforeFsync?.()
        fsyncSync(fd)
        options.trace?.('journal.fsync')
        options.hooks?.afterFsync?.()

        return { ok: true, seq: next }
      },

      close(): void {
        closeSync(fd)
      },
    },
  }
}
