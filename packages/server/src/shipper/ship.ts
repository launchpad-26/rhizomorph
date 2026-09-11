import { open, stat, type FileHandle } from 'node:fs/promises'
import {
  reserializeLine,
  splitLines,
  type IngestBatchEntry,
} from '@rhizomorph/core/src/wire/index.js'
import { listSessions, sessionFilePath } from '../log/session-log.js'
import { readTeamConfig } from './config.js'
import {
  coldActorCursor,
  defaultClock,
  isShipperBusy,
  MAX_RECORDED_SKIPS,
  readCursor,
  recordedSkip,
  writeCursor,
  type ActorCursor,
  type ActorSkip,
  type ShipperCursor,
} from './cursor.js'
import { readIngestKey, type IngestKey } from './key.js'
import { postBatch, type FetchLike, type PostFailureReason } from './post.js'

/**
 * ONE PASS OF THE HAND — the whole fold, and the two policies wave 1 deferred
 * to this issue.
 *
 * **Ruling A: an unfoldable line is skipped, the skip is recorded, and the
 * cursor still advances.** `reserializeLine` returns a three-way verdict and
 * neither non-`line` arm carries any input bytes, so an unfoldable line
 * *cannot* be shipped — the only question is what happens to the cursor.
 * Refusing to advance wedges the hand permanently on one pre-#292-era line and
 * denies the whole ledger from that byte onward; inventing a placeholder
 * invents a wire shape protocol v1 has no arm for, which wave 1 forbids in
 * terms. So the position is consumed, nothing is sent for it, and the skip is
 * recorded with its `n`, its kind and its reason. Ruling 3's invariant is
 * restated for the local half at equal strength and more precisely: **no
 * duplicates in `n`, and every gap in `n` is a skip this machine recorded and
 * can name.** A gap nothing recorded is still a defect.
 *
 * **Ruling 15: a line longer than one read window is a skip too, and the
 * discriminator is `size - offset`, never the window's contents.** A window
 * with no newline in it has two causes and conflating them is the defect this
 * closes. When `size - before.offset` is at most {@link MAX_READ_BYTES} the
 * whole remainder was read and its tail is simply unterminated — a partial
 * write, and the answer is to wait. When it EXCEEDS the window and the full
 * window still holds no newline, the line is already a megabyte with no
 * terminator inside it and no amount of waiting shortens it: the position is
 * consumed, an `'oversized'` skip is recorded, and the cursor advances past
 * the WHOLE line — to the next newline, found by a bounded forward scan.
 * Advancing only past the window would ship the remainder as a fresh line and
 * put a fragment under a position. If no newline exists anywhere between the
 * cursor and EOF there is no boundary to advance to, and that arm — and only
 * that arm — names an `'oversized-unterminated'` failure. Before this, such a
 * ledger returned `ok: true` with an empty `failures` array on every tick,
 * forever.
 *
 * **Ruling B: a ledger file that shrank below its cursor is refused, never
 * re-read from 0.** `size < offset` means the file was replaced or truncated.
 * Restarting at 0 would re-send position `n` carrying *different bytes*, and
 * the server's `ON CONFLICT … DO NOTHING` keeps the FIRST row — so the
 * divergence would be silent and permanent, which is the one failure mode the
 * dedup key cannot absorb. That actor ships nothing, its cursor is untouched,
 * the failure is named, and every other actor in the pass still ships.
 *
 * **The `ts` invariant** (the 2026-09-08 amendment). Nothing in this module
 * reads, writes, defaults or clocks a `ts`. What crosses is
 * `eventToLine(parsedEvent)` and only that — dedup on the server is
 * per-partition, so a recomputed `ts` would duplicate silently at every month
 * boundary with no error anywhere. `ts-invariant.test.ts` asserts the shipped
 * `ts` is byte-equal to the line's own, and sweeps this directory for the
 * clock.
 *
 * **No descriptor is held across a tick.** Each actor's file is opened, read
 * from, and closed **before anything is posted**. Ruling 15's forward scan
 * reads more than once from that one handle, so "read once" is no longer the
 * invariant — the invariant that matters never was. That is what keeps
 * `rhizomorph rotate`, prune and archive able to move a session file on
 * Windows at all. The forward scan also does not trust the `size` it was
 * handed to stay true for its own duration: it classifies purely from what
 * each read actually returns, so a truncation landing mid-scan reads as the
 * file having changed, not as a confirmed absent terminator (#434).
 */

/** One read per actor per tick. A ledger that grew more than this in one interval simply takes more ticks. */
export const MAX_READ_BYTES = 1_048_576

/** Entries per POST. The surplus is the next tick's work; the cursor only ever advances to what was acknowledged. */
export const MAX_BATCH_ENTRIES = 500

