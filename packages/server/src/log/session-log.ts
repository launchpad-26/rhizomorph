import { appendFile, mkdir, readdir, readFile, stat, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { parseEvent } from '@rhizomorph/core'
import { sessionFileName, sessionIdFromFileName } from './paths.js'
import { isLockLive, readSessionLock } from './session-lock.js'

const NEWLINE = 0x0a

export interface SessionLogWriterOptions {
  /**
   * True when this writer continues a file an earlier process started — a
   * resumed run. Before the first append the file's trailing *partial* line is
   * dropped: that is what a process killed mid-append leaves behind, and
   * appending after it would glue the new event onto half of the old one,
   * costing two events instead of one.
   */
  resuming?: boolean
}

/**
 * Appends validated events to one session's JSONL file. One writer per
 * running session; the file is created (with its parent dir) lazily on the
 * first append so an empty session never litters an empty file.
 */
export class SessionLogWriter {
  readonly filePath: string
  private readonly resuming: boolean
  private ready: Promise<void> | null = null

  constructor(filePath: string, options: SessionLogWriterOptions = {}) {
    this.filePath = filePath
    this.resuming = options.resuming ?? false
  }

  async append(event: RhizomorphEvent): Promise<void> {
    if (!this.ready) {
      this.ready = this.prepare()
    }
    await this.ready
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8')
  }

  /** Runs once, before the first append, and every append awaits it. */
  private async prepare(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    if (this.resuming) await dropTrailingPartialLine(this.filePath)
  }
}

/**
 * Truncates `filePath` back to its last newline if it doesn't end in one, and
 * reports whether it dropped anything. A JSONL file with a half-written final
 * line is a process killed mid-append; that line is unreadable either way
 * (`readSessionEvents` skips it), so dropping it loses nothing and keeps the
 * file appendable.
 */
export async function dropTrailingPartialLine(filePath: string): Promise<boolean> {
  let content: Buffer
  try {
    content = await readFile(filePath)
  } catch {
    return false // no file yet — nothing to repair
  }
  if (content.length === 0 || content[content.length - 1] === NEWLINE) return false
  await truncate(filePath, content.lastIndexOf(NEWLINE) + 1)
  return true
}

/**
 * Reads back a session's events. Malformed or invalid lines are skipped
 * rather than failing the whole read — a half-written last line (process
 * killed mid-append) shouldn't take the rest of the session with it.
 */
export async function readSessionEvents(filePath: string): Promise<RhizomorphEvent[]> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return []
  }

  const events: RhizomorphEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = parseEvent(JSON.parse(trimmed))
      if (parsed.ok) events.push(parsed.event)
    } catch {
      // skip malformed line
    }
  }
  return events
}

export interface SessionSummary {
  id: string
  fileName: string
  /** Epoch millis the session started — parsed from the filename. */
  startedAt: number
  sizeBytes: number
}

/** Lists sessions recorded for a repo, oldest first. Empty when the dir doesn't exist yet. */
export async function listSessions(dir: string): Promise<SessionSummary[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const sessions: SessionSummary[] = []
  for (const fileName of entries) {
    const id = sessionIdFromFileName(fileName)
    if (!id) continue
    const filePath = path.join(dir, fileName)
    const info = await stat(filePath)
    sessions.push({ id, fileName, startedAt: Number(id), sizeBytes: info.size })
  }

  sessions.sort((a, b) => a.startedAt - b.startedAt)
  return sessions
}

export function sessionFilePath(dir: string, sessionId: string): string {
  return path.join(dir, sessionFileName(Number(sessionId)))
}

/**
 * How stale the most recent session may be and still be *continued* by the next
 * boot instead of superseded by a new one. The prd's ruling is "resume the run",
 * but two boots a day apart are two runs: merging them would replay this
 * morning's spend into tonight's dashboard. Four hours keeps a working session
 * with a lunch break in it one run. It is a conductor default, not a law — this
 * constant is only the *default* boundary now: `--resume-window <ms>`
 * overrides it per boot (`cli/args.ts`), `decideSessionBoot` below states
 * *why* a boundary was crossed as data instead of a bare yes/no, and the
 * boot line, `/api/meta` and `rhizomorph doctor` all render that same
 * decision so the heuristic is never silent about what it did (operator
 * ruling 2026-08-05).
 */
