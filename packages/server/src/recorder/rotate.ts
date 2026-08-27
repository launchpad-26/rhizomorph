import path from 'node:path'
import { createEvent, type SessionCloseReason, type SessionLink } from '@rhizomorph/core'
import { defaultClaudeProjectsRoot, repoSlug, sessionFileName } from '../log/paths.js'
import { removeSessionLock, writeSessionLock } from '../log/session-lock.js'
import { readSessionEvents } from '../log/session-log.js'
import { captureSessionTranscripts } from '../log/transcript-capture.js'
import { CloseNotDurableError, type SessionRecorder } from './session-recorder.js'

/**
 * ROTATION — the recorder's hand (prd16 ruling 2), the observer's third and
 * narrowest. It closes the current session log and opens a fresh one, on an
 * explicit operator command (`rhizomorph rotate`, or the dashboard's "end
 * session · start fresh" button), and it writes ONLY inside a watched repo's
 * own session directory: the log it closes, the log it opens, the lock
 * sidecar beside them, and — since prd16 ruling 3 — each closing lane's
 * transcript, captured beside the log it closes. It READS from
 * `~/.claude/projects` to do that capture, but never writes there. Never the
 * watched repo, never a ref, never a worktree — asserted, not promised, by
 * `namespace-law.test.ts`.
 *
 * Since prd20 ruling 5 (`retargetSession`, below), "a watched repo's own
 * session directory" can mean TWO directories in one call — the old repo's,
 * closed against, and the new repo's, opened against — never a third, and
 * never the SAME directory for both halves of a retarget the way a plain
 * rotation always uses the same one for both.
 *
 * **The ordering is the law** (prd17 ruling 3.5): close, THEN open, never
 * both open. The two halves are separate exported functions rather than one
 * block with a comment, because "what a crash between them leaves behind" is
 * a thing a test has to be able to stage — and what it leaves behind is a
 * closed log with no live lock, which the next boot reads and starts fresh
 * from (`decideSessionBoot`'s `closed` reason) rather than resuming.
 *
 * There is no process split (prd16 ruling 6): one binary, one recorder
 * object. What this module draws is a module boundary, so the day the
 * recorder should run apart from the observer, the doorway is already framed.
 */

export interface RotateSessionOptions {
  /** This repo's session directory — the only directory rotation writes into. */
  sessionDir: string
  /** Carried onto the new session's `session.started`, exactly as the boot path does. */
  repoPath: string
  repoName: string
  recorder: SessionRecorder
  /** Injectable clock, so a test's rotation is deterministic. Defaults to `Date.now`. */
  now?: () => number
  /** Whose lock the new session gets. Defaults to this process. */
  pid?: number
  /**
   * Root Claude Code tails project session logs under — where transcript
   * capture (prd16 ruling 3) reads each lane's LIVE transcript from before
   * copying it into the data directory. Defaults to `~/.claude/projects`;
   * tests point it at a fixture dir so a rotation in this suite never reads
   * (or depends on) the real one.
   */
  claudeProjectsRoot?: string
}

export interface ClosedSession {
  sessionId: string
  filePath: string
  /** Events in the closed log, counting its `session.closed` line. */
  eventCount: number
  closedAt: number
  /** False when the close line reached the file but `sync()` did not confirm it (prd-40 ruling 1, 1b). */
  synced: boolean
  /** Present only when `synced` is false: what the sync failure said. */
  syncError?: string
}

export interface OpenedSession {
  sessionId: string
  filePath: string
  startedAt: number
}

export interface Rotation {
  closed: ClosedSession
  opened: OpenedSession
}

/**
 * What {@link closeCurrentSession} actually reads — `repoPath`/`repoName`/`pid`
 * are the open half's own concern. `reason`/`successor` are non-default close
 * behaviour a plain rotation never sets (both stay optional and additive):
 * `retargetSession` is the one caller that passes them.
 */
export type CloseSessionOptions = Pick<RotateSessionOptions, 'sessionDir' | 'recorder' | 'now' | 'claudeProjectsRoot'> & {
  /** Defaults to `'rotated'`. A retarget passes `'retargeted'` instead — see `retargetSession`. */
  reason?: SessionCloseReason
  /** Where this run continued, when the successor lives under a directory this one can't imply (#384). Absent for an ordinary rotation. */
  successor?: SessionLink
}

/** What {@link openNextSession} actually reads. `predecessor` mirrors {@link CloseSessionOptions}'s `successor`. */
export type OpenSessionOptions = Pick<
  RotateSessionOptions,
  'sessionDir' | 'repoPath' | 'repoName' | 'recorder' | 'now' | 'pid'
