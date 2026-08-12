import { execFile } from 'node:child_process'
import type { Exec, ExecOptions, ExecResult } from '@rhizomorph/core'

/**
 * The real `Exec` implementation handed to collectors via `CollectorContext`
 * — argv form only, never a shell string. Collector unit tests supply their
 * own fixture-backed `Exec`; this one is for the actual running server.
 */
export const exec: Exec = (command, args, options = {}) =>
  new Promise<ExecResult>((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        env: options.env ? { ...process.env, ...options.env } : undefined,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { code?: number | string }
          const exitCode = typeof err.code === 'number' ? err.code : null
          // A spawn error (ENOENT and friends) reports `err.code` as a *string*
          // ('ENOENT'); a timeout kill reports `code: null` with `signal: 'SIGTERM'`
          // and no string code at all — the same `null` exitCode as a spawn error,
          // but a running process that was killed, not one that never ran.
          const isSpawnError = typeof err.code === 'string'
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: exitCode,
            failed: true,
            // Per the `ExecResult.errorMessage` contract: set only when the binary itself
            // couldn't be run (ENOENT and friends), not for a real process that ran and
            // exited non-zero or was killed on timeout — callers (doctor, the workmux
            // collector) use its presence to tell "not installed" apart from "installed
            // but erroring for a real reason".
            errorMessage: isSpawnError ? err.message : undefined,
          })
          return
        }
        resolve({ stdout, stderr, code: 0, failed: false })
      },
    )

    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })

/** Wraps an `Exec` so every call it makes carries `timeoutMs`, overriding any caller value. */
export function withTimeout(exec: Exec, timeoutMs: number): Exec {
  return (command: string, args: readonly string[], options?: ExecOptions) =>
    exec(command, args, { ...options, timeoutMs })
}

/**
 * Best available one-line reason an exec'd call failed: the spawn error if
 * the binary could not be run at all, else real stderr, else the exit
 * status.
 *
 * The last arm is load-bearing, not decoration. `errorMessage` is set only
 * for a spawn error (#306 narrowed it there, so a hung binary stops reading
 * as an uninstalled one), and a call killed on the exec timeout has no
 * stderr either — so a two-arm `errorMessage ?? stderr` reads as the empty
 * string for exactly the failure a `withTimeout`-bounded exec is guaranteed
 * to eventually produce. This lives here, beside the contract that creates
 * the third case, because the blank-detail bug appeared once per unshared
 * copy: first in the git collector (fixed on #306), then in all three judge
 * readers (found on #425's review).
 */
export function describeExecFailure(result: ExecResult): string {
  if (result.errorMessage !== undefined) return result.errorMessage
  const stderr = result.stderr.trim()
  if (stderr.length > 0) return stderr
  return result.code === null ? 'killed with no exit code — the exec timeout' : `exited with code ${String(result.code)}`
}
