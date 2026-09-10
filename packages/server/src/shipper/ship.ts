import { open, stat } from 'node:fs/promises'
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
 * once, and closed before anything is posted. That is what keeps
 * `rhizomorph rotate`, prune and archive able to move a session file on
 * Windows at all.
 */

/** One read per actor per tick. A ledger that grew more than this in one interval simply takes more ticks. */
export const MAX_READ_BYTES = 1_048_576

/** Entries per POST. The surplus is the next tick's work; the cursor only ever advances to what was acknowledged. */
export const MAX_BATCH_ENTRIES = 500

export type ShipActorFailure =
  /** Ruling B — the file is smaller than this actor's cursor. */
  | 'shrank'
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

  const wanted = Math.min(size - before.offset, MAX_READ_BYTES)
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
  // Closed BEFORE the post, never after: a descriptor held across a network
  // round trip is a descriptor held across a rotation on win32.
  await handle.close()

  const scan = splitLines(new Uint8Array(buffer.subarray(0, bytesRead)), before.offset, before.n)
  if (scan.lines.length === 0) return unchanged(null, null)

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
      skips.push({ n: line.n, kind: 'unknown', reason: `${verdict.type}: ${verdict.reason} — ${verdict.detail}` })
    } else {
      skips.push({ n: line.n, kind: 'malformed', reason: verdict.error })
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
