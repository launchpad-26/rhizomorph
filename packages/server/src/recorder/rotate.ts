import path from 'node:path'
import { createEvent, type SessionCloseReason, type SessionLink } from '@rhizomorph/core'
import { defaultClaudeProjectsRoot, repoSlug, sessionFileName } from '../log/paths.js'
import { removeSessionLock, writeSessionLock } from '../log/session-lock.js'
import { captureSessionTranscripts } from '../log/transcript-capture.js'
import type { SessionRecorder } from './session-recorder.js'

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
 */
export async function closeCurrentSession(options: CloseSessionOptions): Promise<ClosedSession> {
  const { sessionDir, recorder } = options
  const now = options.now ?? Date.now
  const sessionId = recorder.sessionId
  const filePath = recorder.filePath
  const closedAt = now()
  // +1 for the close event itself: the number a reader of the finished file counts.
  const eventCount = recorder.eventsSoFar().length + 1

  await captureSessionTranscripts({
    events: recorder.eventsSoFar(),
    sessionDir,
    sessionId,
    claudeProjectsRoot: options.claudeProjectsRoot ?? defaultClaudeProjectsRoot(),
    now: closedAt,
  })

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
  await removeSessionLock(sessionDir, sessionId)

  return { sessionId, filePath, eventCount, closedAt }
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
 * Rotations already running, keyed by recorder. Two operators (or a click and
 * a `rhizomorph rotate` in the same second) asking at once is ONE boundary,
 * not two — the second caller awaits the first's answer instead of closing a
 * session that is a millisecond old.
 */
const inFlight = new WeakMap<SessionRecorder, Promise<Rotation>>()

/** Close, then open. See this module's own doc for why that order is the law. */
export function rotateSession(options: RotateSessionOptions): Promise<Rotation> {
  const running = inFlight.get(options.recorder)
  if (running) return running

  const rotation = (async () => {
    const closed = await closeCurrentSession(options)
    const opened = await openNextSession(options, closed)
    return { closed, opened }
  })()
  inFlight.set(options.recorder, rotation)
  return rotation.finally(() => {
    if (inFlight.get(options.recorder) === rotation) inFlight.delete(options.recorder)
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
 * No in-flight guard here, unlike `rotateSession`'s `WeakMap`: a retarget is
 * validated against the new target BEFORE this is ever called (validate-then-
 * release — #386), so a second concurrent retarget racing this one is that
 * caller's own boundary to hold, not this function's.
 */
export async function retargetSession(options: RetargetSessionOptions): Promise<Rotation> {
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
