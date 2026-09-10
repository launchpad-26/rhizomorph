import { open, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { CheckpointRecord, RhizomorphEvent, SessionState } from '@rhizomorph/core'
import { type CollisionEntry, reduceAll, selectCollisionMap, selectFilesTouchedByBranch } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
import { listSessions, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import type { ServerContext } from '../server/context.js'
import { requireCapabilityToken } from './security.js'
import { parseTranscriptEntry, TRANSCRIPT_CHUNK_BYTES } from './transcript.js'

/**
 * THE FRAME READS THE FOLD'S OWN SERIES (prd-55 ruling 6 / S1, #402) —
 * `GET /api/lab/telemetry?lane=<handle>&atByte=<n>` and
 * `GET /api/lab/footprint?lane=<handle>`.
 *
 * The frame's telemetry position (1) and footprint position (5) used to state
 * a gap rather than draw a series from nothing: the fold already holds a
 * lane's OTel readings and the two core selectors that compute a branch's
 * footprint, but no lab route carried either. These two routes close both
 * gaps the same way `lab-transcript.ts` (wave 3) closed Trace's: reading the
 * fold directly, never through the fleet's own panels or routes (`buildFleet`,
 * `api/lab.ts`'s estimate) — this file imports neither.
 *
 * **Telemetry is byte-addressed, not wall-clock-addressed.** A checkpoint's
 * `sessionCutByte` is a position in the session file, and "what the fold held
 * by then" means by the WALL TIME the session had grown to that byte — never
 * `Date.now()`, which would silently drift as the read happens later than the
 * capture. That wall time is not stored anywhere; it is read back off the
 * session file itself, the same way `lab-transcript.ts` reads a transcript
 * back off it: the prefix up to `atByte` is scanned for the last line the log
 * itself timestamped (`parseTranscriptEntry`'s `ts`, the same field Trace
 * reads), and every `origin: 'otel'` telemetry record for the lane at or
 * before that instant is the slice. A byte with no timestamped line ahead of
 * it (the very start of a session) is an honest empty slice, not a refusal —
 * nothing could have been recorded yet.
 *
 * **Footprint is a straight read of two core selectors, decorated, never
 * filtered by them in practice.** `selectCollisionMap` is built from the
 * exact same per-branch touches `selectFilesTouchedByBranch` reads, so every
 * path the branch touched is already a key of the map — the "∩" ruling 6
 * describes is real (a future selector change that stopped agreeing would be
 * caught by it) but today's answer is `selectFilesTouchedByBranch(state,
 * lane)`, each path carrying the collision detail `selectCollisionMap` holds
 * for it, so the surface can say not just *what* the lane touched but whether
 * anything else has hands on it too.
 *
 * **A lane the fold has never seen answers a stated refusal for both
 * routes — never 404, never an empty success.** An empty array from an
 * unknown branch and an empty array from a known-but-quiet one are different
 * facts, and only core state (`state.checkpoints`, `state.branches`,
 * `state.worktrees`) decides which; the two selectors alone cannot, since an
 * unknown branch and a quiet one both fold to `[]`. Telemetry's byte bound is
 * the same shape: a byte past the session's real length is refused, not
 * quietly clamped or answered with nothing.
 *
 * Read-only: one verb each, the session file opened `'r'`, nothing written.
 */

// ── telemetry ────────────────────────────────────────────────────────────────

export interface LabTelemetryOptions {
  /** The streaming prefix scan's piece size. Tests use a tiny one. */
  chunkBytes?: number
}

export interface LabTelemetryReading {
  available: true
  lane: string
  atByte: number
  /**
   * Epoch ms — the last session-log line at or before `atByte` that carried
   * its own timestamp. `null` when the prefix held no such line (an honest
   * empty slice: nothing was recorded yet), in which case every array below
   * is empty.
   */
  asOf: number | null
  usage: UsageRecordLike[]
  costs: CostRecordLike[]
  tools: ToolActivityRecordLike[]
  activeTime: ActiveTimeRecordLike[]
}

export interface LabTelemetryAbsent {
  available: false
  lane: string
  /** WHAT is missing or refused → WHY → what to do (law 12). */
  reason: string
}

export type LabTelemetryResult = LabTelemetryReading | LabTelemetryAbsent

export interface ReadLabTelemetryRequest {
  events: readonly RhizomorphEvent[]
  lane: string
  atByte: number
  chunkBytes?: number | undefined
}

// Structural aliases rather than importing the fold's own record types by
// name into the wire shape — these travel over JSON verbatim, so the wire
// contract is exactly what the fold carries today, restated so a reader of
// this file does not have to open state.ts to know what a telemetry reading
// contains.
export type UsageRecordLike = SessionState['telemetry']['usage'][number]
export type CostRecordLike = SessionState['telemetry']['costs'][number]
export type ToolActivityRecordLike = SessionState['telemetry']['tools'][number]
export type ActiveTimeRecordLike = SessionState['telemetry']['activeTime'][number]

/** The newest `fork.checkpoint` records for `lane`, in observation order — restated from `lab-transcript.ts`'s own helper (the namespace law keeps `api/` from sharing private helpers across files, so each route restates its own read of the fold). */
function checkpointsFor(state: SessionState, lane: string): CheckpointRecord[] {
  const index = state.checkpoints.byLane
  if (!Object.hasOwn(index, lane)) return []
  return (index[lane] ?? [])
    .map((at) => state.checkpoints.records[at])
    .filter((record): record is CheckpointRecord => record !== undefined)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Streams `filePath` from byte 0 to `min(size, limit)`, decoding
 * multibyte-safe, and remembers the `ts` of the LAST line `parseTranscriptEntry`
 * can read a timestamp off of — never the whole file, never a wall-clock
 * read. Mirrors `lab-transcript.ts`'s `scanLines` shape, narrowed to the one
 * thing this route needs from the prefix.
 */
async function lastTimestampInPrefix(
  filePath: string,
  limit: number,
  chunkBytes: number,
): Promise<{ size: number; asOfTs: number | null }> {
  const size = (await stat(filePath)).size
  const end = Math.min(size, limit)
  const decoder = new StringDecoder('utf8')
  let carry = ''
  let position = 0
  let asOfTs: number | null = null

  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(Math.max(1, Math.min(chunkBytes, end)))
    while (position < end) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - position), position)
      if (bytesRead === 0) break
      const parts = (carry + decoder.write(buffer.subarray(0, bytesRead))).split('\n')
      carry = parts.pop() ?? ''
      for (const line of parts) {
        const entry = parseTranscriptEntry(line)
        if (entry?.ts === undefined) continue
        const parsed = Date.parse(entry.ts)
        if (!Number.isNaN(parsed)) asOfTs = parsed
      }
      position += bytesRead
    }
  } finally {
    await handle.close()
  }

  return { size, asOfTs }
}

