import { EventEmitter } from 'node:events'
import type { ObservatoryEvent } from '@observatory/core'
import { SessionLogWriter } from '../log/session-log.js'

/**
 * Bridges collector output to both the persisted JSONL log and live SSE
 * subscribers, and holds the session-so-far buffer new subscribers replay
 * before switching to the live tail. One recorder per running session.
 */
export class SessionRecorder {
  readonly sessionId: string
  readonly filePath: string
  private readonly buffer: ObservatoryEvent[] = []
  private readonly emitter = new EventEmitter()
  private readonly writer: SessionLogWriter

  constructor(sessionId: string, filePath: string) {
    this.sessionId = sessionId
    this.filePath = filePath
    this.writer = new SessionLogWriter(filePath)
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
