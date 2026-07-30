import { execFile } from 'node:child_process'
import type { Exec, ExecResult } from '@observatory/core'

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
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: typeof err.code === 'number' ? err.code : null,
            failed: true,
            errorMessage: err.message,
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
