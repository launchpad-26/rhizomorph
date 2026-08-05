import { appendFile, mkdir, open, readFile, truncate } from 'node:fs/promises'
import path from 'node:path'
import type { RhizomorphEvent } from '@rhizomorph/core'

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
 *
 * Appends are **serialised**: each one waits for the previous, so the log's
 * line order is the order `append` was called in even when two callers race
 * (a collector's poll and the recorder's own rotation, the only two that
 * ever can). Without that, prd17 ruling 1's "a final `session.closed`" would
 * be a hope about scheduling rather than a property of the file.
 */
export class SessionLogWriter {
  readonly filePath: string
  private readonly resuming: boolean
  private ready: Promise<void> | null = null
  /** The last append's promise — the chain every later append queues behind. */
  private tail: Promise<void> = Promise.resolve()

  constructor(filePath: string, options: SessionLogWriterOptions = {}) {
    this.filePath = filePath
    this.resuming = options.resuming ?? false
  }

  append(event: RhizomorphEvent): Promise<void> {
    if (!this.ready) {
      this.ready = this.prepare()
    }
    const written = this.tail.then(async () => {
      await this.ready
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8')
    })
    // One failed append must not poison every later one: the chain continues
    // from a settled promise, while `written` still rejects for its own caller.
    this.tail = written.catch(() => {})
    return written
  }

  /**
   * flush + fsync (prd17 ruling 3.5): awaits every append issued so far, then
   * asks the OS to put this file on the disk. Rotation's durability promise —
   * a closed log survives the machine losing power a moment later — is exactly
   * this call, so it is deliberately not fire-and-forget.
   *
   * A writer nobody has appended to has no file yet; that is not an error.
   */
  async sync(): Promise<void> {
    await this.tail
    let handle
    try {
      handle = await open(this.filePath, 'r+')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
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
