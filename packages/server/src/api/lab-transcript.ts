import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { CheckpointRecord, ForkDispatchRecord, RhizomorphEvent, SessionState } from '@rhizomorph/core'
import { reduceAll } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { defaultClaudeProjectsRoot } from '../log/paths.js'
import { listSessions, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import type { ServerContext } from '../server/context.js'
import { requireCapabilityToken } from './security.js'
import { parseTranscriptEntry, TRANSCRIPT_CHUNK_BYTES, type TranscriptEntry } from './transcript.js'

/**
 * THE LAB READS ITS OWN FILES (prd-55 ruling 6 / S3′, #384) —
 * `GET /api/lab/transcript?lane=<handle>[&arm=<handle>][&checkpoint=<id>]`.
 *
 * The fleet's transcript tail (`./transcript.ts`) answers for the lanes the
 * sessionlog collector *attributed*: it reads `lane → sessionId → worktree`
 * back off telemetry the collector emitted. A forked arm that never launched
 * emitted no telemetry, and a parent's session at the moment it was forked is
 * a byte offset, not a lane — so Trace read *NO SESSION LOG* for one side and
 * *404* for the other while the lab's own record held everything it needed
 * (prd-55's Evidence). This route reads that record, and nothing else:
 *
 * - **The parent** is the checkpoint's `sessionFile`, served from byte 0 up
 *   to `sessionCutByte` and refused when those bytes no longer digest to
 *   `sessionDigest` — the same proof `lab/restore.ts` demands before it
 *   restores, restated here rather than imported (the namespace law forbids
 *   `api/` from reaching `server/src/lab/`). A conversation the record does
 *   not vouch for is not shown.
 * - **An arm** is the newest session file in the project directory of its
 *   own worktree — `<claude projects root>/<slug(worktreePath)>/` — where
 *   `synthesizeSession` wrote its restored session and where Claude Code
 *   appends once the arm runs. The worktree comes from the `fork.dispatched`
 *   record; the projects root comes from the record too, as the grandparent
 *   of the checkpoint's own `sessionFile`, with the machine's default as the
 *   fallback. Never from fleet attribution: an arm that has not launched has
 *   none, and this route must read for it anyway.
 * - **Not launched** is a fact, not a 404. The restore copies exactly the
 *   complete lines inside the cut, so an arm whose session holds that many
 *   lines and no more has not begun; the answer says so in the words the
 *   surface shows ({@link NOT_LAUNCHED_NOTE}).
 *
 * **The whole span, in one answer.** The fleet route pages in 64 KiB chunks
 * because a live tail is many small asks; Trace's diff is one ask for one
 * bounded thing — a parent to its cut, an arm to its end — and a diff over a
 * first page alone is what the wave-3 review found (`TraceDiff` read
 * `offset=0` once and followed nothing). So this route streams the file in
 * {@link TRANSCRIPT_CHUNK_BYTES} pieces (never a whole-file slurp into one
 * buffer) and hands back every entry. Memory is the parsed entries, and tool
 * results are already cut to `TOOL_RESULT_MAX_CHARS` by the shared parser.
 *
 * Read-only, absolutely: one verb, files opened `'r'`, nothing written, no
 * process started. The fold it reads is the same one `api/lab.ts` folds.
 */

/** What the surface says of an arm whose restored session has not grown past the cut (prd-55 ruling 6). */
export const NOT_LAUNCHED_NOTE = "not launched — its restored session ends where the parent's was cut"

export interface LabTranscriptOptions {
  /**
   * Tried first when set. Tests point it at a fixture directory; production
   * leaves it unset and the root is read off the record (see {@link armProjectDirs}).
   */
  claudeProjectsRoot?: string
  /** The streaming read's piece size. Tests use a tiny one to prove a line or a multibyte character split across pieces is still whole. */
  chunkBytes?: number
}

export interface LabParentTranscript {
  available: true
  side: 'parent'
  lane: string
  checkpointId: string
  /** The session file's own name, sans `.jsonl` — never its path. */
  sessionId: string
  /** `sessionCutByte` — every byte before it was served, none after. */
  cutByte: number
  /** Complete lines inside the cut — exactly what a restore copies (`restore.ts`'s `linesCopied`). */
  lines: number
  /** True when the cut fell mid-line; the fragment is not a turn and is not served, as the restore drops it too. */
  droppedPartialLine: boolean
  entries: TranscriptEntry[]
}

export interface LabArmTranscript {
  available: true
  side: 'arm'
  lane: string
  parentLane: string
  checkpointId: string
  sessionId: string
  /** The arm's session file, whole. */
  bytes: number
  /** Complete lines in the arm's session file. */
  lines: number
  /** Complete lines the restore copied from the parent's cut prefix, or null when the parent's file can no longer vouch for that number. */
  restoredLines: number | null
  /** `lines > restoredLines`. Null when it cannot be told, and `note` says why. */
  launched: boolean | null
  /** {@link NOT_LAUNCHED_NOTE} when `launched` is false; why it cannot be told when null; null when the arm has run. */
  note: string | null
  entries: TranscriptEntry[]
}

export interface LabTranscriptAbsent {
  available: false
  /** Which side was being read when it could not be — null when the lane resolved to neither. */
  side: 'parent' | 'arm' | null
  lane: string
  /** WHAT is missing or refused → WHY → what to do (law 12). Never a bare "not found". */
  reason: string
  /**
   * True only when neither a checkpoint nor a dispatch record names `lane` —
   * the `/api/transcript/:lane` convention: a known identity with nothing
   * readable is an honest 200, an unknown identifier a 404. Never sent on
   * the wire; the route reads it to pick the status code.
   */
  unknownLane: boolean
}

export type LabTranscriptResult = LabParentTranscript | LabArmTranscript | LabTranscriptAbsent

/** A request the record cannot answer as asked — the route maps it to 400. */
export class LabTranscriptRequestError extends Error {}

export interface ReadLabTranscriptRequest {
  events: readonly RhizomorphEvent[]
  /** An arm's handle, or a parent lane. */
  lane: string
  /** For a parent: the arm whose dispatch record names the checkpoint to cut at. */
  arm?: string | undefined
  /** For a parent: the checkpoint to cut at, named directly. */
  checkpoint?: string | undefined
  claudeProjectsRoot?: string | undefined
  chunkBytes?: number | undefined
}

// ── the record ───────────────────────────────────────────────────────────────

/** The newest `fork.dispatched` for a handle, or undefined. `Object.hasOwn`, so a hostile handle cannot read the prototype. */
function dispatchFor(state: SessionState, laneHandle: string): ForkDispatchRecord | undefined {
  const index = state.forks.byLane
  if (!Object.hasOwn(index, laneHandle)) return undefined
  const positions = index[laneHandle] ?? []
  const at = positions[positions.length - 1]
  return at === undefined ? undefined : state.forks.dispatches[at]
}

function checkpointsFor(state: SessionState, lane: string): CheckpointRecord[] {
  const index = state.checkpoints.byLane
  if (!Object.hasOwn(index, lane)) return []
  return (index[lane] ?? [])
    .map((at) => state.checkpoints.records[at])
    .filter((record): record is CheckpointRecord => record !== undefined)
}

function checkpointById(state: SessionState, checkpointId: string): CheckpointRecord | undefined {
  return state.checkpoints.records.find((record) => record.checkpointId === checkpointId)
}

function absent(side: 'parent' | 'arm' | null, lane: string, reason: string, unknownLane = false): LabTranscriptAbsent {
  return { available: false, side, lane, reason, unknownLane }
}

// ── reading ──────────────────────────────────────────────────────────────────

interface Scan {
  /** The file's size when the read began. */
  size: number
  /** Bytes actually read — `min(size, limit)` unless the file shrank under the read. */
  bytesRead: number
  /** sha256 of exactly the bytes read. */
  digest: string
  /** Complete (newline-terminated) lines seen. */
  lines: number
  /** Bytes after the last newline, before the limit — a line the cut fell inside. */
  droppedPartialLine: boolean
}

/**
 * Streams `filePath` from byte 0 to `min(size, limit)` in `chunkBytes`
 * pieces, digesting every byte and handing each complete line to `onLine`.
 * Decoding goes through a `StringDecoder`, so a multibyte character split
 * across two pieces is still one character; splitting waits for the newline,
 * so a line split across two pieces is still one line. The fragment after the
 * last newline is not a line and is not handed over — the same edge
 * `restore.ts` draws when it drops a partial line at the cut.
 */
async function scanLines(
  filePath: string,
  limit: number,
  chunkBytes: number,
  onLine: (line: string) => void,
): Promise<Scan> {
  const size = (await stat(filePath)).size
  const end = Math.min(size, limit)
  const hash = createHash('sha256')
  const decoder = new StringDecoder('utf8')
  let carry = ''
  let lines = 0
  let position = 0

  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(Math.max(1, Math.min(chunkBytes, end)))
    while (position < end) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - position), position)
      if (bytesRead === 0) break // the file shrank under the read; the caller sees bytesRead < limit
      const piece = buffer.subarray(0, bytesRead)
      hash.update(piece)
      const parts = (carry + decoder.write(piece)).split('\n')
      carry = parts.pop() ?? ''
      for (const line of parts) {
        onLine(line)
        lines += 1
      }
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  carry += decoder.end()

  return { size, bytesRead: position, digest: hash.digest('hex'), lines, droppedPartialLine: carry.length > 0 }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The parent's cut prefix, proven. Three refusals, each naming what is wrong
 * (law 12), mirroring `restore.ts`'s `verifySessionPrefix` — file gone, file
 * shorter than the cut, bytes changed under the digest. Only a prefix the
 * record vouches for is served.
 */
