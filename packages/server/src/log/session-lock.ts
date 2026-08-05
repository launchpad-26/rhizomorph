import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * How often a live writer refreshes its lock's heartbeat. `decideSessionBoot`
 * (`session-log.ts`) treats a heartbeat older than `LOCK_STALE_MS` as
 * abandoned regardless of what the pid check says — see that constant's own
 * doc for why both signals exist.
 */
export const LOCK_HEARTBEAT_INTERVAL_MS = 5_000

/**
 * How old a lock's heartbeat may be before it is treated as abandoned, even
 * if `isPidAlive` reports the pid as running. Pid checks alone are not
 * enough over a long-lived data dir: pid numbers wrap and get reused by an
 * unrelated process, and a lock from a session recorded weeks ago could
 * still name a pid that happens to be alive today. A missed heartbeat is the
 * backstop for that case. Set to 4x the heartbeat interval — three missed
 * refreshes' tolerance for a slow tick — while the *common* case (the writer
 * actually crashed) is already caught the instant `isPidAlive` reports the
 * pid gone, well before this window elapses.
 */
export const LOCK_STALE_MS = LOCK_HEARTBEAT_INTERVAL_MS * 4

export interface SessionLock {
  pid: number
  /** Epoch millis the lock was last refreshed. */
  heartbeatMs: number
}

/** Same sidecar-naming convention as `sessionLabelFileName` / the resume counter (`log/paths.ts`, `session-log.ts`) — a file beside the log, never a mutation of it. */
export function sessionLockFileName(sessionId: string): string {
  return `session-${sessionId}.lock.json`
}

function isSessionLock(value: unknown): value is SessionLock {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.pid === 'number' &&
    Number.isInteger(candidate.pid) &&
    typeof candidate.heartbeatMs === 'number' &&
    Number.isFinite(candidate.heartbeatMs)
  )
}

/** Reads back `dir`'s lock for `sessionId`. Never throws: a missing or corrupt lock just means "no writer claims this session", the same convention `readResumedCount` follows. */
export async function readSessionLock(dir: string, sessionId: string): Promise<SessionLock | null> {
  try {
    const raw = await readFile(path.join(dir, sessionLockFileName(sessionId)), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isSessionLock(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Claims or refreshes `sessionId`'s lock as `pid`, heartbeated at `nowMs`. Called once at boot and then on every heartbeat tick by whichever process is actively writing the session. */
export async function writeSessionLock(dir: string, sessionId: string, pid: number, nowMs: number): Promise<void> {
  await mkdir(dir, { recursive: true })
  const lock: SessionLock = { pid, heartbeatMs: nowMs }
  await writeFile(path.join(dir, sessionLockFileName(sessionId)), JSON.stringify(lock), 'utf8')
}

/** Releases `sessionId`'s lock on a clean stop. Never throws: a lock already gone (or never claimed) is not an error. */
export async function removeSessionLock(dir: string, sessionId: string): Promise<void> {
  try {
    await unlink(path.join(dir, sessionLockFileName(sessionId)))
  } catch {
    // already gone — nothing to release
  }
}

/**
 * Whether `pid` names a running process. Chosen deliberately over a native
 * dependency: `process.kill(pid, 0)` sends no signal, it only asks the OS
 * whether the pid exists — Node documents this as the portable way to probe
 * a pid, and it needs nothing beyond Node itself. Verified where this
 * instrument actually runs: Linux, WSL, macOS all implement POSIX signal 0
 * the same way. Node's Windows backend (libuv) claims the same "signal 0
 * probes existence" behaviour, but that path is unverified this round — a
 * native Windows host, not WSL, is the one environment this check has not
 * been run against.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the pid exists but belongs to a process we can't signal —
    // still alive. Anything else (ESRCH: no such process) means it is gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Whether `lock`'s writer should still be treated as live at `nowMs` — the
 * single predicate `decideSessionBoot` gates a resume on. Both signals must
 * agree: a fresh heartbeat from a pid that's gone is a crash caught before
 * its next tick; a live pid behind a stale heartbeat is the pid-reuse case
 * `LOCK_STALE_MS` exists for.
 */
export function isLockLive(lock: SessionLock, nowMs: number): boolean {
  if (nowMs - lock.heartbeatMs > LOCK_STALE_MS) return false
  return isPidAlive(lock.pid)
}