/**
 * The lane's checkpointed session file, sliced at `atByte`: every `origin:
 * 'otel'` telemetry record for the lane at or before the wall time that byte
 * corresponds to. `atByte` past the file's real length is refused by name,
 * never clamped — the caller asked for a moment the session never reached.
 */
export async function readLabTelemetry(request: ReadLabTelemetryRequest): Promise<LabTelemetryResult> {
  const { events, lane, atByte } = request
  const chunkBytes = request.chunkBytes ?? TRANSCRIPT_CHUNK_BYTES
  const state = reduceAll(events)

  const checkpoints = checkpointsFor(state, lane)
  if (checkpoints.length === 0) {
    return {
      available: false,
      lane,
      reason:
        `NO SUCH LANE "${lane}" in the lab's record — no checkpoint was captured from it, so there is no session ` +
        `file to slice its telemetry against — run: \`rhizomorph lab checkpoint ${lane}\``,
    }
  }
  // Every checkpoint of one lane names the same evolving session file in
  // practice (the lane's active `.jsonl`); the newest capture's is read.
  const sessionFile = checkpoints[checkpoints.length - 1]!.sessionFile

  let scan: { size: number; asOfTs: number | null }
  try {
    scan = await lastTimestampInPrefix(sessionFile, atByte, chunkBytes)
  } catch (err) {
    return {
      available: false,
      lane,
      reason:
        `NO SESSION FILE for "${lane}" — its checkpoint names ${sessionFile} and it cannot be read ` +
        `(${describe(err)}) — run: \`rhizomorph doctor\``,
    }
  }

  if (atByte > scan.size) {
    return {
      available: false,
      lane,
      reason:
        `BYTE BEYOND SESSION LENGTH for "${lane}" — ${sessionFile} is ${scan.size} bytes but atByte=${atByte} ` +
        `asks for a moment past the end of the session the fold has recorded`,
    }
  }

  const asOfTs = scan.asOfTs
  const inSlice = <T extends { lane: string; origin: string; ts: number }>(record: T): boolean =>
    record.lane === lane && record.origin === 'otel' && asOfTs !== null && record.ts <= asOfTs

  return {
    available: true,
    lane,
    atByte,
    asOf: asOfTs,
    usage: state.telemetry.usage.filter(inSlice),
    costs: state.telemetry.costs.filter(inSlice),
    tools: state.telemetry.tools.filter(inSlice),
    activeTime: state.telemetry.activeTime.filter(inSlice),
  }
}

// ── footprint ────────────────────────────────────────────────────────────────

