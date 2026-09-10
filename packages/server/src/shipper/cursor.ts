import { chmod, mkdir, readFile, rename as realRename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as realDelay } from 'node:timers/promises'
import { z } from 'zod'
// `config.ts` imports `writeAtomicJson` from here, so this import closes a
// cycle. Sound for the same one reason `log/session-log.ts` gives for its own:
// every binding on both sides is a hoisted `function` declaration read inside
// a function BODY, long after both module bodies have run. Do not move a path
// helper's call to module scope on either side.
import { cursorPath, shipperDirFor } from './config.js'

/**
 * RULING 7'S ONE CURSOR FILE — offset **and** `n`, per actor, written
 * tmp-then-rename, with no local database anywhere near it.
 *
 * Two halves live here because they are the same fact from two ends: the
 * cursor's shape, and the only write protocol this hand is allowed to use.
 * {@link writeAtomicJson} is shared with `config.ts` rather than copied into
 * it — a second atomic-write implementation is a second place for the Windows
 * `EBUSY` answer to be forgotten.
 *
 * **Why the cursor is offset AND `n`.** `splitLines` produces both from one
 * byte scan (`packages/core/src/wire/split.ts`), and the wire's dedup key is
 * `(project, actorInstance, n)`. Persisting only the offset would restart `n`
 * at 1 on every resume and silently collide; persisting only `n` would force a
 * whole-file rescan per tick.
 *
 * **Corrupt is cold, never half-trusted.** An unparseable file, a wrong
 * `version`, a non-object `actors`, or a negative/non-integer `offset`/`n`
 * yields a cold start plus a named `reset` reason a human can read. The file
 * is not repaired in place and not deleted: the next successful pass
 * overwrites it, and until then the evidence is still on disk. A partially
 * believed cursor is exactly how `n` desyncs.
 */

/** One line this build could not fold, recorded so a gap in `n` can always be named (prd-51 ruling 3, and this issue's ruling A). */
export interface ActorSkip {
  /** The ledger position that was consumed and not sent. */
  n: number
  kind: 'unknown' | 'malformed'
  /** What the re-serializer said, verbatim enough to investigate. Never input bytes — `reserializeLine` does not hand any back. */
  reason: string
}

export interface ActorCursor {
  /** Byte offset one past the last line whose batch was acknowledged. */
  offset: number
  /** Ledger position of that same line. Zero before anything has shipped. */
  n: number
  /** Local wall clock of the last acknowledged batch. Never crosses the wire. */
  lastAckAt: number
  /** Every skip ever recorded for this actor, not just the ones still listed below. */
  skippedCount: number
  /** The most recent {@link MAX_RECORDED_SKIPS}, newest last. */
  skipped: ActorSkip[]
}

export interface ShipperCursor {
  version: 1
  /** Keyed by `actorInstance` — the session id, exactly as `cli/export-record.ts` puts it in `actor.instance`. */
  actors: Record<string, ActorCursor>
}

/** A cursor file is a report as well as a resume point; an unbounded skip list would make it neither. */
export const MAX_RECORDED_SKIPS = 20

export const CURSOR_VERSION = 1

const nonNegativeInteger = z.number().int().nonnegative()

export const actorSkipSchema = z.object({
  n: z.number().int().positive(),
  kind: z.union([z.literal('unknown'), z.literal('malformed')]),
  reason: z.string(),
})

export const actorCursorSchema = z.object({
  offset: nonNegativeInteger,
  n: nonNegativeInteger,
  lastAckAt: nonNegativeInteger,
  skippedCount: nonNegativeInteger,
  skipped: z.array(actorSkipSchema),
})

export const shipperCursorSchema = z.object({
  version: z.literal(CURSOR_VERSION),
  actors: z.record(z.string(), actorCursorSchema),
})

/** Where an actor starts when nothing on disk knows about it. */
export function coldActorCursor(): ActorCursor {
  return { offset: 0, n: 0, lastAckAt: 0, skippedCount: 0, skipped: [] }
}

export function emptyCursor(): ShipperCursor {
  return { version: CURSOR_VERSION, actors: {} }
}

/**
 * The one clock in this hand, and it is deliberately here rather than in
 * `ship.ts`.
 *
 * The 2026-09-08 amendment's invariant is that the shipper never computes a
 * `ts`: what crosses the wire is the `ts` the ledger line already carried.
 * `lastAckAt` is the single exception, it never crosses the wire, and it
 * belongs to the cursor — so the clock sits beside the field it fills, and
 * `ts-invariant.test.ts` can sweep every other source in this directory for
 * `Date.now(` and expect nothing.
 */
export function defaultClock(): number {
  return Date.now()
}

/** `EBUSY`, `EPERM` and `EACCES` — the three ways win32 says "another process is holding this". */
export function isBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

/**
 * The named refusal a caller can branch on without matching on message text.
 * `busy` is a own-property flag rather than a subclass check so it survives
 * the structured-clone and cross-realm cases an `instanceof` does not.
 */
export class ShipperBusyError extends Error {
  readonly busy = true
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'ShipperBusyError'
    this.code = code
  }
}

/** `true` for the refusal {@link writeAtomicFile} raises when a rename stayed busy through every retry. */
export function isShipperBusy(err: unknown): err is ShipperBusyError {
  return (err as { busy?: unknown } | null)?.busy === true
}

/**
 * The rename backoff. Three retries, so four attempts in all — sized to a
 * rotation or a prune holding the file for a moment, not to an operator who
 * left a second `--ship` running, which is a state to name rather than to
 * wait out.
 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 150, 400]

export interface AtomicWriteSeams {
  /** Injected so `EBUSY` is exercised on every platform, not only where the OS supplies it. */
  rename?: (from: string, to: string) => Promise<void>
  /** Injected so the backoff is asserted by the values requested rather than by a wall clock. */
  delay?: (ms: number) => Promise<void>
  /** The noun in the busy message — "cursor", "team configuration", … */
  what?: string
}

