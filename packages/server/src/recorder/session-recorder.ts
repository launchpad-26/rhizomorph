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
    // prd40 ruling 1 (ADR-0029): nothing publishes until the append resolves.
    // SessionLogWriter serialises appends through its `tail` chain, so awaiting
    // here keeps `buffer` in the log's own order even when two callers race.
    const writer = this.writer
    await writer.append(event)
    // The first suspension point this method has ever had. A rotation can close
    // this session and openSession() the next one while we are parked on it;
    // publishing then would push a closed session's event into the new
    // session's buffer, fold and subscribers. The event is durable in the file
    // it was appended to — it is the recorder's current session that moved on.
    if (this.writer !== writer) return
    this.buffer.push(event)
    this.advanceFold(event)
    // A throwing subscriber here just rejects this call's promise — unlike
    // closeWith, record() holds no seal that would otherwise stay stuck.
    this.emitter.emit('event', event)
  }

  /**
   * The degrade alarm's path, and the ONLY publish-without-append in this class.
   *
   * prd-40 success 1 requires an event to reach the log before it reaches a
   * subscriber, and names exactly one exception: the degrade `collector.error`
   * reporting an append failure "may be emitted without having been appended",
   * because on a full disk the alarm's own append fails too and requiring it to
   * land first silences the alarm in the one case it exists for. See
   * [ADR-0030](../../../../docs/adr/0030-the-alarm-may-outrun-the-record.md).
   *
   * The exemption is for EMISSION ONLY. Success 1 still forbids leaving "the
   * fold ahead of the file after a rejected append", and that clause is not
   * exempted — so on a failed append this pushes nothing into `buffer` and
   * advances no fold. `eventsSoFar()` and `foldSoFar()` stay honest with the
   * file; only subscribers hear the alarm.
   *
   * Narrowed to `EventOf<'collector.error'>` on purpose: the exemption is "for
   * this one event type on this one path ... asserted by name in the law rather
   * than inferred from a category". The type is what makes that structural — no
   * collector-derived event can reach this method at all.
   *
   * Never rejects. The reporting path is never the crash path (#239).
   */
  async recordAlarm(event: EventOf<'collector.error'>): Promise<{ appended: boolean }> {
    while (this.sealed !== null) await this.sealed
    const writer = this.writer
    let appended = true
    try {
      await writer.append(event)
    } catch {
      appended = false
    }
    if (appended) {
      // The same rotation check `record` makes at its own suspension point: a
      // rotation that landed while we were parked means this event is durable
      // in the log it was appended to, and must not contaminate the session
      // that has since opened — buffer, fold or subscribers.
      if (this.writer !== writer) return { appended: true }
      this.buffer.push(event)
      this.advanceFold(event)
    }
    // On a FAILED append we fall through to the emit having touched neither
    // `buffer` nor `foldState`, whatever the writer did in the meantime: a
    // rotation racing the alarm is not a reason to silence it, and since
    // nothing entered the buffer or the fold it cannot pollute the new session.
    try {
      this.emitter.emit('event', event)
    } catch (error) {
      // Unlike `record`, a throwing subscriber must not reject here — a buggy
      // dashboard would then be the thing that silences the disk-full warning.
      // Same shape as `closeWith` below: reported, never propagated.
      console.error(
        `[rhizomorph] a subscriber threw on the degrade alarm: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return { appended }
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
    // The seal is still taken FIRST, so prd17 ruling 1's structural guarantee is
    // untouched — a collector poll landing in the same tick still cannot slip in
    // behind the final line. Only the publishing moves (prd40 ruling 1).
    try {
      await this.writer.append(event)
      await this.writer.sync()
    } catch (error) {
      // The close did NOT happen, so the seal it took must not outlive it —
      // otherwise every later `record` waits on a session nobody will reopen.
      const release = this.releaseSeal
      this.sealed = null
      this.releaseSeal = null
      release?.()
      throw error
    }
    // Past here the session IS closed on disk, and two rules follow.
    //
    // The seal STAYS. Releasing it would let a later `record` append behind
    // `session.closed`, which is the guarantee prd17 ruling 1 makes structural.
    // Only `openSession` releases a seal the close earned.
    //
    // And nothing below may reject. `rotate.ts` reaches `removeSessionLock`
    // and `openSession` only once this resolves (`rotate.ts:149`, `:168`), so
    // rejecting here would strand that seal with nothing alive to release it:
    // every later `record` parks forever on the wait above, `runTick` never
    // returns, and the poll loop stops silently and permanently.
    this.buffer.push(event)
    this.advanceFold(event)
    try {
      this.emitter.emit('event', event)
    } catch (error) {
      // A subscriber's bug is not the closer's failure. Reported, never
      // propagated — the same shape as the poll loop's `recordOrDegrade`
      // (#239): the reporting path is never the crash path.
      console.error(
        `[rhizomorph] a subscriber threw on session.closed: ${error instanceof Error ? error.message : String(error)}`,
      )
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