export interface LabFootprintReading {
  available: true
  lane: string
  /** Distinct paths the lane's branch has touched, intersected with the fold's collision map (ruling 6) — sorted for a stable answer. */
  files: string[]
  /** `files`' own collision detail, keyed by path — branch count and sources, so the surface can say WHY a path is here, not just that it is. */
  collisions: Record<string, CollisionEntry>
}

export interface LabFootprintAbsent {
  available: false
  lane: string
  reason: string
}

export type LabFootprintResult = LabFootprintReading | LabFootprintAbsent

export interface ReadLabFootprintRequest {
  events: readonly RhizomorphEvent[]
  lane: string
}

/** Whether the git-facing fold has ever recorded `lane` as a branch — a worktree checked out on it, or a branch record of its own. Independent of whether it has touched any file yet, which is what tells "never seen" apart from "seen and quiet". */
function isKnownBranch(state: SessionState, lane: string): boolean {
  if (Object.hasOwn(state.branches, lane)) return true
  return Object.values(state.worktrees).some((worktree) => worktree.branch === lane)
}

/**
 * `selectFilesTouchedByBranch(state, lane) ∩ selectCollisionMap(state)`
 * (ruling 6), read through core's selectors alone — never `buildFleet`, never
 * a fleet panel or route. A lane the fold has never seen as a branch is
 * refused by name; a known branch that has touched nothing yet answers an
 * honest empty `files`, which is not the same fact.
 */
export function readLabFootprint(request: ReadLabFootprintRequest): LabFootprintResult {
  const { events, lane } = request
  const state = reduceAll(events)

  if (!isKnownBranch(state, lane)) {
    return {
      available: false,
      lane,
      reason:
        `NO SUCH LANE "${lane}" in the fold's branch record — no worktree or branch named it, so there is nothing ` +
        `to intersect with the collision map — run: \`rhizomorph doctor\``,
    }
  }

  const touched = selectFilesTouchedByBranch(state, lane)
  const collisionMap = selectCollisionMap(state)
  const files: string[] = []
  const collisions: Record<string, CollisionEntry> = {}
  for (const path of touched) {
    const entry = collisionMap[path]
    if (entry === undefined) continue
    files.push(path)
    collisions[path] = entry
  }
  files.sort()

  return { available: true, lane, files, collisions }
}

// ── the routes ───────────────────────────────────────────────────────────────

/** Every event this repo has recorded — restated from `lab-transcript.ts`'s own copy of `api/lab.ts`'s private `readAllEvents`, for the same reason: it is private there. */
async function readAllEvents(ctx: ServerContext): Promise<RhizomorphEvent[]> {
  const summaries = await listSessions(ctx.sessionDir)
  const events: RhizomorphEvent[] = []
  let sawLive = false
  for (const summary of summaries) {
    if (summary.id === ctx.recorder.sessionId) {
      sawLive = true
      events.push(...ctx.recorder.eventsSoFar())
    } else {
      events.push(...(await readSessionEvents(sessionFilePath(ctx.sessionDir, summary.id))))
    }
  }
  if (!sawLive) events.push(...ctx.recorder.eventsSoFar())
  return events
}

/** A query value that was named, trimmed — or undefined when it was not named or was blank. */
function named(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * GET only. Both are gated reads (prd-29 ruling 1): each answers only the
 * capability token's holder, exactly as `/api/lab/transcript` does — but
 * unlike that route, neither ever 404s: a lane the fold has never seen, or a
 * byte past the session's length, is a 200 carrying `available: false` and
 * why, per this issue's own definition of done. `unknownLane`-style status
 * branching is deliberately not here; both routes answer flat.
 */
export function registerLabSeriesRoute(
  app: FastifyInstance,
  ctx: ServerContext,
  options: LabTelemetryOptions = {},
): void {
  app.get<{ Querystring: { lane?: string; atByte?: string } }>(
    '/api/lab/telemetry',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (request, reply) => {
      const lane = named(request.query.lane)
      if (lane === undefined) {
        return reply.code(400).send({ error: '"lane" (non-empty string) query param is required' })
      }
      const atByteRaw = named(request.query.atByte)
      const atByte = atByteRaw === undefined ? Number.NaN : Number(atByteRaw)
      if (!Number.isInteger(atByte) || atByte < 0) {
        return reply.code(400).send({ error: '"atByte" (a non-negative integer) query param is required' })
      }

      const events = await readAllEvents(ctx)
      return readLabTelemetry({ events, lane, atByte, chunkBytes: options.chunkBytes })
    },
  )

  app.get<{ Querystring: { lane?: string } }>(
    '/api/lab/footprint',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (request, reply) => {
      const lane = named(request.query.lane)
      if (lane === undefined) {
        return reply.code(400).send({ error: '"lane" (non-empty string) query param is required' })
      }

      const events = await readAllEvents(ctx)
      return readLabFootprint({ events, lane })
    },
  )
}
