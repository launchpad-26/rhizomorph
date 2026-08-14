import { existsSync } from 'node:fs'
import type { Exec } from '@rhizomorph/core'
import { decideSessionBoot } from '../log/session-log.js'

/**
 * VALIDATE-THEN-RELEASE (prd20 ruling 5, spike Q6). This is the whole reason
 * rotate-and-reinit beat supervised respawn: `process.execve` is experimental
 * and POSIX-only, and a failed `execve` is not catchable — it aborts the
 * process, exit 134 (SIGABRT), with no rollback and no way to tell the
 * browser what happened. Rotate-and-reinit can validate BEFORE it lets go of
 * the old target, and refuse with the old target still running.
 *
 * This module runs `git rev-parse` through an injected {@link Exec} — an
 * execution channel `recorder/`'s namespace law forbids outright
 * (`namespace-law.test.ts`'s "names ... no way to run a command"). That is
 * why this lives here and not beside the recorder's own retarget function
 * (`recorder/rotate.ts`): validating a candidate repo and closing/opening a
 * session log are different powers, and only the second one is the
 * recorder's to hold.
 *
 * Three checks, in this order, ALL of which must pass before a caller may go
 * on to retarget — this module never reaches into `recorder/` itself, so the
 * ordering is enforced by what the caller does with the result, not by
 * anything in this file. See `retarget-validation.test.ts` for the test that
 * makes this concrete: releasing the old session before this resolves is
 * exactly the bug this two-step shape exists to make impossible to write by
 * accident.
 *
 * 1. The new path exists.
 * 2. It is a git work tree — the same `git rev-parse --is-inside-work-tree`
 *    check `cli/doctor.ts`'s `checkTargetPath` already uses. Skipping this is
 *    the "launchable but not a repo" gap: `cli/run.ts` only exits on a listen
 *    failure, and a bad repo just disables the git collector
 *    (`git-collector.ts`) — a running instrument watching nothing, reporting
 *    healthy.
 * 3. No `writer-alive` in the new repo's session dir — another rhizomorph
 *    already watching that repo is exactly the second instance prd-20 ruling
 *    5 forbids. Reuses `decideSessionBoot`, the same predicate the boot path
 *    and `doctor`'s `session-boundary` check already trust for this.
 */
export interface RetargetValidationOptions {
  exec: Exec
  /** Injectable clock, so a test's validation runs at a pinned instant. Defaults to `Date.now`. */
  now?: () => number
}

export type RetargetValidationFailure =
  | { reason: 'not-found'; message: string }
  | { reason: 'not-a-repo'; message: string }
  | { reason: 'writer-alive'; message: string; pid: number; sessionId: string }

export type RetargetValidationResult = { ok: true } | { ok: false; failure: RetargetValidationFailure }

/**
 * Validates a retarget candidate. Never mutates anything — no session closes,
 * no lock is written or removed, no lock is even read for a purpose other
 * than answering the question. A caller that gets `{ ok: true }` still has to
 * go do the actual retarget itself; a caller that gets `{ ok: false }` has
 * changed nothing about either repo.
 */
export async function validateRetargetTarget(
  newRepoPath: string,
  newSessionDir: string,
  options: RetargetValidationOptions,
): Promise<RetargetValidationResult> {
  if (!existsSync(newRepoPath)) {
    return {
      ok: false,
      failure: { reason: 'not-found', message: `${newRepoPath} does not exist` },
    }
  }

  const gitCheck = await options.exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: newRepoPath })
  if (gitCheck.failed || gitCheck.stdout.trim() !== 'true') {
    return {
      ok: false,
      failure: {
        reason: 'not-a-repo',
        message: `${newRepoPath} is not a git repository — retargeting to it would leave the instrument watching nothing`,
      },
    }
  }

  const now = options.now ?? Date.now
  const decision = await decideSessionBoot(newSessionDir, now())
  if (decision.reason === 'writer-alive' && decision.liveWriter) {
    return {
      ok: false,
      failure: {
        reason: 'writer-alive',
        message:
          `another rhizomorph (pid ${decision.liveWriter.pid}) is already watching ${newRepoPath} ` +
          `— session ${decision.liveWriter.sessionId} — retargeting here would be the second instance prd-20 ruling 5 forbids`,
        pid: decision.liveWriter.pid,
        sessionId: decision.liveWriter.sessionId,
      },
    }
  }

  return { ok: true }
}