export const RESUME_WINDOW_MS = 4 * 60 * 60 * 1000

export interface ResumableSession {
  sessionId: string
  filePath: string
  /** Everything already recorded, in file order — seeds the recorder's replay buffer. */
  events: RhizomorphEvent[]
}

/**
 * The most recent session recorded for a repo, if it is recent enough to
 * continue. Null means "start a new one": no session dir, no session file, no
 * readable event in the newest file, or its newest event is older than
 * `windowMs`.
 *
 * Recency is the newest event *timestamp*, not the last line's, because
 * collectors now stamp events with the source's own time (#56) — the final line
 * of a tail can be older than the line above it. A max never overstates how
 * fresh a file is (every source timestamp is in the past), so the worst this can
 * do is open a new session where it could have resumed — which costs a file, not
 * a duplicate: the new session starts with no snapshots and the sessionlog
 * collector starts at EOF (#57).
 */
export async function findResumableSession(
  dir: string,
  nowMs: number,
  windowMs: number = RESUME_WINDOW_MS,
): Promise<ResumableSession | null> {
  const sessions = await listSessions(dir)
  const latest = sessions[sessions.length - 1]
  if (!latest) return null

  const filePath = path.join(dir, latest.fileName)
  const events = await readSessionEvents(filePath)
  if (events.length === 0) return null

  const newestTs = events.reduce((newest, event) => Math.max(newest, event.ts), 0)
  if (nowMs - newestTs > windowMs) return null

  return { sessionId: latest.id, filePath, events }
}

/**
 * Why a boot did or didn't continue the previous session — operator ruling
 * 2026-08-05: the boundary must be self-explaining, not just a yes/no.
 * `writer-alive` (the agnosticism spike, headline verdict 4 / §3 adjacent
 * case) is the boundary's fifth answer: a candidate session was inside the
 * resume window, but another process is still writing it, so this boot
 * starts fresh instead of racing it onto the same file under the same id.
 */
export type SessionBootReason = 'fresh-flag' | 'resumed' | 'stale' | 'first-run' | 'writer-alive'

export interface SessionBootDecision {
  reason: SessionBootReason
  /** The session this boot continues, or null when it starts a new one. */
  resumed: ResumableSession | null
  /** The window this decision was measured against. */
  windowMs: number
  /** ms between `nowMs` and the previous session's newest recorded event — null when there was no previous session, or its newest file had nothing readable in it. */
  previousAgeMs: number | null
  /** Events already in the session file the moment this boot decided — 0 unless resuming. */
  eventCountAtBoot: number
  /** How many earlier boots already continued this exact session, before this one. 0 for a brand-new session. */
  resumedCount: number
  /** Set only when `reason` is `'writer-alive'`: the session a live writer still holds, and its pid — what the boot line and doctor both name. */
  liveWriter: { sessionId: string; pid: number } | null
}

/**
 * `findResumableSession` collapses "should this boot continue the previous
 * session" to a boolean (non-null/null); this wraps it with the *reason*, as
 * data, so a caller (the boot line, `/api/meta`, `doctor`) can state why
 * without re-deriving it or falling back to parsing a log string. Read-only —
 * it never writes, so `doctor` can call it to preview a boundary it will
 * never itself cross. `findResumableSession` stays untouched, so
 * `lab/checkpoint.ts` and `lab/fork.ts`, which only need the resumable
 * session and not the reason, keep working unchanged.
 *
 * `windowMs <= 0` folds into the same path as `fresh: true` — the boundary's
 * own law is "`--resume-window 0` behaves exactly like `--fresh`", not merely
 * "usually agrees with it" for the edge case of a session whose newest event
 * lands on `nowMs` exactly.
 */
