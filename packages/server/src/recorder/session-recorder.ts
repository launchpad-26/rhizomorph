import { EventEmitter } from 'node:events'
import type { EventOf, RhizomorphEvent } from '@rhizomorph/core'
import { SessionLogWriter } from './session-log-writer.js'

export interface SessionRecorderOptions {
  /**
   * Events already in the session file, written by the process that started
   * this session — i.e. this run is *resuming* it (see `findResumableSession`).
   * They rebuild the in-memory buffer so a subscriber replays the whole session
   * rather than only the part this process appended, and they tell the writer it
   * is continuing an existing file rather than starting one.
   *
   * Present-but-empty still means resuming; absent means a new session.
   */
  resumeFrom?: readonly RhizomorphEvent[]
}

/**
 * Bridges collector output to both the persisted JSONL log and live SSE
 * subscribers, and holds the session-so-far buffer new subscribers replay
 * before switching to the live tail. One recorder per running *process* —
 * which, on a resumed run, may serve a session an earlier process began, and
 * which, since prd16 ruling 2, may serve one session after another as the
 * operator rotates.
 *
 * Rotation swaps the session *inside* this object rather than replacing the
 * object: every SSE subscriber and every `ServerContext.recorder` reference
 * survives the boundary, so a connected dashboard sees the old session's
 * `session.closed` and the new one's `session.started` on the stream it is
 * already holding. `sessionId` and `filePath` are therefore getters — always
 * the session being written *now*.
 */
export class SessionRecorder {
  private currentSessionId: string
  private currentFilePath: string
  private buffer: RhizomorphEvent[] = []
  private readonly emitter = new EventEmitter()
  private writer: SessionLogWriter
  /**
   * Non-null between `closeWith` and `openSession`: the sealed window. Every
   * `record` waits on it, so an event a collector produces mid-rotation lands
   * in the session that is open when the wait ends — never after a closed
   * log's final line.
   */
  private sealed: Promise<void> | null = null
  private releaseSeal: (() => void) | null = null

  constructor(sessionId: string, filePath: string, options: SessionRecorderOptions = {}) {
    this.currentSessionId = sessionId
    this.currentFilePath = filePath
    const resuming = options.resumeFrom !== undefined
    if (options.resumeFrom) this.buffer.push(...options.resumeFrom)
    this.writer = new SessionLogWriter(filePath, { resuming })
    // Many concurrent SSE clients each subscribe once; the default cap of 10 is easy to hit honestly.
    this.emitter.setMaxListeners(0)
  }

  /** The session being recorded right now — a fresh id after each rotation. */
  get sessionId(): string {
    return this.currentSessionId
  }

  /** The log being appended to right now — a fresh file after each rotation. */
  get filePath(): string {
    return this.currentFilePath
  }

  /**
   * True inside a rotation's sealed window: the old session's log has ended
   * and the new one is not open yet. The lock heartbeat reads this and skips
   * that instant — refreshing a lock then would put a live writer's claim back
   * over a log that has already been closed.
   */
  get isSealed(): boolean {
    return this.sealed !== null
  }

  async record(event: RhizomorphEvent): Promise<void> {
    while (this.sealed !== null) await this.sealed
    this.buffer.push(event)
    this.emitter.emit('event', event)
    await this.writer.append(event)
  }

  /**
   * Appends `event` as this session's LAST line, then seals the session:
   * every later `record` waits for `openSession`. The seal is taken *before*
   * the append is awaited, which is what makes prd17 ruling 1's "a final
   * `session.closed` event appended before the file closes" structural — a
   * collector poll landing in the same tick cannot slip in behind it.
   *
   * Returns once the closed log is flushed and fsynced (prd17 ruling 3.5).
   */
  async closeWith(event: EventOf<'session.closed'>): Promise<void> {
    while (this.sealed !== null) await this.sealed
    this.sealed = new Promise<void>((resolve) => {
      this.releaseSeal = resolve
    })
    this.buffer.push(event)
    this.emitter.emit('event', event)
    await this.writer.append(event)
    await this.writer.sync()
  }

  /**
   * Points this recorder at a fresh session: new id, new file, empty buffer
   * (a new subscriber replays the new session, not the one that just closed).
   * Releases the seal `closeWith` took, so anything that queued behind it now
   * lands here.
   */
  openSession(sessionId: string, filePath: string): void {
    this.currentSessionId = sessionId
    this.currentFilePath = filePath
    this.writer = new SessionLogWriter(filePath)
    this.buffer = []
    const release = this.releaseSeal
    this.sealed = null
    this.releaseSeal = null
    release?.()
  }

  /** flush + fsync of the session being written now — see `SessionLogWriter.sync`. */
  async sync(): Promise<void> {
    await this.writer.sync()
  }

  /** Every event recorded so far *this session*, in order. */
  eventsSoFar(): RhizomorphEvent[] {
    return [...this.buffer]
  }

  /** Subscribes to events recorded from this point on. Returns an unsubscribe function. */
  subscribe(listener: (event: RhizomorphEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}