async function readParent(
  lane: string,
  checkpoint: CheckpointRecord,
  chunkBytes: number,
): Promise<LabParentTranscript | LabTranscriptAbsent> {
  const { checkpointId, sessionFile, sessionCutByte } = checkpoint
  const entries: TranscriptEntry[] = []
  let scan: Scan
  try {
    scan = await scanLines(sessionFile, sessionCutByte, chunkBytes, (line) => {
      const entry = parseTranscriptEntry(line)
      if (entry !== null) entries.push(entry)
    })
  } catch (err) {
    return absent(
      'parent',
      lane,
      `NO SESSION FILE for "${lane}" — checkpoint ${checkpointId} names ${sessionFile} and it cannot be read ` +
        `(${describe(err)}) — the file has moved, or this is not the machine the checkpoint was captured on — ` +
        'run: `rhizomorph doctor`',
    )
  }

  if (scan.size < sessionCutByte || scan.bytesRead < sessionCutByte) {
    return absent(
      'parent',
      lane,
      `SESSION CUT REFUSED for "${lane}" — ${sessionFile} is ${scan.size} bytes but checkpoint ${checkpointId} ` +
        `cuts at ${sessionCutByte}, so the session has been truncated or replaced since capture and nothing ` +
        'before the cut can be vouched for — run: `rhizomorph doctor`',
    )
  }
  if (scan.digest !== checkpoint.sessionDigest) {
    return absent(
      'parent',
      lane,
      `SESSION DIGEST REFUSED for "${lane}" — the first ${sessionCutByte} bytes of ${sessionFile} digest to ` +
        `${scan.digest}, not the ${checkpoint.sessionDigest} checkpoint ${checkpointId} recorded, so they are not ` +
        'the bytes the checkpoint was taken over, and the lab will not show a conversation its record does not ' +
        'vouch for — run: `rhizomorph doctor`',
    )
  }

  return {
    available: true,
    side: 'parent',
    lane,
    checkpointId,
    sessionId: path.basename(sessionFile, '.jsonl'),
    cutByte: sessionCutByte,
    lines: scan.lines,
    droppedPartialLine: scan.droppedPartialLine,
    entries,
  }
}

