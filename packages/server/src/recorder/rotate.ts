import path from 'node:path'
import { createEvent } from '@rhizomorph/core'
import { sessionFileName } from '../log/paths.js'
import { removeSessionLock, writeSessionLock } from '../log/session-lock.js'
import type { SessionRecorder } from './session-recorder.js'

/**
 * ROTATION — the recorder's hand (prd16 ruling 2), the observer's third and
 * narrowest. It closes the current session log and opens a fresh one, on an
 * explicit operator command (`rhizomorph rotate`, or the dashboard's "end
 * session · start fresh" button), and it writes ONLY inside this repo's own
 * session directory: the log it closes, the log it opens, and the lock
 * sidecar beside them. Never the watched repo, never a ref, never a worktree,
 * never `~/.claude` — asserted, not promised, by `namespace-law.test.ts`.
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
 * THE CLOSE HALF. Appends the final `session.closed`, flushes and fsyncs the
 * log, then releases the session's lock — in that order, so at no instant is
 * there a live lock over a log that has already ended. The recorder is left
 * sealed: nothing more can be appended to the closed file, and anything a
 * collector records meanwhile waits for {@link openNextSession}.
 */
export async function closeCurrentSession(options: RotateSessionOptions): Promise<ClosedSession> {
  const { sessionDir, recorder } = options
  const now = options.now ?? Date.now
  const sessionId = recorder.sessionId
  const filePath = recorder.filePath
  const closedAt = now()
  // +1 for the close event itself: the number a reader of the finished file counts.
  const eventCount = recorder.eventsSoFar().length + 1

  await recorder.closeWith(
    createEvent(
      'session.closed',
      { sessionId, reason: 'rotated', eventCount },
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
export async function openNextSession(
  options: RotateSessionOptions,
  closed: ClosedSession,
): Promise<OpenedSession> {
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
      { sessionId, repoPath, repoName },
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
