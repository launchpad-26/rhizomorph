import { appendFile, mkdir, readdir, readFile, stat, truncate } from 'node:fs/promises'
import path from 'node:path'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { parseEvent } from '@rhizomorph/core'
import { sessionFileName, sessionIdFromFileName } from './paths.js'

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
 * one constant is the whole boundary.
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