/**
 * Every directory an arm's restored session could live in, in preference
 * order, deduplicated: an explicit root (tests), then the root the RECORD
 * implies — the checkpoint's `sessionFile` is `<root>/<slug>/<id>.jsonl`, so
 * its grandparent is the Claude projects root the parent was captured under,
 * and `synthesizeSession` writes the arm under the same one — then the
 * machine's default. Each is `<root>/<slug(worktreePath)>`, and the slug is a
 * single path segment by construction (`worktreePathToProjectSlug` maps every
 * non-alphanumeric to `-`), so no worktree path the record could carry can
 * step outside its root.
 */
function armProjectDirs(worktreePath: string, checkpoint: CheckpointRecord, explicitRoot: string | undefined): string[] {
  const roots = [explicitRoot, path.dirname(path.dirname(checkpoint.sessionFile)), defaultClaudeProjectsRoot()]
    .filter((root): root is string => root !== undefined)
    .map((root) => path.resolve(root))
  const slug = worktreePathToProjectSlug(worktreePath)
  return [...new Set(roots)].map((root) => path.join(root, slug))
}

/**
 * The newest `*.jsonl` under the first of `dirs` that holds one — the same
 * "most recently modified is the active session" rule `lab/checkpoint.ts`'s
 * `findActiveSessionFile` applies when it cuts a parent (restated: the
 * namespace law keeps `lab/` out of `api/`). Null when none of them does.
 */
