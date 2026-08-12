import type { Exec, ExecOptions, ExecResult } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { exec, withTimeout } from './exec.js'

describe('exec', () => {
  it('resolves stdout for a successful command', async () => {
    const result = await exec('node', ['-e', 'process.stdout.write("hi")'])
    expect(result).toEqual({ stdout: 'hi', stderr: '', code: 0, failed: false })
  })

  it('reports failure with an exit code for a nonzero exit, and no errorMessage — the binary ran fine', async () => {
    const result = await exec('node', ['-e', 'process.exit(3)'])
    expect(result.failed).toBe(true)
    expect(result.code).toBe(3)
    expect(result.errorMessage).toBeUndefined()
  })

  it('reports failure with an error message for a missing binary', async () => {
    const result = await exec('rhizomorph-definitely-not-a-real-binary', [])
    expect(result.failed).toBe(true)
    expect(result.code).toBeNull()
    expect(result.errorMessage).toBeTruthy()
  })

  it('reports failure with no error message for a timeout kill — a hang is not a missing binary', async () => {
    const result = await exec('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 100 })
    expect(result.failed).toBe(true)
    expect(result.code).toBeNull()
    expect(result.errorMessage).toBeUndefined()
  })
})

describe('withTimeout', () => {
  const okResult: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }

  it('forwards a fixed timeoutMs while preserving the caller options', async () => {
    const seen: (ExecOptions | undefined)[] = []
    const spy: Exec = async (_command, _args, options) => {
      seen.push(options)
      return okResult
    }
    await withTimeout(spy, 1234)('git', ['status'], { cwd: '/tmp', input: 'x' })
    expect(seen[0]).toEqual({ cwd: '/tmp', input: 'x', timeoutMs: 1234 })
  })

  it('overrides a caller-supplied timeoutMs', async () => {
    const seen: (number | undefined)[] = []
    const spy: Exec = async (_command, _args, options) => {
      seen.push(options?.timeoutMs)
      return okResult
    }
    await withTimeout(spy, 1234)('git', ['status'], { timeoutMs: 5 })
    expect(seen[0]).toBe(1234)
  })
})