/**
 * The forward scan's chunk. Ruling 15: the skip advances past the whole line,
 * and finding its end is a search for ONE BYTE — so the scan reads fixed
 * chunks and never holds the line resident. Reading the remainder into memory
 * to find the newline would reintroduce the unbounded allocation the ruling
 * rejects option 3 for.
 */
const SCAN_CHUNK_BYTES = 65_536

const NEWLINE_BYTE = 0x0a

export type ShipActorFailure =
  /** Ruling B — the file is smaller than this actor's cursor. */
  | 'shrank'
  /**
   * Ruling 15, the second arm — the next line is longer than the read window
   * AND has no terminator anywhere before EOF, so there is no line boundary to
   * advance to. A terminator that does not exist cannot be waited for and
   * cannot be skipped past, so this arm names a failure instead of advancing.
   */
  | 'oversized-unterminated'
  /** The file could not be read at all. */
  | 'unreadable'
  | PostFailureReason

export interface ShipActorResult {
  /** The session id, exactly the value `cli/export-record.ts` puts in `actor.instance`. */
  actorInstance: string
  /** Entries this pass sent and had acknowledged. */
  shipped: number
  /** Lines this pass consumed and did not send (ruling A). */
  skipped: number
  from: { offset: number; n: number }
  to: { offset: number; n: number }
  advanced: boolean
  reason: ShipActorFailure | null
  detail: string | null
}

export type ShipPassReason = 'no-credential' | 'cursor-busy'

export type ShipPassResult =
  | { enabled: false }
  | {
      enabled: true
      ok: boolean
      reason: ShipPassReason | null
      detail: string | null
      /** Set when the on-disk cursor could not be trusted and this pass cold-started. */
      cursorReset: string | null
      actors: ShipActorResult[]
      shipped: number
      skipped: number
      failures: string[]
    }

export interface ShipOnceOptions {
  /** The repo's data directory — `sessionDirFor(repoPath, dataRoot)`. */
  sessionDir: string
  fetch?: FetchLike
  /** Injected clock for `lastAckAt` only. Nothing here clocks a `ts`. */
  now?: () => number
  /** Test seam for the batch cap, so the 700-line case does not need 700 real lines to be slow about it. */
  maxBatchEntries?: number
}

export async function shipOnce(options: ShipOnceOptions): Promise<ShipPassResult> {
  const config = await readTeamConfig(options.sessionDir)
  if (config === null) return { enabled: false }

  const key = await readIngestKey(options.sessionDir)
  if (key === null) {
    return {
      enabled: true,
      ok: false,
      reason: 'no-credential',
      detail:
        'the shipper is enabled for this repo but its credential is missing — ' +
        're-run `rhizomorph connect team <url> --project <id>` with the value on stdin',
      cursorReset: null,
      actors: [],
      shipped: 0,
      skipped: 0,
      failures: [],
    }
  }

  const now = options.now ?? defaultClock
  const cap = options.maxBatchEntries ?? MAX_BATCH_ENTRIES
  const sessions = await listSessions(options.sessionDir)
  const { cursor, reset } = await readCursor(options.sessionDir)

  const next: ShipperCursor = { version: cursor.version, actors: { ...cursor.actors } }
  const actors: ShipActorResult[] = []
  let advancedAny = false

  for (const session of sessions) {
    const before = cursor.actors[session.id] ?? coldActorCursor()
    const outcome = await shipActor({
      session: { id: session.id, filePath: sessionFilePath(options.sessionDir, session.id) },
      before,
      config,
      key,
      cap,
      now,
      fetch: options.fetch,
    })
    actors.push(outcome.result)
    if (outcome.after !== null) {
      next.actors[session.id] = outcome.after
      advancedAny = true
    }
  }

  let passReason: ShipPassReason | null = null
  let passDetail: string | null = null
  if (advancedAny) {
    try {
      await writeCursor(options.sessionDir, next)
    } catch (err) {
      if (!isShipperBusy(err)) throw err
      // Nothing advanced in memory either: the next tick re-reads the on-disk
      // cursor and re-sends the identical batch, which the
      // `(project, actorInstance, n)` key makes free.
      passReason = 'cursor-busy'
      passDetail = err instanceof Error ? err.message : String(err)
    }
  }

  const failures = actors
    .filter((actor) => actor.reason !== null)
    .map((actor) => `${actor.actorInstance}: ${actor.reason} — ${actor.detail ?? ''}`.trimEnd())
  if (passDetail !== null) failures.push(passDetail)

  return {
    enabled: true,
    ok: failures.length === 0,
    reason: passReason,
    detail: passDetail,
    cursorReset: reset,
    actors,
    shipped: actors.reduce((sum, actor) => sum + actor.shipped, 0),
    skipped: actors.reduce((sum, actor) => sum + actor.skipped, 0),
    failures,
  }
}

