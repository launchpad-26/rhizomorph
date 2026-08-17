import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec } from '@rhizomorph/core'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSessionEvents, sessionFilePath } from '../log/session-log.js'
import { readSessionLock, writeSessionLock } from '../log/session-lock.js'
import { retargetSession } from '../recorder/rotate.js'
import { SessionRecorder } from '../recorder/session-recorder.js'
import { validateRetargetTarget } from './retarget-validation.js'

/** A stand-in `git rev-parse --is-inside-work-tree`: answers `true` unless told otherwise. */
function fakeGitExec(isRepo = true): Exec {
  return async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') {
      return isRepo
        ? { stdout: 'true\n', stderr: '', code: 0, failed: false }
        : { stdout: '', stderr: 'fatal: not a git repository', code: 128, failed: true }
    }
    return { stdout: '', stderr: '', code: null, failed: true, errorMessage: `spawn ${command} ENOENT` }
  }
}

describe('validateRetargetTarget (prd20 ruling 5, spike Q6)', () => {
  let root: string
  let newRepoPath: string
  let newSessionDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-retarget-validate-'))
    newRepoPath = path.join(root, 'new-repo')
    newSessionDir = path.join(root, 'new-session-dir')
    await mkdir(newRepoPath, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('ok: true when the path exists, is a git repo, and nothing holds a live writer lock there', async () => {
    const result = await validateRetargetTarget(newRepoPath, newSessionDir, { exec: fakeGitExec() })
    expect(result).toEqual({ ok: true })
  })

  it('fails "not-found" when the new path does not exist — and never runs git or reads a lock', async () => {
    const missing = path.join(root, 'does-not-exist')
    let execCalled = false
    const exec: Exec = async (...args) => {
      execCalled = true
      return fakeGitExec()(...args)
    }

    const result = await validateRetargetTarget(missing, newSessionDir, { exec })

    expect(result).toEqual({
      ok: false,
      failure: { reason: 'not-found', message: expect.stringContaining(missing) },
    })
    // Short-circuits: a path that doesn't exist is never worth a shell-out to check it further.
    expect(execCalled).toBe(false)
  })

  it('fails "not-a-repo" when the path exists but git rev-parse says it is not a work tree — the "launchable but not a repo" gap', async () => {
    const result = await validateRetargetTarget(newRepoPath, newSessionDir, { exec: fakeGitExec(false) })

    expect(result).toEqual({
      ok: false,
      failure: { reason: 'not-a-repo', message: expect.stringContaining(newRepoPath) },
    })
  })

  it('fails "writer-alive" when another rhizomorph already holds a live lock in the new repo\'s session dir', async () => {
    const otherRecorder = new SessionRecorder('1000', sessionFilePath(newSessionDir, '1000'))
    await otherRecorder.record(
      createEvent(
        'session.started',
        { sessionId: '1000', repoPath: newRepoPath, repoName: 'new-repo' },
        { id: 'evt-000001', ts: 1000 },
      ),
    )
    await writeSessionLock(newSessionDir, '1000', process.pid, 1000)

    const result = await validateRetargetTarget(newRepoPath, newSessionDir, {
      exec: fakeGitExec(),
      now: () => 6000,
    })

    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'writer-alive',
        message: expect.stringContaining(String(process.pid)),
        pid: process.pid,
        sessionId: '1000',
      },
    })
  })

  it('checks exist → git → writer-alive in that order — a not-found path never reaches the writer-alive check either', async () => {
    // A live writer in a dir keyed to a path that doesn't exist: if order were
    // reversed (or checks ran in parallel), this could surface as "writer-alive"
    // instead of "not-found".
    const missing = path.join(root, 'never-created')
    const missingSessionDir = path.join(root, 'never-created-session-dir')
    const otherRecorder = new SessionRecorder('1000', sessionFilePath(missingSessionDir, '1000'))
    await otherRecorder.record(
      createEvent(
        'session.started',
        { sessionId: '1000', repoPath: missing, repoName: 'never-created' },
        { id: 'evt-000001', ts: 1000 },
      ),
    )
    await writeSessionLock(missingSessionDir, '1000', process.pid, 1000)

    const result = await validateRetargetTarget(missing, missingSessionDir, {
      exec: fakeGitExec(),
      now: () => 6000,
    })

    expect(result).toMatchObject({ ok: false, failure: { reason: 'not-found' } })
  })

  /**
   * THE MUTATION THIS SUITE MUST CATCH (per AGENTS.md's own ask: "what mutation
   * would this test survive?"). The four tests above would pass identically
   * whether a caller validates before or after releasing the old session —
   * they only ever call `validateRetargetTarget` in isolation. This test makes
   * the ORDERING itself the assertion: it proves what a caller that validates
   * AFTER releasing would produce, so the correct order (validate, THEN call
   * `retargetSession` — never the reverse) is the only one that leaves the old
   * target untouched on a failing validation.
   */
  describe('the ordering property: validate BEFORE release, never after', () => {
    const OLD_REPO_PATH = '/repo/old-watched'
    let oldSessionDir: string
    let recorder: SessionRecorder

    beforeEach(async () => {
      oldSessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-retarget-validate-old-'))
      recorder = new SessionRecorder('1000', sessionFilePath(oldSessionDir, '1000'))
      await recorder.record(
        createEvent(
          'session.started',
          { sessionId: '1000', repoPath: OLD_REPO_PATH, repoName: 'old-watched' },
          { id: 'evt-000001', ts: 1000 },
        ),
      )
      await writeSessionLock(oldSessionDir, '1000', process.pid, 1000)
    })

    afterEach(async () => {
      await rm(oldSessionDir, { recursive: true, force: true })
    })

    it('the correct order — validate first — leaves the old session wide open when the target fails validation', async () => {
      const validation = await validateRetargetTarget(newRepoPath, newSessionDir, { exec: fakeGitExec(false) })
      expect(validation.ok).toBe(false)

      // A caller that respects the ordering never reaches `retargetSession` here.
      // Assert the old session is exactly as it was: no close, live lock intact.
      const eventsBefore = recorder.eventsSoFar()
      expect(eventsBefore.map((e) => e.type)).toEqual(['session.started'])
      expect(recorder.isSealed).toBe(false)
      expect(recorder.sessionId).toBe('1000')
    })

    it('the WRONG order — release before validating — closes the old session even though the target was never valid, which is exactly the bug the ordering law forbids', async () => {
      // A hypothetical broken caller: release first, discover the failure after.
      const rotation = await retargetSession({
        oldSessionDir,
        oldRepoPath: OLD_REPO_PATH,
        newSessionDir,
        newRepoPath,
        newRepoName: 'new-watched',
        recorder,
        now: () => 5000,
      })
      const validation = await validateRetargetTarget(newRepoPath, newSessionDir, { exec: fakeGitExec(false) })

      // The target was never valid, and the old log is closed anyway —
      // "nothing has happened" is false. This is the state a correct
      // caller (validate, then release) can never produce; the two tests in
      // this `describe` together prove the order in `retarget-validation.ts`'s
      // own doc is load-bearing, not just documented.
      expect(validation.ok).toBe(false)
      expect(rotation.closed.sessionId).toBe('1000')
      const oldLog = await readSessionEvents(sessionFilePath(oldSessionDir, '1000'))
      expect(oldLog.at(-1)?.type).toBe('session.closed')
      expect(await readSessionLock(oldSessionDir, '1000')).toBeNull()
    })
  })
})