> & {
  /** Where this run came from, when it isn't the log right where this one is opening (#384). Absent for an ordinary rotation. */
  predecessor?: SessionLink
}

/**
 * THE CLOSE HALF. Captures every lane's transcript (prd16 ruling 3), THEN
 * appends the final `session.closed`, flushes and fsyncs the log, then
 * releases the session's lock — in that order, so at no instant is there a
 * live lock over a log that has already ended. The recorder is left sealed:
 * nothing more can be appended to the closed file, and anything a collector
 * records meanwhile waits for {@link openNextSession}.
 *
 * Capture happens BEFORE the closing event, not after: if it throws, or the
 * process dies partway through, this session is never marked closed at all,
 * and the next boot resumes it exactly as any other mid-write crash leaves
 * it (`decideSessionBoot`'s `resumed`/`stale` reasons, never `closed`) —
 * never a closed log with no honest record of what capture actually got.
 * `captureSessionTranscripts` itself never throws for an individual lane it
 * could not find; it records that lane's gap in the manifest and moves on, so
 * one vanished transcript never blocks the operator's rotation.
 *
 * **A failed fsync does not fail the close** (prd-40 ruling 1, rule 1b-i, #80).
 * A session is closed the instant its `session.closed` line is appended; if the
 * following `sync()` fails, the close still happened and this returns a
 * `ClosedSession` with `synced: false` and the failure in `syncError` rather
 * than throwing. That is what makes reopening unconditional — the recorder
 * holds the seal it earned on that path, and only `openNextSession` releases
 * it, so a throw here would wedge every later `record()` forever. Every other
 * close failure is rule 1a, means the close did not happen, and still throws.
 */
export async function closeCurrentSession(options: CloseSessionOptions): Promise<ClosedSession> {
  const { sessionDir, recorder } = options
  const now = options.now ?? Date.now
  const sessionId = recorder.sessionId
  const filePath = recorder.filePath
  const closedAt = now()
  // +1 for the close event itself.
  //
  // **A claim about the session at the moment of append, not a census of the
  // file** (prd-40 ruling 1's fifth amendment, #80). A `record()` whose append
  // is already in flight has not been folded yet, though its line is ahead of
  // the close line on the writer's FIFO tail — so this can undercount the
  // finished file. Under rule 1b the close line's authority begins at its own
  // append, so what it carries is what was known at that moment and no more.
  // `verifyRecord` remains the thing that counts lines.
  //
  // Read from the FOLD, not from `eventsSoFar().length` (prd-44 ruling 4, #37):
  // the in-memory window is capped at `MAX_BUFFERED_EVENTS`, so past that a
  // buffer census would write "75001" into the durable record of a session that
  // recorded far more. `foldSoFar().eventCount` is never capped, and prd-40
  // ruling 2 already asks every reader to answer from the maintained fold
  // rather than re-derive from the buffer.
  const eventCount = recorder.foldSoFar().eventCount + 1

  await captureSessionTranscripts({
    events: recorder.eventsSoFar(),
    // The lane list must be every lane this SESSION named, not every lane
    // still in the recorder's window (#133): prd-44 ruling 4 caps that window,
    // so a lane whose attributing events have been evicted would be absent
    // from the capture — permanently, since the capture is what the lane index
    // reads once the log has been pruned. Read here rather than inside the
    // capture so `log/transcript-capture.ts` gains no import of its own reader
    // (`log/session-log.ts` already imports `log/lane-index.ts`, which imports
    // the capture — one more edge would close that ring). The read is safe at
    // this exact point: `session.closed` has not been appended yet and is not
    // an attributed type anyway, and an unreadable log comes back `[]`, which
    // the capture reads as "the read failed" rather than "no lanes".
    recordedEvents: await readSessionEvents(filePath),
    sessionDir,
    sessionId,
    claudeProjectsRoot: options.claudeProjectsRoot ?? defaultClaudeProjectsRoot(),
    now: closedAt,
  })

  let synced = true
  let syncError: string | undefined
  try {
    await recorder.closeWith(
      createEvent(
        'session.closed',
        {
          sessionId,
          reason: options.reason ?? 'rotated',
          eventCount,
          ...(options.successor ? { successor: options.successor } : {}),
        },
        // Derived from the closed session's own id rather than a counter, so it
        // is unique in the log without depending on which id factory a caller
        // happens to hold, and legible in the file (`session-closed-1000`).
        { id: `session-closed-${sessionId}`, ts: closedAt },
      ),
    )
  } catch (error) {
    // RULE 1b-i — a close that happened but was not synced is still a close, so
    // this returns rather than throws and carries the failure in its result.
    // That is what makes reopening unconditional: `rotateSession` and
    // `performRetarget` both reach `openNextSession` on their own, and it is
    // `openSession` that releases the seal rule 1b held.
    //
    // Any OTHER failure is rule 1a — the close did not happen, nothing is in
    // the file, and the recorder already released its own seal. That still
    // throws, which is what keeps rule 3's law honest: a subscriber throwing
    // after a durable close must still reject all the way out of here.
    if (!(error instanceof CloseNotDurableError)) throw error
    synced = false
    syncError = error.cause instanceof Error ? error.cause.message : String(error.cause)
  }
  // RULE 1b-ii — still runs on the unsynced path. The lock guards a LIVE
  // session, and this one is not live: its close line is on disk. Skipping it
  // would leave an orphan lock beside the new session's, for no gain.
  await removeSessionLock(sessionDir, sessionId)

  return { sessionId, filePath, eventCount, closedAt, synced, ...(syncError === undefined ? {} : { syncError }) }
}