/**
 * The forward scan's outcome: `'found'` with the absolute offset one past
 * the next newline at or after `from`; `'not-found'` when none exists
 * anywhere before `size`; or `'stale'` when a read partway through came back
 * shorter than it asked for — meaning `size` is no longer true and nothing
 * here proves the line lacks a terminator (#434).
 */
type FindLineEndOutcome = { kind: 'found'; end: number } | { kind: 'not-found' } | { kind: 'stale' }

/**
 * `size` is the size stat'd at the top of this tick, deliberately, not the
 * live end of file: a newline written AFTER the stat belongs to a line this
 * pass was never told about, and the next tick re-stats and sees it. That is
 * one-directional, though — this scan never trusts `size` for the OTHER
 * direction. A read at `at < size` against a file that genuinely still has
 * `size` bytes always returns exactly what it asked for
 * (`Math.min(SCAN_CHUNK_BYTES, size - at)` is already capped not to overrun
 * `size`); anything short of that means the file shrank underneath this scan
 * — a prune's unlink doesn't do this (an open POSIX descriptor keeps reading
 * the old bytes), but the recorder's own crash-resume truncation
 * (`session-log-writer.ts`'s `dropTrailingPartialLine`) does, and a future
 * compact or archive might too — and `'stale'` says so instead of reaching
 * `'not-found'` on a number that stopped being a fact one read ago. One
 * {@link SCAN_CHUNK_BYTES} buffer is allocated regardless of how long the
 * line turns out to be — the scan looks for a byte, so the line is never
 * resident.
 */
async function findLineEnd(handle: FileHandle, from: number, size: number): Promise<FindLineEndOutcome> {
  const chunk = Buffer.alloc(SCAN_CHUNK_BYTES)
  let at = from
  while (at < size) {
    const wanted = Math.min(SCAN_CHUNK_BYTES, size - at)
    const { bytesRead } = await handle.read(chunk, 0, wanted, at)
    const index = chunk.subarray(0, bytesRead).indexOf(NEWLINE_BYTE)
    if (index !== -1) return { kind: 'found', end: at + index + 1 }
    if (bytesRead < wanted) {
      // `size` was stat'd before this scan began. A read that comes back
      // with fewer bytes than it asked for, at a position still short of
      // `size`, means the file no longer HAS `size` bytes at `at` — the same
      // fact `shipActor`'s own first read guards with `bytesRead !== wanted`,
      // one level down. This can never happen while `size` is still true.
      return { kind: 'stale' }
    }
    at += bytesRead
  }
  return { kind: 'not-found' }
}

interface ShipActorInput {
  session: { id: string; filePath: string }
  before: ActorCursor
  config: { url: string; project: string }
  key: IngestKey
  cap: number
  now: () => number
  fetch: FetchLike | undefined
}