async function newestSessionFile(dirs: readonly string[]): Promise<string | null> {
  for (const dir of dirs) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    const candidates = await Promise.all(
      names
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (name) => {
          const filePath = path.join(dir, name)
          try {
            return { filePath, mtimeMs: (await stat(filePath)).mtimeMs }
          } catch {
            return null
          }
        }),
    )
    const newest = candidates
      .filter((candidate): candidate is { filePath: string; mtimeMs: number } => candidate !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (newest !== undefined) return newest.filePath
  }
  return null
}

/**
 * How many complete lines the restore copied — the parent's cut prefix,
 * counted, and only when the prefix still digests to what the checkpoint
 * recorded. A prefix the record cannot vouch for cannot vouch for the arm's
 * starting length either, so the answer is then a reason, not a number.
 */
async function restoredLineCount(checkpoint: CheckpointRecord, chunkBytes: number): Promise<{ lines: number } | { reason: string }> {
  let scan: Scan
  try {
    scan = await scanLines(checkpoint.sessionFile, checkpoint.sessionCutByte, chunkBytes, () => {})
  } catch (err) {
    return { reason: `the parent's session file ${checkpoint.sessionFile} cannot be read (${describe(err)})` }
  }
  if (scan.size < checkpoint.sessionCutByte || scan.bytesRead < checkpoint.sessionCutByte) {
    return { reason: `the parent's session file is ${scan.size} bytes, shorter than the ${checkpoint.sessionCutByte}-byte cut checkpoint ${checkpoint.checkpointId} recorded` }
  }
  if (scan.digest !== checkpoint.sessionDigest) {
    return { reason: `the parent's session no longer matches checkpoint ${checkpoint.checkpointId} before the cut, so what the restore copied cannot be counted` }
  }
  return { lines: scan.lines }
}