/**
 * THE OPEN HALF. Mints the next session id off the clock — the same way the
 * boot path does — points the recorder at its fresh log, records its
 * `session.started`, and only then claims a lock for it.
 */
export async function openNextSession(options: OpenSessionOptions, closed: ClosedSession): Promise<OpenedSession> {
  const { sessionDir, repoPath, repoName, recorder } = options
  const now = options.now ?? Date.now
  const pid = options.pid ?? process.pid

  const startedAt = nextSessionStart(closed.sessionId, now())
  const sessionId = String(startedAt)
  const filePath = path.join(sessionDir, sessionFileName(startedAt))

  recorder.openSession(sessionId, filePath)
  await recorder.record(
    createEvent(
      'session.started',
      { sessionId, repoPath, repoName, ...(options.predecessor ? { predecessor: options.predecessor } : {}) },
      { id: `session-started-${sessionId}`, ts: startedAt },
    ),
  )
  await recorder.sync()
  await writeSessionLock(sessionDir, sessionId, pid, startedAt)

  return { sessionId, filePath, startedAt }
}

/**
 * A session id is its start timestamp (`log/paths.ts`), so a rotation inside
 * the same millisecond as the session it closes would reopen the *same* file
 * and append a second `session.started` to a log that already ended. One
 * millisecond past the closed id is the smallest honest answer: still
 * sortable, still parseable, and never the id of the session just closed.
 */
export function nextSessionStart(closedSessionId: string, nowMs: number): number {
  const now = Math.floor(nowMs)
  const closed = Number(closedSessionId)
  return Number.isFinite(closed) ? Math.max(now, Math.floor(closed) + 1) : now
}

/**
 * Boundaries already running, keyed by recorder — shared by `rotateSession`
 * AND `retargetSession` (#14), because the guarantee is "never two
 * close/open pairs racing the same recorder", and that has to be true whether
 * both sides are rotations, both are retargets, or one of each. What differs
 * is what the SECOND caller gets, and — since #49 — that depends on what
 * KIND of boundary is already running, which is why the map's value carries
 * a `kind` alongside the promise rather than the promise alone:
 *
 * - Second caller is a rotation, first is a rotation: COALESCES — two
 *   operators (or a click and a `rhizomorph rotate` in the same second)
 *   asking at once is ONE boundary, not two, so the second caller awaits the
 *   first's answer instead of closing a session that is a millisecond old.
 *   That is a considered decision (its own doc, above) and neither #14 nor
 *   #49 changes it.
 * - Second caller is a retarget, first is anything: REFUSES. Coalescing
 *   would hand the second caller the FIRST caller's destination — asked to
 *   move to B, told "moved to A", status 200 — which is exactly the
 *   queued-retarget failure mode the PRD rejects. A retarget that finds this
 *   map already occupied (by a rotation or another retarget) throws
 *   {@link RetargetInFlightError} instead of returning the entry.
 * - Second caller is a rotation, first is anything OTHER than a rotation:
 *   REFUSES (#49, prd-42 ruling 5). Handing a rotation caller a `Rotation`
 *   whose `closed.reason` is `'retargeted'` and whose `opened` session is a
 *   different repo than the one it asked to rotate is the same input class
 *   #14 already refused in the other direction — the rotation's own
 *   coalescing rationale above is an argument about two ROTATIONS sharing a
 *   boundary, and it does not carry to a boundary that is anything else.
 *   Deliberately spelled `kind !== 'rotation'` rather than `kind ===
 *   'retarget'`: the two are equivalent for the only two kinds that exist
 *   today, but the review that reopened #49 showed the equality form is
 *   fail-OPEN — a third kind added to this map later (nobody has written
 *   one; the map has always had exactly two callers) would silently coalesce
 *   past a check that only recognised the kinds it was written against. The
 *   inequality form refuses anything it does not specifically know is safe,
 *   which is the same posture `RetargetInFlightError` below already takes.
 *   Rejects with {@link RotationRefusedError} — a rejection, not a
 *   synchronous throw, matching `retargetSession`'s own error shape (both
 *   doors into this guard now fail the same way for `Promise.all` and
 *   `.catch` callers alike).
 */
