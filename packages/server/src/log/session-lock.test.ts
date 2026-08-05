import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isLockLive,
  isPidAlive,
  LOCK_STALE_MS,
  readSessionLock,
  removeSessionLock,
  sessionLockFileName,
  writeSessionLock,
} from './session-lock.js'

/** A pid guaranteed dead by the time the assertion runs: a real process, spawned and reaped synchronously. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''])
  const pid = result.pid
  if (!pid) throw new Error('expected the probe process to have been given a pid')
  return pid
}

describe('isPidAlive', () => {
  it('reports the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('reports a reaped process as gone', () => {
    expect(isPidAlive(deadPid())).toBe(false)
  })
})

describe('isLockLive', () => {
  it('is live for a live pid with a fresh heartbeat', () => {
    expect(isLockLive({ pid: process.pid, heartbeatMs: 1000 }, 1000)).toBe(true)
  })

  it('is not live for a dead pid, even with a fresh heartbeat', () => {
    expect(isLockLive({ pid: deadPid(), heartbeatMs: 1000 }, 1000)).toBe(false)
  })

  it('is not live once the heartbeat is older than LOCK_STALE_MS, even for a live pid — the pid-reuse backstop', () => {
    expect(isLockLive({ pid: process.pid, heartbeatMs: 1000 }, 1000 + LOCK_STALE_MS)).toBe(true)
    expect(isLockLive({ pid: process.pid, heartbeatMs: 1000 }, 1000 + LOCK_STALE_MS + 1)).toBe(false)
  })
})

describe('SessionLock read/write/remove', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-session-lock-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null for a session that has never been locked', async () => {
    expect(await readSessionLock(dir, '1000')).toBeNull()
  })

  it('writes a lock beside the session log and reads it back', async () => {
    await writeSessionLock(dir, '1000', 4242, 5000)

    expect(await readSessionLock(dir, '1000')).toEqual({ pid: 4242, heartbeatMs: 5000 })
  })

  it('names the lock file the same sidecar convention every other sidecar in this dir uses', async () => {
    await writeSessionLock(dir, '1000', 4242, 5000)

    expect(await readFile(path.join(dir, sessionLockFileName('1000')), 'utf8')).toBe(
      JSON.stringify({ pid: 4242, heartbeatMs: 5000 }),
    )
  })

  it('a later write refreshes the same lock rather than appending', async () => {
    await writeSessionLock(dir, '1000', 4242, 5000)
    await writeSessionLock(dir, '1000', 4242, 9000)

    expect(await readSessionLock(dir, '1000')).toEqual({ pid: 4242, heartbeatMs: 9000 })
  })

  it('keys locks by session id — a different session starts unlocked', async () => {
    await writeSessionLock(dir, '1000', 4242, 5000)

    expect(await readSessionLock(dir, '2000')).toBeNull()
  })

  it('creates the directory lazily, the same as every other sidecar writer here', async () => {
    const nested = path.join(dir, 'nested')

    await writeSessionLock(nested, '1000', 4242, 5000)

    expect(await readSessionLock(nested, '1000')).toEqual({ pid: 4242, heartbeatMs: 5000 })
  })

  it('falls back to null for a corrupt lock file instead of throwing', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(dir, sessionLockFileName('1000')), 'not json', 'utf8')

    expect(await readSessionLock(dir, '1000')).toBeNull()
  })

  it('falls back to null for a lock file missing a required field', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(dir, sessionLockFileName('1000')), JSON.stringify({ pid: 4242 }), 'utf8')

    expect(await readSessionLock(dir, '1000')).toBeNull()
  })

  it('removes a lock, and does nothing (never throws) for one that is already gone', async () => {
    await writeSessionLock(dir, '1000', 4242, 5000)

    await removeSessionLock(dir, '1000')
    expect(await readSessionLock(dir, '1000')).toBeNull()

    await expect(removeSessionLock(dir, '1000')).resolves.toBeUndefined()
    await expect(removeSessionLock(dir, 'never-locked')).resolves.toBeUndefined()
  })
})