async function readArm(
  lane: string,
  dispatch: ForkDispatchRecord,
  checkpoint: CheckpointRecord,
  explicitRoot: string | undefined,
  chunkBytes: number,
): Promise<LabArmTranscript | LabTranscriptAbsent> {
  const dirs = armProjectDirs(dispatch.worktreePath, checkpoint, explicitRoot)
  const sessionFile = await newestSessionFile(dirs)
  if (sessionFile === null) {
    return absent(
      'arm',
      lane,
      `NO RESTORED SESSION for "${lane}" — no session file under ${dirs.join(' or ')} (the project directory of ` +
        `its worktree ${dispatch.worktreePath}) — the arm was dispatched from checkpoint ${checkpoint.checkpointId} ` +
        'but its restored session is not on this machine — run: `rhizomorph doctor`',
    )
  }

  const entries: TranscriptEntry[] = []
  let scan: Scan
  try {
    scan = await scanLines(sessionFile, Number.POSITIVE_INFINITY, chunkBytes, (line) => {
      const entry = parseTranscriptEntry(line)
      if (entry !== null) entries.push(entry)
    })
  } catch (err) {
    return absent(
      'arm',
      lane,
      `NO RESTORED SESSION for "${lane}" — ${sessionFile} was listed but cannot be read (${describe(err)}) — ` +
        'run: `rhizomorph doctor`',
    )
  }

  const restored = await restoredLineCount(checkpoint, chunkBytes)
  let restoredLines: number | null = null
  let launched: boolean | null = null
  let note: string | null = null
  if ('lines' in restored) {
    restoredLines = restored.lines
    if (scan.lines > restored.lines) {
      launched = true
    } else if (scan.lines === restored.lines) {
      launched = false
      note = NOT_LAUNCHED_NOTE
    } else {
      note =
        `whether "${lane}" launched cannot be told — its session holds ${scan.lines} line(s) where the restore ` +
        `copied ${restored.lines}, so the file has been truncated or replaced since it was restored`
    }
  } else {
    note = `whether "${lane}" launched cannot be told — ${restored.reason}`
  }

  return {
    available: true,
    side: 'arm',
    lane,
    parentLane: dispatch.parentLane,
    checkpointId: checkpoint.checkpointId,
    sessionId: path.basename(sessionFile, '.jsonl'),
    bytes: scan.bytesRead,
    lines: scan.lines,
    restoredLines,
    launched,
    note,
    entries,
  }
}

// ── the read, end to end ─────────────────────────────────────────────────────

/**
 * Which side `lane` is, and then one read. An arm's handle is what its
 * dispatch record says it is, so a handle with a record is read as an arm
 * whatever else the record holds for that name; anything else is read as a
 * parent, cut at the checkpoint `arm=` or `checkpoint=` names — or at the
 * lane's only checkpoint when it has exactly one. Two checkpoints and no
 * hint is a question the record cannot answer, and says so (400), rather
 * than a guess at which moment the caller meant.
 */