interface InFlightBoundary {
  kind: 'rotation' | 'retarget'
  promise: Promise<Rotation>
}
const inFlight = new WeakMap<SessionRecorder, InFlightBoundary>()

/** Rejects {@link rotateSession}'s promise in place of coalescing onto a boundary that is not itself a rotation — see the map doc above. */
export class RotationRefusedError extends Error {}

/** Close, then open. See this module's own doc for why that order is the law. */
export function rotateSession(options: RotateSessionOptions): Promise<Rotation> {
  const running = inFlight.get(options.recorder)
  if (running) {
    if (running.kind !== 'rotation') {
      return Promise.reject(
        new RotationRefusedError(
          `a ${running.kind} is already in flight for this recorder — refusing rather than coalescing, ` +
            'since a boundary that is not itself a rotation may close into a repo (or state) this rotation never asked about',
        ),
      )
    }
    return running.promise
  }

  const rotation = (async () => {
    const closed = await closeCurrentSession(options)
    const opened = await openNextSession(options, closed)
    return { closed, opened }
  })()
  const boundary: InFlightBoundary = { kind: 'rotation', promise: rotation }
  inFlight.set(options.recorder, boundary)
  return rotation.finally(() => {
    if (inFlight.get(options.recorder) === boundary) inFlight.delete(options.recorder)
  })
}

export interface RetargetSessionOptions {
  /** The repo being left — closed against ITS OWN session dir, never the new one's. */
  oldSessionDir: string
  oldRepoPath: string
  /** The repo being switched to — opened against ITS OWN session dir, only after the old one is sealed. */
  newSessionDir: string
  newRepoPath: string
  newRepoName: string
  recorder: SessionRecorder
  now?: () => number
  pid?: number
  claudeProjectsRoot?: string
}

/**
 * THE RETARGET HALF-PAIR (prd20 ruling 5, spike Q2/Q6). Close against the OLD
 * repo's session dir, then open against the NEW one — the same two halves
 * `rotateSession` already uses, called with two different directories instead
 * of one. Unlike a rotation, this is not `reason: 'rotated'`: the successor
 * lives under a different slug the old directory can't imply, so the closed
 * log names `'retargeted'` and carries a `successor` pointer at the new
 * repo's slug (#384), and the opened log's `session.started` carries the
 * matching `predecessor` back — the old repo's slug and the exact session id
 * that was just sealed, which only the open half can know (the close half
 * finishes before the new session id is even minted).
 *
 * Validation against the new target happens BEFORE this is ever called
 * (validate-then-release — #386), but that only ever ruled out a bad
 * destination — it says nothing about a second retarget racing this one, and
 * nothing upstream of here was actually holding that boundary (#14: the
 * caller this doc used to name did not exist). So this function shares
 * `rotateSession`'s `inFlight` map (above) and REFUSES rather than coalesces:
 * a retarget that finds the map already occupied throws
 * {@link RetargetInFlightError} instead of returning someone else's result
 * under the caller's own name.
 *
 * That guard is exposed as two separable steps — {@link beginRetargetBoundary}
 * (reserve) and this function's own body (do the work) — because #14's
 * second defect was that reserving it only around the close/open leaves the
 * SLOW part (`api/retarget.ts`'s validation, well before either half here
 * ever runs) outside the guard entirely: a second retarget arriving while the
 * first is still validating would find the map EMPTY and slip through on a
 * `from` snapshot the first retarget had, by then, already made stale. A
 * caller that itself has slow work to do before it may call this function —
 * `api/retarget.ts` is exactly that caller — reserves the slot with
 * `beginRetargetBoundary` FIRST, before any of that slow work, and this
 * function stays the simple, self-contained, all-in-one entry point for a
 * caller (this module's own tests included) that has nothing to do first.
 */
export class RetargetInFlightError extends Error {}