/**
 * Write a file the only way this hand is allowed to: serialize, write a
 * sibling `.tmp` at the intended mode, rename over the target.
 *
 * **No `fsync`, deliberately** (ruling 4's reasoning, one layer down): every
 * reachable post-crash state is behind-or-equal to what the server already
 * acknowledged, so the worst a lost write costs is a replay, and the
 * `(project, actorInstance, n)` key makes a replay free.
 *
 * **`EBUSY` is answered by name, never swallowed** (ruling 7). On win32 a
 * rename over a file another process holds open throws `EBUSY`/`EPERM`; three
 * backed-off retries cover a rotation, and past that the caller is told which
 * file and what to close.
 */
export async function writeAtomicFile(
  target: string,
  body: string,
  mode: number,
  seams: AtomicWriteSeams = {},
): Promise<void> {
  const rename = seams.rename ?? realRename
  const delay = seams.delay ?? ((ms: number) => realDelay(ms))
  const what = seams.what ?? 'file'
  const temporary = `${target}.tmp`

  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(temporary, body, { mode })
  // `writeFile`'s `mode` applies only when it CREATES the file, so a leftover
  // `.tmp` from an earlier run at a laxer mode would silently be reused. The
  // chmod is what makes "written again" and "written the first time" the same
  // fact, which is `key.test.ts`'s repetition case.
  await chmodQuietly(temporary, mode)

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, target)
      return
    } catch (err) {
      if (!isBusyError(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        await unlinkQuietly(temporary)
        if (!isBusyError(err)) throw err
        const code = String((err as { code?: unknown }).code)
        throw new ShipperBusyError(
          `the shipper ${what} is held by another process (${code}): ${target} — ` +
            'close any other `rhizomorph connect team --ship` for this repo and re-run',
          code,
        )
      }
      await delay(RENAME_RETRY_DELAYS_MS[attempt] as number)
    }
  }
}

/** {@link writeAtomicFile} over `JSON.stringify` — the shape every JSON file this hand owns is written with. */
export async function writeAtomicJson(
  target: string,
  value: unknown,
  mode: number,
  seams: AtomicWriteSeams = {},
): Promise<void> {
  await writeAtomicFile(target, `${JSON.stringify(value, null, 2)}\n`, mode, seams)
}

async function chmodQuietly(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode)
  } catch {
    // win32 has no POSIX permission bits worth setting here, and a chmod
    // failure must never cost the write itself.
  }
}

async function unlinkQuietly(target: string): Promise<void> {
  try {
    await unlink(target)
  } catch {
    // Nothing to clean up is the common case; a failure to clean up is not a
    // reason to lose the error that got us here.
  }
}

export interface CursorRead {
  cursor: ShipperCursor
  /** A human-readable reason the on-disk cursor was not trusted, or `null`. Surfaced by `--status` and `doctor`. */
  reset: string | null
}

/**
 * Reads ruling 7's cursor. Absent is a cold start with no complaint; corrupt
 * is a cold start WITH one. A single actor whose numbers do not validate
 * resets that actor alone — the others have nothing to do with it and losing
 * their positions would cost a whole-ledger replay for one bad entry.
 */
export async function readCursor(sessionDir: string): Promise<CursorRead> {
  const file = cursorPath(sessionDir)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return { cursor: emptyCursor(), reset: null }
    return { cursor: emptyCursor(), reset: `${file} could not be read (${describe(err)}); starting from the beginning` }
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (err) {
    return { cursor: emptyCursor(), reset: `${file} is not valid JSON (${describe(err)}); starting from the beginning` }
  }

  const envelope = z.object({ version: z.unknown(), actors: z.unknown() }).safeParse(decoded)
  if (!envelope.success) {
    return { cursor: emptyCursor(), reset: `${file} is not a cursor object; starting from the beginning` }
  }
  if (envelope.data.version !== CURSOR_VERSION) {
    return {
      cursor: emptyCursor(),
      reset: `${file} is version ${JSON.stringify(envelope.data.version)}, not ${CURSOR_VERSION}; starting from the beginning`,
    }
  }
  const actorsValue = envelope.data.actors
  if (typeof actorsValue !== 'object' || actorsValue === null || Array.isArray(actorsValue)) {
    return { cursor: emptyCursor(), reset: `${file} has no actors object; starting from the beginning` }
  }

  const cursor = emptyCursor()
  const rejected: string[] = []
  for (const [actorInstance, entry] of Object.entries(actorsValue as Record<string, unknown>)) {
    const parsed = actorCursorSchema.safeParse(entry)
    if (!parsed.success) {
      rejected.push(actorInstance)
      continue
    }
    cursor.actors[actorInstance] = parsed.data
  }

  if (rejected.length > 0) {
    return {
      cursor,
      reset: `${file} holds an unusable entry for ${rejected.sort().join(', ')}; ${
        rejected.length === 1 ? 'that actor starts' : 'those actors start'
      } from the beginning`,
    }
  }

  return { cursor, reset: null }
}

/** Writes ruling 7's cursor. Mode `0644`: it is a resume point and a report, never a credential. */
export async function writeCursor(
  sessionDir: string,
  cursor: ShipperCursor,
  seams: AtomicWriteSeams = {},
): Promise<void> {
  await mkdir(shipperDirFor(sessionDir), { recursive: true })
  await writeAtomicJson(cursorPath(sessionDir), cursor, 0o644, { what: 'cursor', ...seams })
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
