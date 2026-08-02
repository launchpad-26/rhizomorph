import { execFile } from 'node:child_process'
import type { Exec, ExecResult } from '@rhizomorph/core'

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
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: exitCode,
            failed: true,
            // Per the `ExecResult.errorMessage` contract: set only when the binary itself
            // couldn't be run (ENOENT and friends), not for a real process that ran and
            // exited non-zero — callers (doctor, the workmux collector) use its presence
            // to tell "not installed" apart from "installed but erroring for a real reason".
            errorMessage: exitCode === null ? err.message : undefined,
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