export interface RetargetBoundary {
  /** The close/open actually happened — settle with its real result, releasing the guard. */
  resolve(rotation: Rotation): void
  /** The boundary is being abandoned without ever running the close/open (a refusal upstream of it, or an unexpected failure) — releases the guard just the same, but as a rejection. */
  reject(err: unknown): void
}

/**
 * Reserve this recorder's slot in the shared `inFlight` map — the FIRST thing
 * any retarget does, before validation, before it even snapshots which repo
 * it is leaving. Returns null when a rotation or another retarget already
 * holds it, so the caller can refuse immediately, having touched nothing
 * (no loop stop, no validation, no snapshot) rather than discovering the
 * collision only after doing all of that.
 *
 * The reservation is tagged `kind: 'retarget'` in `inFlight` the instant this
 * returns, so a `rotateSession` racing this retarget sees that tag — and, per
 * #49/prd-42 ruling 5, REFUSES rather than coalescing — from the very first
 * instant. It never observes a window where the retarget is "reserved but not
 * really running yet".
 */
export function beginRetargetBoundary(recorder: SessionRecorder): RetargetBoundary | null {
  if (inFlight.has(recorder)) return null

  let settle!: (rotation: Rotation) => void
  let fail!: (err: unknown) => void
  const pending = new Promise<Rotation>((res, rej) => {
    settle = res
    fail = rej
  })
  // Nobody may ever coalesce onto a boundary that is refused before it does
  // any work — this reference must not turn that into an unhandled rejection.
  pending.catch(() => {})
  const boundary: InFlightBoundary = { kind: 'retarget', promise: pending }
  inFlight.set(recorder, boundary)

  const release = () => {
    if (inFlight.get(recorder) === boundary) inFlight.delete(recorder)
  }
  return {
    resolve: (rotation) => {
      settle(rotation)
      release()
    },
    reject: (err) => {
      fail(err)
      release()
    },
  }
}

/**
 * The close/open pair itself, guard-free — reserving the slot is the
 * caller's job, either directly via {@link beginRetargetBoundary} (what
 * `api/retarget.ts` does, having already reserved it well before this point)
 * or implicitly by calling {@link retargetSession} instead of this function.
 */
export async function performRetarget(options: RetargetSessionOptions): Promise<Rotation> {
  const closed = await closeCurrentSession({
    sessionDir: options.oldSessionDir,
    recorder: options.recorder,
    now: options.now,
    claudeProjectsRoot: options.claudeProjectsRoot,
    reason: 'retargeted',
    successor: { repoSlug: repoSlug(options.newRepoPath) },
  })
  const opened = await openNextSession(
    {
      sessionDir: options.newSessionDir,
      repoPath: options.newRepoPath,
      repoName: options.newRepoName,
      recorder: options.recorder,
      now: options.now,
      pid: options.pid,
      predecessor: { repoSlug: repoSlug(options.oldRepoPath), sessionId: closed.sessionId },
    },
    closed,
  )
  return { closed, opened }
}

export async function retargetSession(options: RetargetSessionOptions): Promise<Rotation> {
  const boundary = beginRetargetBoundary(options.recorder)
  if (boundary === null) {
    throw new RetargetInFlightError(
      'a rotation or retarget is already in flight for this recorder — refusing rather than coalescing, ' +
        'since coalescing would report the FIRST boundary\'s destination as this call\'s own result',
    )
  }
  try {
    const rotation = await performRetarget(options)
    boundary.resolve(rotation)
    return rotation
  } catch (err) {
    boundary.reject(err)
    throw err
  }
}

/**
 * Test-only: reserves this recorder's `inFlight` slot under an arbitrary
 * `kind`, bypassing the two kinds any real caller can ever produce
 * (`'rotation'` via {@link rotateSession}, `'retarget'` via
 * {@link beginRetargetBoundary}). Exists so `rotateSession`'s guard can be
 * proven fail-closed against a kind NOBODY has written yet, rather than
 * trusting that property until a real third caller shows up and either
 * confirms or breaks it — precisely the gap the equality-vs-inequality
 * distinction in this module's own doc comment above exists to close.
 * The reserved promise never settles on its own; the returned release
 * function is how a test lets it go. No production code may import this.
 */
export function reserveInFlightForTest(recorder: SessionRecorder, kind: string): () => void {
  const boundary: InFlightBoundary = { kind: kind as InFlightBoundary['kind'], promise: new Promise<Rotation>(() => {}) }
  inFlight.set(recorder, boundary)
  return () => {
    if (inFlight.get(recorder) === boundary) inFlight.delete(recorder)
  }
}
