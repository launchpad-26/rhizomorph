import { EventEmitter } from 'node:events'
import type { ObservatoryEvent } from '@observatory/core'
import { SessionLogWriter } from '../log/session-log.js'

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
  resumeFrom?: readonly ObservatoryEvent[]
}

/**
 * Bridges collector output to both the persisted JSONL log and live SSE
 * subscribers, and holds the session-so-far buffer new subscribers replay
 * before switching to the live tail. One recorder per running session — which,
 * on a resumed run, may be a session an earlier process began.
 */
export class SessionRecorder {
  readonly sessionId: string
  readonly filePath: string
  private readonly buffer: ObservatoryEvent[] = []
  private readonly emitter = new EventEmitter()
  private readonly writer: SessionLogWriter

  constructor(sessionId: string, filePath: string, options: SessionRecorderOptions = {}) {
    this.sessionId = sessionId
    this.filePath = filePath
    const resuming = options.resumeFrom !== undefined
    if (options.resumeFrom) this.buffer.push(...options.resumeFrom)
    this.writer = new SessionLogWriter(filePath, { resuming })
    // Many concurrent SSE clients each subscribe once; the default cap of 10 is easy to hit honestly.
    this.emitter.setMaxListeners(0)
  }

  async record(event: ObservatoryEvent): Promise<void> {
    this.buffer.push(event)
    this.emitter.emit('event', event)
    await this.writer.append(event)
  }

  /** Every event recorded so far this session, in order. */
  eventsSoFar(): ObservatoryEvent[] {
    return [...this.buffer]
  }

  /** Subscribes to events recorded from this point on. Returns an unsubscribe function. */
  subscribe(listener: (event: ObservatoryEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}
