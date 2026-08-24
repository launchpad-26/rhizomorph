import { EventEmitter } from 'node:events'
import { initialSessionState, reduce, reduceAll } from '@rhizomorph/core'
import type { EventOf, RhizomorphEvent, SessionState } from '@rhizomorph/core'
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
  /**
   * The fold of {@link buffer}, maintained incrementally rather than
   * rebuilt per read (prd40 ruling 2). Kept exactly in step with `buffer`:
   * every push into it is followed, in the same synchronous step, by an
   * `advanceFold` call — see `record`, `closeWith` and `openSession`.
   */
  private foldState: SessionState
  /**
   * True when {@link advanceFold} could not keep `foldState` in step with an
   * event that DID land in `buffer` — see its own comment. `foldSoFar` checks
   * this on every read and self-heals by rebuilding from `buffer` once,
   * rather than ever answering with a fold it knows has fallen behind.
   */
  private foldDesynced = false
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
    this.foldState = reduceAll(this.buffer)
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

  /**
   * Folds one event into the running {@link foldState}. Always called
   * immediately after the matching `this.buffer.push`, in the same
   * synchronous step — so a subscriber reading `foldSoFar()` from inside
   * `emitter.emit` sees exactly the events `eventsSoFar()` already shows it,
   * and the fold can never observably lag the buffer.
   *
   * `reduce` is total over the validated `RhizomorphEvent` union (see its
   * own exhaustiveness proof), so the catch below is defensive rather than
   * expected. It exists anyway because a bug in the accelerator must never
   * become a new way for `record`/`closeWith` to reject — those methods'
   * contracts are governed by the writer, not by this. `foldSoFar` notices
   * `foldDesynced` and repairs it from `buffer`, which is always ground
   * truth.
   */
  private advanceFold(event: RhizomorphEvent): void {
    try {
      this.foldState = reduce(this.foldState, event)
    } catch {
      this.foldDesynced = true
    }
  }

  async record(event: RhizomorphEvent): Promise<void> {
    while (this.sealed !== null) await this.sealed
    this.buffer.push(event)
    this.advanceFold(event)
    // A throwing subscriber here just rejects this call's promise — unlike
    // closeWith, record() holds no seal that would otherwise stay stuck.
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
    this.advanceFold(event)
    try {
      this.emitter.emit('event', event)
      await this.writer.append(event)
      await this.writer.sync()
    } catch (error) {
      const release = this.releaseSeal
      this.sealed = null
      this.releaseSeal = null
      release?.()
      throw error
    }
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
    this.foldState = initialSessionState()
    this.foldDesynced = false
    const release = this.releaseSeal
    this.sealed = null
    this.releaseSeal = null
    release?.()
  }

  /** flush + fsync of the session being written now — see `SessionLogWriter.sync`. */
  async sync(): Promise<void> {
    await this.writer.sync()
  }

  /**
   * The fold of every event recorded so far *this session* — maintained
   * incrementally (prd40 ruling 2), never rebuilt per call. Deep-equal to
   * `reduceAll(eventsSoFar())` for the same stream (proven over the
   * golden-era corpus in `session-recorder.test.ts`), and the number of
   * `reduce` calls one read costs is zero regardless of session length (the
   * spy law, same file). `/api/meta` and every future reader should answer
   * from this rather than re-folding `eventsSoFar()` themselves — see
   * prd-40's open question on whether `eventsSoFar()` should eventually
   * narrow to the exporter only; that is not decided here.
   *
   * Returned by reference, not copied — `SessionState` is treated as
   * read-only by the same convention every other reader of `reduceAll(...)`
   * already relies on (e.g. `api/meta.ts`, `cli/run.ts`); copying it here
   * would both invent a new discipline and defeat the O(1) cost this method
   * exists to provide.
   */
  foldSoFar(): SessionState {
    if (this.foldDesynced) {
      this.foldState = reduceAll(this.buffer)
      this.foldDesynced = false
    }
    return this.foldState
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
