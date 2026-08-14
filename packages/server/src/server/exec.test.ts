import type { Exec, ExecOptions, ExecResult } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { describeExecFailure, exec, withTimeout } from './exec.js'

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

describe('describeExecFailure', () => {
  const failure = (overrides: Partial<ExecResult>): ExecResult => ({
    stdout: '',
    stderr: '',
    code: 1,
    failed: true,
    ...overrides,
  })

  it('prefers the spawn error — "not installed" beats everything else', () => {
    expect(describeExecFailure(failure({ errorMessage: 'spawn git ENOENT', stderr: 'noise', code: null }))).toBe(
      'spawn git ENOENT',
    )
  })

  it('quotes real stderr when the binary ran', () => {
    expect(describeExecFailure(failure({ stderr: 'fatal: not a git repository\n' }))).toBe(
      'fatal: not a git repository',
    )
  })

  it('names the exec timeout when there is nothing to quote — the arm a two-arm ?? chain renders as ""', () => {
    // The exact shape a `withTimeout`-bounded exec produces for a kill:
    // no errorMessage (#306 narrowed that to spawn errors), no stderr,
    // `code: null`. `errorMessage ?? stderr` reads as '' here, which is the
    // blank-detail bug this helper exists to end (git collector on #306,
    // the three judge readers on #425's review).
    expect(describeExecFailure(failure({ code: null }))).toBe('killed with no exit code — the exec timeout')
  })

  it('whitespace-only stderr does not count as a reason', () => {
    expect(describeExecFailure(failure({ stderr: '  \n', code: null }))).toBe(
      'killed with no exit code — the exec timeout',
    )
  })

  it('falls back to the exit status for a silent nonzero exit', () => {
    expect(describeExecFailure(failure({ code: 128 }))).toBe('exited with code 128')
  })
})