async function shipActor(
  input: ShipActorInput,
): Promise<{ result: ShipActorResult; after: ActorCursor | null }> {
  const { before, session } = input
  const from = { offset: before.offset, n: before.n }
  const unchanged = (reason: ShipActorFailure | null, detail: string | null): {
    result: ShipActorResult
    after: null
  } => ({
    result: {
      actorInstance: session.id,
      shipped: 0,
      skipped: 0,
      from,
      to: from,
      advanced: false,
      reason,
      detail,
    },
    after: null,
  })

  let size: number
  try {
    size = (await stat(session.filePath)).size
  } catch (err) {
    return unchanged('unreadable', err instanceof Error ? err.message : String(err))
  }

  if (size < before.offset) {
    // Ruling B.
    return unchanged(
      'shrank',
      `${session.filePath} is ${size} bytes but this machine has already shipped through byte ${before.offset} — ` +
        'the file was replaced or truncated, so re-reading it from the start would send different bytes under positions ' +
        'the team server has already accepted. Nothing was sent for this session and its cursor is untouched.',
    )
  }

  if (size === before.offset) return unchanged(null, null)

  const remaining = size - before.offset
  const wanted = Math.min(remaining, MAX_READ_BYTES)
  const buffer = Buffer.alloc(wanted)
  let bytesRead: number
  const handle = await open(session.filePath, 'r')
  try {
    const read = await handle.read(buffer, 0, wanted, before.offset)
    bytesRead = read.bytesRead
  } catch (err) {
    await handle.close()
    return unchanged('unreadable', err instanceof Error ? err.message : String(err))
  }

  const scan = splitLines(new Uint8Array(buffer.subarray(0, bytesRead)), before.offset, before.n)

  if (scan.lines.length === 0) {
    // Ruling 15's discriminator is `size - offset`, NOT the window's contents:
    // an empty scan means "no newline in what I read", which is a partial
    // write and an oversized line saying the same thing.
    //
    // `bytesRead !== wanted` is the third case and it is neither: the file
    // changed between the `stat` and the `read`, so `remaining` is no longer a
    // fact and the oversized verdict must not be reached on a stale one. The
    // next tick re-stats.
    if (remaining <= MAX_READ_BYTES || bytesRead !== wanted) {
      await handle.close()
      return unchanged(null, null)
    }

    let endScan: FindLineEndOutcome
    try {
      endScan = await findLineEnd(handle, before.offset + bytesRead, size)
    } catch (err) {
      await handle.close()
      return unchanged('unreadable', err instanceof Error ? err.message : String(err))
    }
    await handle.close()

    if (endScan.kind === 'stale') {
      // The bounded read above already guards its own version of this with
      // `bytesRead !== wanted`; this is the same guard one level down, for
      // the forward scan's later reads. Nothing here proves the line lacks a
      // terminator — `size` just stopped being true partway through the
      // scan — so this actor ships nothing and its cursor stays put, exactly
      // like the bounded read's own guard: the next tick re-stats and
      // re-decides from a fresh number (#434).
      return unchanged(null, null)
    }

    if (endScan.kind === 'not-found') {
      return unchanged(
        'oversized-unterminated',
        `${session.filePath} has ${remaining} bytes after byte ${before.offset} and no newline in any of ` +
          `them, so position ${before.n + 1} is a line larger than the ${MAX_READ_BYTES}-byte read window ` +
          'with no terminator to advance past. Nothing was sent for this session and its cursor is ' +
          'untouched; if the line is still being written it will terminate and then be SKIPPED past — a ' +
          'line this long is never sent — and if its writer died mid-line the ledger needs truncating at ' +
          'that byte.',
      )
    }

    const end = endScan.end

    // The skip is the whole of that actor's tick: nothing is posted, and the
    // lines behind the oversized one ship on the NEXT tick. That is not a
    // wedge — the cursor advanced, so each tick clears one oversized line —
    // and it keeps the one-read-per-actor-per-tick shape this module states.
    const skippedN = before.n + 1
    return {
      result: {
        actorInstance: session.id,
        shipped: 0,
        skipped: 1,
        from,
        to: { offset: end, n: skippedN },
        advanced: true,
        reason: null,
        detail: null,
      },
      after: {
        offset: end,
        n: skippedN,
        lastAckAt: input.now(),
        skippedCount: before.skippedCount + 1,
        skipped: [
          ...before.skipped,
          recordedSkip(
            skippedN,
            'oversized',
            `the line at byte ${before.offset} is ${end - before.offset - 1} bytes, larger than the ` +
              `${MAX_READ_BYTES}-byte read window, so this build could not read it in one window and did not send it`,
          ),
        ].slice(-MAX_RECORDED_SKIPS),
      },
    }
  }

  // Closed BEFORE the post, never after: a descriptor held across a network
  // round trip is a descriptor held across a rotation on win32.
  await handle.close()

  const batch: IngestBatchEntry[] = []
  const skips: ActorSkip[] = []
  let toOffset = before.offset
  let toN = before.n

  for (const line of scan.lines) {
    if (batch.length >= input.cap) break
    const verdict = reserializeLine(line.line)
    if (verdict.kind === 'line') {
      batch.push({ n: line.n, line: verdict.line })
    } else if (verdict.kind === 'unknown') {
      skips.push(recordedSkip(line.n, 'unknown', `${verdict.type}: ${verdict.reason} — ${verdict.detail}`))
    } else {
      skips.push(recordedSkip(line.n, 'malformed', verdict.error))
    }
    toOffset = line.endOffset
    toN = line.n
  }

  const after: ActorCursor = {
    offset: toOffset,
    n: toN,
    lastAckAt: input.now(),
    skippedCount: before.skippedCount + skips.length,
    skipped: [...before.skipped, ...skips].slice(-MAX_RECORDED_SKIPS),
  }

  if (batch.length === 0) {
    // Every line in this span was a skip. Ruling A still advances the cursor —
    // otherwise the hand re-reads and re-records the same skips forever.
    return {
      result: {
        actorInstance: session.id,
        shipped: 0,
        skipped: skips.length,
        from,
        to: { offset: toOffset, n: toN },
        advanced: true,
        reason: null,
        detail: null,
      },
      after,
    }
  }

  const posted = await postBatch({
    url: input.config.url,
    project: input.config.project,
    actorInstance: session.id,
    key: input.key,
    batch,
    fetch: input.fetch,
  })

  if (!posted.ok) {
    return unchanged(posted.reason, posted.detail)
  }

  return {
    result: {
      actorInstance: session.id,
      shipped: batch.length,
      skipped: skips.length,
      from,
      to: { offset: toOffset, n: toN },
      advanced: true,
      reason: null,
      detail: null,
    },
    after,
  }
}
