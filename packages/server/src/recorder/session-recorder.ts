import { EventEmitter } from 'node:events'
import { initialSessionState, reduce, reduceAll } from '@rhizomorph/core'
import type { EventOf, RhizomorphEvent, SessionState } from '@rhizomorph/core'
import { SessionLogWriter } from './session-log-writer.js'

/**
 * The close line reached the file but `sync()` did not confirm it — prd-40
 * ruling 1, rule 1b (#80). The session IS closed: a session is closed the
 * instant its `session.closed` line is appended, and durability is a separate,
 * later property. Its seal is therefore held, and only `openSession` releases
 * it.
 *
 * Distinct **by type**, not by message, because `closeCurrentSession` has to
 * tell this apart from every other close failure — which means rule 1a, the
 * close did not happen at all — and an error message is not an API.
 */
export class CloseNotDurableError extends Error {
  constructor(
    readonly sessionId: string,
    override readonly cause: unknown,
  ) {
    super(
      `session ${sessionId} was closed but not synced: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        'The `session.closed` line is in the file and the session is sealed; durability is what was lost.',
    )
    this.name = 'CloseNotDurableError'
  }
}

/**
 * The in-memory window's ceiling: at most 75,000 events of the session being
 * recorded stay in `eventsSoFar()`, oldest evicted first (prd-44 ruling 4).
 *
 * **The number is the operator's, and it is the client's number.** Wave 0's
 * answer (2026-08-27, #37) is *the same bound the browser already sets on the
 * same data* — `MAX_EVENTS` in `web/src/app/streamState.ts`. Ruling 4's whole
 * complaint is that one side of the wire ruled and the other kept everything
 * and said nothing; a different number here would leave that half-fixed, with
 * `eventsWindowLabel`'s vocabulary meaning two things depending on which side
 * you read. This repo's longest recording is 63,653 events over 43.5 h
 * (`research/2026-08-16-concurrency-measurement.md`), so 75,000 is a ceiling
 * against a session that runs away, not a working window that truncates a real
 * day.
 *
 * **What is bounded, and what is deliberately not.** This trims the raw window
 * only. The fold ({@link SessionRecorder.foldSoFar}) still sees every event the
 * session ever recorded — `eventCount` included — so nothing that reads the
 * fold can tell eviction happened, and `eventsSoFar().length <
 * foldSoFar().eventCount` is exactly how a reader detects that it holds a
 * partial window. That is the same pair, read the same way, as
 * `eventsWindowLabel`: the vocabulary is reused rather than twinned.
 */
export const MAX_BUFFERED_EVENTS = 75_000

/**
 * How many evicted slots the backing array may carry before it is compacted.
 *
 * Eviction moves an index; it does not `splice`. A `splice(0, n)` per event
 * past the bound would memmove 75,000 pointers — ~600 KB — on **every**
 * subsequent event, which is the same per-event cost prd-44 ruling 2 just
 * removed from the append path, reintroduced one file away. Advancing the
 * window index is O(1), and the array is rebuilt once per 1,024 evictions
 * instead: 75,000 pointer copies amortised over 1,024 events is ~73 per event,
 * against a bound on the live array of
 * `MAX_BUFFERED_EVENTS + COMPACT_AFTER_EVICTED` slots. Both halves — the window
 * and the slots behind it — are pinned by laws, because a bound on only what
 * the window hands out would hold while memory grew forever.
 */
export const COMPACT_AFTER_EVICTED = 1_024

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
 * Freezes `value` and everything reachable from it, stopping at anything
 * already frozen.
 *
 * That short-circuit is what makes this affordable rather than a per-event
 * walk of the whole state: `reduce` copies only the spine it changed and
 * shares every untouched subtree, and those subtrees were frozen when they
 * were created. So each event freezes roughly what it allocated.
 *
 * Sound because `SessionState` is plain objects, arrays and `Record`s — no
 * `Map`, `Set` or `Date`, which `Object.freeze` would not protect. That is a
 * property #179 deliberately maintains: the fold's own lookup tables live in
 * `UsageIndex` *beside* the reducer, never in the state slice
 * (`core/src/state.ts:426`, pinned by `state.test.ts`).
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
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
  /**
   * The session's events, of which the live window is everything from
   * {@link windowStart} on. Slots before that index are evicted — unreachable,
   * and reclaimed in one pass per {@link COMPACT_AFTER_EVICTED} of them.
   *
   * **Never read directly except where the whole array is provably the window**
   * (the constructor, before anything is evicted). `eventsSoFar()` and the
   * fold's repair path both start at `windowStart`; forgetting it is how a
   * reader silently gets events that were meant to be gone.
   */
  private buffer: RhizomorphEvent[] = []
  /** Index of the window's first live event in {@link buffer}. */
  private windowStart = 0
  /**
   * How many events this session has dropped out of the window (prd-44 ruling
   * 4). Zero for every session under {@link MAX_BUFFERED_EVENTS}, which is
   * every session this repo has yet recorded — and the flag the fold's repair
   * path reads to know whether {@link buffer} is still ground truth.
   */
  private evictedFromWindow = 0
  /**
   * The fold of every event recorded this session — NOT of {@link buffer},
   * once eviction has begun. Maintained incrementally rather than
   * rebuilt per read (prd40 ruling 2). Kept exactly in step with `buffer`:
   * every push into it is followed, in the same synchronous step, by an
   * `advanceFold` call — see `record`, `closeWith` and `openSession`.
   *
   * Definitely assigned: the constructor assigns it through {@link setFold},
   * which is the only writer (#69). `tsc`'s definite-assignment analysis does
   * not follow a method call, so the alternative to this assertion would be an
   * initializer whose whole job is to be overwritten one line later.
   */
  private foldState!: SessionState
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
    // Assigned, not `push(...resumeFrom)`: a spread is one argument per event,
    // and V8 throws `RangeError: Maximum call stack size exceeded` somewhere
    // around 100k arguments — on exactly the long resumed sessions this bound
    // exists for. `buffer` is empty here, so the two were only ever equivalent.
    if (options.resumeFrom) this.buffer = [...options.resumeFrom]
    // The fold is taken over EVERY resumed event, before anything is evicted,
    // so a resumed session's fold is complete even when its window cannot be.
    this.setFold(reduceAll(this.buffer))
    this.trimWindow()
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
   * Pushes one event into the window, evicting the oldest if that puts it over
   * {@link MAX_BUFFERED_EVENTS}. The ONLY writer of {@link buffer}'s tail, so
   * the bound cannot be missed by one publish path while holding on the other
   * two — the shape of defect this repo keeps finding.
   */
  private appendToWindow(event: RhizomorphEvent): void {
    this.buffer.push(event)
    this.trimWindow()
  }

  /**
   * Drops the oldest events until the window is within
   * {@link MAX_BUFFERED_EVENTS}, oldest first — the client's own rule
   * (`streamState.ts`: "capped at `MAX_EVENTS`, oldest evicted first").
   *
   * Eviction advances an index rather than splicing; see
   * {@link COMPACT_AFTER_EVICTED} for the arithmetic, and note that compaction
   * leaves the window's CONTENTS untouched — it only renumbers where it starts.
   */
  private trimWindow(): void {
    const overflow = this.buffer.length - this.windowStart - MAX_BUFFERED_EVENTS
    if (overflow <= 0) return
    this.windowStart += overflow
    this.evictedFromWindow += overflow
    if (this.windowStart >= COMPACT_AFTER_EVICTED) {
      this.buffer = this.buffer.slice(this.windowStart)
      this.windowStart = 0
    }
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
      this.setFold(reduce(this.foldState, event))
    } catch {
      this.foldDesynced = true
    }
  }

  /**
   * The ONLY assignment to {@link foldState}. Every fold this recorder hands
   * out is frozen (prd40 #69, ADR-0031), and routing every path through here is
   * what makes that structural rather than four remembered call sites.
   */
  private setFold(next: SessionState): void {
    this.foldState = deepFreeze(next)
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
    this.appendToWindow(event)
    this.advanceFold(event)
    // A throwing subscriber no longer rejects this call (#106). It used to, and
    // that was not harmless: `poll-loop.ts:223` calls `record` inside the try
    // whose catch builds a `collector.error`, with the snapshot advance behind
    // it — so a buggy dashboard manufactured a false error naming a healthy
    // collector AND left the snapshot un-advanced, re-appending the whole batch
    // next tick. `subscribe` isolates every listener, so this emit cannot throw
    // and all three publish paths now agree: a subscriber's bug is not the
    // publisher's failure.
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
      this.appendToWindow(event)
      this.advanceFold(event)
    }
    // On a FAILED append we fall through to the emit having touched neither
    // `buffer` nor `foldState`, whatever the writer did in the meantime: a
    // rotation racing the alarm is not a reason to silence it, and since
    // nothing entered the buffer or the fold it cannot pollute the new session.
    // The guard moved to `subscribe` (#106), which isolates every listener at
    // registration: this emit cannot throw, and — the part the per-site guard
    // could never buy — a buggy dashboard is no longer what silences the
    // disk-full alarm for every dashboard behind it (ADR-0030).
    this.emitter.emit('event', event)
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
   *
   * **Two ways to reject, and they mean opposite things** (prd40 ruling 1's
   * fifth amendment, #80):
   *
   * - the **append** failed — rule 1a. Nothing reached the file, the close did
   *   not happen, and the seal is released before the original error is
   *   rethrown.
   * - the **sync** failed after the append resolved — rule 1b. The close DID
   *   happen; the line is in the file. The seal is HELD, and the rejection is
   *   a {@link CloseNotDurableError} so the caller can tell the two apart.
   */
  async closeWith(event: EventOf<'session.closed'>): Promise<void> {
    while (this.sealed !== null) await this.sealed
    this.sealed = new Promise<void>((resolve) => {
      this.releaseSeal = resolve
    })
    // The seal is still taken FIRST, so prd17 ruling 1's structural guarantee is
    // untouched — a collector poll landing in the same tick still cannot slip in
    // behind the final line. Only the publishing moves (prd40 ruling 1).
    //
    // The append and the sync are caught SEPARATELY (prd40 ruling 1's fifth
    // amendment, #80). One `try` around both cannot tell which failed, and the
    // two failures are opposite facts: a failed append means the close never
    // happened, a failed sync means it happened and is merely not durable.
    try {
      await this.writer.append(event)
    } catch (error) {
      // RULE 1a — the close did NOT happen. Nothing reached the file, so the
      // seal it took must not outlive it; otherwise every later `record` waits
      // on a session nobody will reopen.
      const release = this.releaseSeal
      this.sealed = null
      this.releaseSeal = null
      release?.()
      throw error
    }
    // Past this line `session.closed` IS in the file, so the session is closed
    // — durability is a separate, later property. RULE 1b: the seal STAYS
    // whatever happens below, because prd17 ruling 1's "it is the last line" is
    // now owed and only `openSession` releases a seal the close earned.
    try {
      await this.writer.sync()
    } catch (error) {
      // RULE 1b — the close happened but is not durable. Reject, so the lost
      // durability reaches the operator rather than being swallowed; and hold
      // the seal, so nothing appends behind `session.closed`.
      //
      // This does NOT wedge the recorder. The seal would be unreleasable only
      // if reopening were conditional on a successful close, and since #80 it
      // is not: `closeCurrentSession` absorbs this rejection (rule 1b-i) and
      // `openNextSession` runs regardless, releasing the seal.
      //
      // Nothing is published on this path — no buffer push, no `advanceFold`,
      // no emit. That leaves the fold BEHIND the file rather than ahead of it,
      // which is the side success 1 permits ("leaves the fold ahead of the file
      // after a rejected append" is what it forbids), and it is what the code
      // already did when append and sync shared a catch. The fifth amendment
      // moves the seal, not the publishing.
      throw new CloseNotDurableError(this.currentSessionId, error)
    }
    // Past here the session IS closed on disk AND durable, and two rules follow.
    //
    // The seal STAYS. Releasing it would let a later `record` append behind
    // `session.closed`, which is the guarantee prd17 ruling 1 makes structural.
    // Only `openSession` releases a seal the close earned.
    //
    // And nothing below may reject (rule 3, untouched by #80). The ONE
    // rejection `closeCurrentSession` absorbs is {@link CloseNotDurableError}
    // above; every other one still propagates, and `rotate.ts` then reaches
    // neither `removeSessionLock` nor `openSession`. So rejecting here would
    // strand that seal with nothing alive to release it: every later `record`
    // parks forever on the wait above, `runTick` never returns, and the poll
    // loop stops silently and permanently.
    this.appendToWindow(event)
    this.advanceFold(event)
    // The guard moved to `subscribe` (#106), which isolates every listener at
    // registration: this emit cannot throw, so rule 3 still holds — nothing
    // below a durable close rejects, `rotate.ts` still reaches `openSession`,
    // and the seal is never stranded.
    this.emitter.emit('event', event)
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
    // A rotation is not an eviction: the window is emptied outright and the
    // eviction count goes back to zero, so the new session's fold is once again
    // repairable from its own buffer.
    this.buffer = []
    this.windowStart = 0
    this.evictedFromWindow = 0
    this.setFold(initialSessionState())
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
   * Returned by reference, not copied — copying here would both defeat the
   * O(1) cost this method exists to provide and break the identity law that
   * makes "no re-fold on any route" hold however a caller reaches it.
   *
   * Read-only is **enforced, not conventional** (#69, ADR-0031). Unlike
   * `reduceAll(...)`, which hands every caller a private fold, this hands out
   * the recorder's ONLY one, and `foldDesynced` is raised only when `reduce`
   * throws — never when a caller writes. So a caller's mutation would be
   * silent, permanent for the session, and unrepairable. Every fold is
   * therefore deep-frozen on assignment ({@link setFold}), and a caller's
   * write throws instead of corrupting.
   *
   * What that does NOT cover: a caller who casts the freeze away. It closes
   * the silent-corruption failure mode, not every route to it.
   */
  foldSoFar(): SessionState {
    // The repair rebuilds from `buffer`, which is ground truth ONLY while the
    // window still holds the whole session (prd-44 ruling 4, #37). Past the
    // first eviction it is a window, and rebuilding from it would produce a
    // fold missing every evicted event — tens of thousands of them — where the
    // incremental fold is missing only the one event `reduce` threw on. So the
    // better of two imperfect answers is kept, and kept deliberately: this is
    // not a case the repair can serve, not one it forgot.
    if (this.foldDesynced && this.evictedFromWindow === 0) {
      this.setFold(reduceAll(this.buffer))
      this.foldDesynced = false
    }
    return this.foldState
  }

  /**
   * The session's events in order — **the last {@link MAX_BUFFERED_EVENTS} of
   * them**, not necessarily all of them (prd-44 ruling 4, #37).
   *
   * A caller that needs to know whether it holds the whole session asks the
   * same question the browser already asks of the same data: this array's
   * length against `foldSoFar().eventCount`, which is never capped. Equal means
   * whole; less means a partial window, and the reader must say so rather than
   * let it pass as the session — `eventsWindowLabel`
   * (`web/src/app/streamState.ts`) is the existing wording for that, and
   * {@link evictedEventCount} is the same fact stated directly.
   */
  eventsSoFar(): RhizomorphEvent[] {
    return this.buffer.slice(this.windowStart)
  }

  /**
   * How many events have been dropped from the window this session — 0 for
   * every session under {@link MAX_BUFFERED_EVENTS}, and the direct form of the
   * `eventsSoFar().length < foldSoFar().eventCount` test above.
   */
  get evictedEventCount(): number {
    return this.evictedFromWindow
  }

  /**
   * Test-only: how many array slots the window is actually holding, evicted
   * ones included. The window's own bound says nothing about the memory behind
   * it — an implementation that never reclaimed an evicted slot would pass
   * every other law here while growing forever — so the compaction law reads
   * this. Same role as `ParsedSessionLogCache.parseCount` (`log/lane-index.ts`):
   * a number no production caller has any business reading.
   */
  bufferedSlotsForTests(): number {
    return this.buffer.length
  }

  /** Subscribes to events recorded from this point on. Returns an unsubscribe function. */
  subscribe(listener: (event: RhizomorphEvent) => void): () => void {
    // prd40 #106: Node's `emit` abandons the listener list at the FIRST throw, so
    // an unguarded listener silences every subscriber registered after it — for
    // every event, on all three publish paths. Each listener is therefore isolated
    // at registration: its throw is reported and goes no further, and the emit
    // itself can no longer fail. `api/stream.ts` gives one of these per SSE
    // client, and `setMaxListeners(0)` above says how many that can be.
    //
    // A subscriber's bug is not the publisher's failure — the asymmetry
    // `closeWith` already drew and `recordOrDegrade` (#239) established.
    const guarded = (event: RhizomorphEvent): void => {
      try {
        listener(event)
      } catch (error) {
        console.error(
          `[rhizomorph] a subscriber threw on ${event.type}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    this.emitter.on('event', guarded)
    // Closes over `guarded`, NOT `listener`: `off` matches by reference, so
    // unsubscribing the caller's own function would silently remove nothing and
    // leak a listener per SSE client. Pinned by the unsubscribe law (#106).
    return () => this.emitter.off('event', guarded)
  }
}
