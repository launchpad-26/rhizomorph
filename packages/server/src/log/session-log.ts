import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ObservatoryEvent } from '@observatory/core'
import { parseEvent } from '@observatory/core'
import { sessionFileName, sessionIdFromFileName } from './paths.js'

/**
 * Appends validated events to one session's JSONL file. One writer per
 * running session; the file is created (with its parent dir) lazily on the
 * first append so an empty session never litters an empty file.
 */
export class SessionLogWriter {
  readonly filePath: string
  private ready: Promise<void> | null = null

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async append(event: ObservatoryEvent): Promise<void> {
    if (!this.ready) {
      this.ready = mkdir(path.dirname(this.filePath), { recursive: true }).then(() => undefined)
    }
    await this.ready
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8')
  }
}

/**
 * Reads back a session's events. Malformed or invalid lines are skipped
 * rather than failing the whole read — a half-written last line (process
 * killed mid-append) shouldn't take the rest of the session with it.
 */
export async function readSessionEvents(filePath: string): Promise<ObservatoryEvent[]> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return []
  }

  const events: ObservatoryEvent[] = []
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
