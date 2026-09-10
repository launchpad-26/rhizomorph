import { setTimeout as realDelay } from 'node:timers/promises'
import { readTeamConfig, type TeamConfig } from './config.js'
import { readCursor, type ActorSkip } from './cursor.js'
import { ingestKeyMode, ingestKeyPresent } from './key.js'
import type { FetchLike } from './post.js'
import { shipOnce, type ShipPassResult } from './ship.js'

/**
 * THE CLOCK, AND THE ONE PROCESS ALLOWED TO HOLD IT (ADR-0034 clause 3).
 *
 * This module defines the timer. It does not start one: `runShipperLoop` is
 * constructed at exactly one site in the codebase,
 * `cli/connect-team.ts`'s `--ship` branch, in the foreground of a process a
 * human started and can see. `hand-law.test.ts`'s clause 3b sweeps every
 * non-test source under `packages/server/src` and `packages/web/src` for the
 * identifiers `runShipperLoop` and `shipOnce` and allows exactly that one
 * file.
 *
 * **Why clause 3b is a call-site sweep and not another graph clause**, stated
 * here as well as in the law so nobody "repairs" it back: the chain
 * `server/build-app.ts → api/index.ts → api/lab.ts → cli/index.ts` already
 * exists on `main` (`api/lab.ts` invokes `runCli` for prd53 ruling 3's measure
 * route). The moment `connect` joins `cli/index.ts`'s dispatch table — which
 * `cli-surface-law.test.ts` requires of any new top-level subcommand — the
 * hand is statically reachable from the Fastify app, and no graph-shaped law
 * can separate "boot could reach it" from "boot does reach it".
 *
 * **A failing pass never ends the loop.** It is reported and the next tick
 * retries; the wire's `(project, actorInstance, n)` key makes a repeated batch
 * free, so retrying costs nothing a server has to reconcile.
 */

/** The default cadence. A batch timer, not a stream: a team view is a picture of the last minute, not of the last keystroke. */
export const DEFAULT_INTERVAL_MS = 30_000

/** Below this, `--interval` is clamped and says so. A five-second floor is already far under any cadence a team view needs. */
export const MIN_INTERVAL_MS = 5_000

/**
 * The report seam.
 *
 * The hand writes NOTHING to stdout or stderr itself — `cli/connect-team.ts`
 * prints. Two reasons, and the second is the load-bearing one: a caller that
 * wants a machine-readable pass result should not have to scrape it back out
 * of a line of prose, and `hand-law.test.ts`'s clause-2 `logsAKey` sweep reads
 * a log call's entire argument span for a key-ish substring, so even a
 * value-free `log.warn('no ingest key here')` under `shipper/` would redden
 * the build.
 */
export interface ShipperLog {
  /** One pass finished — the whole result, never a rendered line. */
  pass?: (result: ShipPassResult) => void
  /** A pass threw. The message only; the hand never re-throws a credential-bearing error, and `no-key-in-output-law.test.ts` runs a server that tries to make it. */
  error?: (message: string) => void
}

export interface ShipperLoopOptions {
  sessionDir: string
  intervalMs?: number
  /** Run exactly one pass and return. `--once`. */
  once?: boolean
  /** `SIGINT`/`SIGTERM`, wired by the CLI, so the loop ends on the tick boundary rather than after a whole interval. */
  signal?: AbortSignal
  now?: () => number
  fetch?: FetchLike
  log?: ShipperLog
  /**
   * The wait between ticks. Injected so a test asserts the intervals actually
   * requested rather than racing a wall clock — the default is
   * `node:timers/promises`' `setTimeout` with the abort signal passed through,
   * which is what makes Ctrl-C end the process now instead of at the next
   * tick.
   */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface ShipperLoopResult {
  passes: number
  /** Every interval actually waited, in order. Empty for `--once`. */
  waits: number[]
  /** True when `intervalMs` was below {@link MIN_INTERVAL_MS} and raised to it. */
  clamped: boolean
  intervalMs: number
}

export function resolveIntervalMs(requested: number | undefined): { intervalMs: number; clamped: boolean } {
  if (requested === undefined) return { intervalMs: DEFAULT_INTERVAL_MS, clamped: false }
  if (requested < MIN_INTERVAL_MS) return { intervalMs: MIN_INTERVAL_MS, clamped: true }
  return { intervalMs: requested, clamped: false }
}

export async function runShipperLoop(options: ShipperLoopOptions): Promise<ShipperLoopResult> {
  const { intervalMs, clamped } = resolveIntervalMs(options.intervalMs)
  const delay =
    options.delay ??
    ((ms: number, signal?: AbortSignal) => realDelay(ms, undefined, { signal }))
  const waits: number[] = []
  let passes = 0
  // A function, not an inline `options.signal?.aborted === true` at both sites:
  // the second read happens after an `await` and TS would otherwise narrow it
  // to the first read's answer and call the check unreachable.
  const aborted = (): boolean => options.signal?.aborted === true

  for (;;) {
    if (aborted()) break

    passes += 1
    try {
      const result = await shipOnce({
        sessionDir: options.sessionDir,
        fetch: options.fetch,
        now: options.now,
      })
      options.log?.pass?.(result)
    } catch (err) {
      options.log?.error?.(err instanceof Error ? err.message : String(err))
    }

    if (options.once === true) break
    if (aborted()) break

    waits.push(intervalMs)
    try {
      await delay(intervalMs, options.signal)
    } catch {
      // `AbortError` is how `node:timers/promises` says the signal fired
      // mid-wait. That is the loop ending on request, not a failure.
      break
    }
  }

  return { passes, waits, clamped, intervalMs }
}

export interface ShipperActorStatus {
  actorInstance: string
  n: number
  offset: number
  lastAckAt: number
  skippedCount: number
  skipped: ActorSkip[]
}

export interface ShipperStatus {
  enabled: boolean
  url: string | null
  project: string | null
  enabledAt: number | null
  /** Presence only. The value is never read here and there is no method on this shape that could return it. */
  keyPresent: boolean
  /** POSIX permission bits, or `null` on win32 and when there is no file. */
  keyMode: number | null
  actors: ShipperActorStatus[]
  cursorReset: string | null
}

/** The read-only report `--status` prints and `doctor` summarises. Reads the cursor and the enable record; never the credential's value. */
export async function shipperStatus(sessionDir: string): Promise<ShipperStatus> {
  const config: TeamConfig | null = await readTeamConfig(sessionDir)

  if (config === null) {
    return {
      enabled: false,
      url: null,
      project: null,
      enabledAt: null,
      keyPresent: false,
      keyMode: null,
      actors: [],
      cursorReset: null,
    }
  }

  const { cursor, reset } = await readCursor(sessionDir)
  const actors = Object.entries(cursor.actors)
    .map(([actorInstance, entry]) => ({
      actorInstance,
      n: entry.n,
      offset: entry.offset,
      lastAckAt: entry.lastAckAt,
      skippedCount: entry.skippedCount,
      skipped: entry.skipped,
    }))
    .sort((a, b) => a.actorInstance.localeCompare(b.actorInstance))

  return {
    enabled: true,
    url: config.url,
    project: config.project,
    enabledAt: config.enabledAt,
    keyPresent: await ingestKeyPresent(sessionDir),
    keyMode: await ingestKeyMode(sessionDir),
    actors,
    cursorReset: reset,
  }
}