export async function decideSessionBoot(
  dir: string,
  nowMs: number,
  options: { fresh?: boolean; windowMs?: number } = {},
): Promise<SessionBootDecision> {
  const windowMs = options.windowMs ?? RESUME_WINDOW_MS
  const fresh = (options.fresh ?? false) || windowMs <= 0

  if (fresh) {
    return {
      reason: 'fresh-flag',
      resumed: null,
      windowMs,
      previousAgeMs: null,
      eventCountAtBoot: 0,
      resumedCount: 0,
      liveWriter: null,
    }
  }

  const sessions = await listSessions(dir)
  const latest = sessions[sessions.length - 1]
  if (!latest) {
    return {
      reason: 'first-run',
      resumed: null,
      windowMs,
      previousAgeMs: null,
      eventCountAtBoot: 0,
      resumedCount: 0,
      liveWriter: null,
    }
  }

  const filePath = path.join(dir, latest.fileName)
  const events = await readSessionEvents(filePath)
  if (events.length === 0) {
    return {
      reason: 'stale',
      resumed: null,
      windowMs,
      previousAgeMs: null,
      eventCountAtBoot: 0,
      resumedCount: 0,
      liveWriter: null,
    }
  }

  const newestTs = events.reduce((newest, event) => Math.max(newest, event.ts), 0)
  const previousAgeMs = nowMs - newestTs
  if (previousAgeMs > windowMs) {
    return {
      reason: 'stale',
      resumed: null,
      windowMs,
      previousAgeMs,
      eventCountAtBoot: 0,
      resumedCount: 0,
      liveWriter: null,
    }
  }

  // The agnosticism spike's adjacent case: a candidate inside the window is
  // not automatically ours to continue. A live lock beside it means another
  // process is already writing it — resuming here would put two writers on
  // one file under one session id (the exact hazard the OTLP receiver's
  // foreign-instance refusal cannot see). A stale lock (dead pid, or a
  // heartbeat old enough that a pid match can't be trusted, `isLockLive`)
  // is the crash case: it resumes exactly as if there had been no lock at all.
  const lock = await readSessionLock(dir, latest.id)
  if (lock && isLockLive(lock, nowMs)) {
    return {
      reason: 'writer-alive',
      resumed: null,
      windowMs,
      previousAgeMs,
      eventCountAtBoot: 0,
      resumedCount: 0,
      liveWriter: { sessionId: latest.id, pid: lock.pid },
    }
  }

  const resumed: ResumableSession = { sessionId: latest.id, filePath, events }
  const resumedCount = await readResumedCount(dir, resumed.sessionId)
  return {
    reason: 'resumed',
    resumed,
    windowMs,
    previousAgeMs,
    eventCountAtBoot: events.length,
    resumedCount,
    liveWriter: null,
  }
}

/**
 * Sidecar next to the session log recording how many boots have continued
 * it — small and cheap because there is exactly one fact to track. Not
 * derivable from the log itself: exactly one `session.started` is ever
 * recorded per session (the "no duplicate start" law `cli/index.test.ts`
 * pins — a resumed boot must never re-record it), so a second in-file
 * marker isn't available without weakening that law. Same naming convention
 * as `sessionLabelFileName` (`log/paths.ts`): a sidecar beside the log,
 * never a mutation of the append-only log itself.
 */
function resumeCounterFileName(sessionId: string): string {
  return `session-${sessionId}.resumes.json`
}

/**
 * How many times `sessionId`'s session has been resumed so far. Never
 * throws: a missing or corrupt counter just means "never recorded", the
 * same convention every reader in this module already follows.
 */
export async function readResumedCount(dir: string, sessionId: string): Promise<number> {
  try {
    const raw = await readFile(path.join(dir, resumeCounterFileName(sessionId)), 'utf8')
    const parsed = JSON.parse(raw) as { resumedCount?: unknown }
    const count = parsed.resumedCount
    return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0
  } catch {
    return 0
  }
}

/**
 * Records one more boot resuming `sessionId` and returns the new total.
 * Called exactly once per boot that resumes — never by a read-only caller
 * like `doctor` (see its own module doc: "never changes anything").
 */
export async function recordResume(dir: string, sessionId: string): Promise<number> {
  const next = (await readResumedCount(dir, sessionId)) + 1
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, resumeCounterFileName(sessionId)), JSON.stringify({ resumedCount: next }), 'utf8')
  return next
}

/**
 * Renders a duration the way the boot line and `doctor` state one: "2h04m",
 * "45m30s", "12s", but a round number of hours or minutes drops its zeroed
 * trailing unit ("4h", not "4h00m") — the boundary's own default window
 * reads as "4h", not a suspiciously precise "4h00m". Shared here rather than
 * duplicated per caller because both `cli/index.ts` and `doctor.ts` need the
 * exact same rendering for the exact same figures.
 */
export function formatBootDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return minutes > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${hours}h`
  if (minutes > 0) return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`
  return `${seconds}s`
}