export async function readLabTranscript(request: ReadLabTranscriptRequest): Promise<LabTranscriptResult> {
  const { events, lane } = request
  const chunkBytes = request.chunkBytes ?? TRANSCRIPT_CHUNK_BYTES
  const state = reduceAll(events)

  const dispatch = dispatchFor(state, lane)
  if (dispatch !== undefined) {
    const checkpoint = checkpointById(state, dispatch.checkpointId)
    if (checkpoint === undefined) {
      return absent(
        'arm',
        lane,
        `NO CHECKPOINT for arm "${lane}" — its dispatch record names checkpoint ${dispatch.checkpointId} and the ` +
          'record holds no such checkpoint, so neither its restored session nor the cut it ends at can be located ' +
          '— run: `rhizomorph doctor`',
      )
    }
    return readArm(lane, dispatch, checkpoint, request.claudeProjectsRoot, chunkBytes)
  }

  const checkpoints = checkpointsFor(state, lane)
  if (checkpoints.length === 0) {
    return absent(
      null,
      lane,
      `NO SUCH LANE "${lane}" in the lab's record — no checkpoint was captured from it and no dispatch record ` +
        'names it as an arm, so there is no transcript for the lab to read — run: `rhizomorph lab checkpoint ' +
        `${lane}\``,
      true,
    )
  }

  let checkpoint: CheckpointRecord | undefined
  if (request.checkpoint !== undefined) {
    checkpoint = checkpoints.find((record) => record.checkpointId === request.checkpoint)
    if (checkpoint === undefined) {
      return absent(
        'parent',
        lane,
        `NO CHECKPOINT "${request.checkpoint}" for "${lane}" — the record holds ${checkpoints.length} for it ` +
          `(${checkpoints.map((record) => record.checkpointId).join(', ')}) — run: \`rhizomorph doctor\``,
      )
    }
  } else if (request.arm !== undefined) {
    const armDispatch = dispatchFor(state, request.arm)
    if (armDispatch === undefined) {
      return absent(
        'parent',
        lane,
        `NO DISPATCH RECORD for arm "${request.arm}" — nothing in the lab's record was forked under that handle, ` +
          `so it cannot say which checkpoint of "${lane}" to cut at — run: \`rhizomorph doctor\``,
      )
    }
    if (armDispatch.parentLane !== lane) {
      return absent(
        'parent',
        lane,
        `arm "${request.arm}" was forked from "${armDispatch.parentLane}", not from "${lane}" — its checkpoint ` +
          `cannot cut another lane's session — run: \`rhizomorph doctor\``,
      )
    }
    checkpoint = checkpoints.find((record) => record.checkpointId === armDispatch.checkpointId)
    if (checkpoint === undefined) {
      return absent(
        'parent',
        lane,
        `NO CHECKPOINT for arm "${request.arm}" — its dispatch record names checkpoint ${armDispatch.checkpointId} ` +
          `and "${lane}" has no such checkpoint in the record — run: \`rhizomorph doctor\``,
      )
    }
  } else if (checkpoints.length === 1) {
    checkpoint = checkpoints[0]
  } else {
    throw new LabTranscriptRequestError(
      `"${lane}" has ${checkpoints.length} checkpoints (${checkpoints.map((record) => record.checkpointId).join(', ')}) ` +
        '— name the cut with checkpoint=<id>, or arm=<handle> to read it as that arm\'s parent',
    )
  }
  if (checkpoint === undefined) {
    // Unreachable by the branches above; kept as a typed refusal rather than a non-null assertion.
    return absent('parent', lane, `NO CHECKPOINT resolved for "${lane}" — run: \`rhizomorph doctor\``)
  }

  return readParent(lane, checkpoint, chunkBytes)
}

// ── the route ────────────────────────────────────────────────────────────────

/**
 * Every event this repo has recorded, across every session file plus the live
 * recorder's own buffer — `api/lab.ts`'s `readAllEvents`, restated because it
 * is private there and this file's one job is to fold the same record it does.
 */
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
 * GET only — the read-only constitution stated in routing. A gated read
 * (prd-29 ruling 1): it answers only the capability token's holder, exactly
 * as `/api/transcript/:lane` does.
 */
export function registerLabTranscriptRoute(
  app: FastifyInstance,
  ctx: ServerContext,
  options: LabTranscriptOptions = {},
): void {
  app.get<{ Querystring: { lane?: string; arm?: string; checkpoint?: string } }>(
    '/api/lab/transcript',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (request, reply) => {
      const lane = named(request.query.lane)
      if (lane === undefined) {
        return reply.code(400).send({
          error:
            '"lane" (non-empty string) query param is required — an arm\'s handle, or a parent lane with ' +
            'arm=<handle> or checkpoint=<id> naming the cut to read it to',
        })
      }

      const events = await readAllEvents(ctx)
      let result: LabTranscriptResult
      try {
        result = await readLabTranscript({
          events,
          lane,
          arm: named(request.query.arm),
          checkpoint: named(request.query.checkpoint),
          claudeProjectsRoot: options.claudeProjectsRoot,
          chunkBytes: options.chunkBytes,
        })
      } catch (err) {
        if (err instanceof LabTranscriptRequestError) return reply.code(400).send({ error: err.message })
        throw err
      }

      if (!result.available) {
        // Known-but-unreadable — a refused digest, a session not on this
        // machine, an arm never restored — is an honest 200 with its reason;
        // only a lane the record never named is a 404. `unknownLane` never
        // leaves this process.
        const { available, side, lane: resolved, reason } = result
        return reply.code(result.unknownLane ? 404 : 200).send({ available, side, lane: resolved, reason })
      }
      return result
    },
  )
}
