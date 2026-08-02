import type { Exec, ExecResult } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { resolveWorktreePath } from './worktree.js'

function fakeExec(result: ExecResult): Exec {
  return async () => result
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0, failed: false })
const fail = (): ExecResult => ({
  stdout: '',
  stderr: 'fatal: not a git repository',
  code: 128,
  failed: true,
})

describe('resolveWorktreePath', () => {
  it('returns the trimmed toplevel path on success', async () => {
    const exec = fakeExec(ok('/home/operator/worktrees-challenge__worktrees/2-core\n'))
    await expect(resolveWorktreePath('/some/pane/cwd', exec)).resolves.toBe(
      '/home/operator/worktrees-challenge__worktrees/2-core',
    )
  })

  it('returns null when the path is not inside a git repo', async () => {
    const exec = fakeExec(fail())
    await expect(resolveWorktreePath('/tmp', exec)).resolves.toBeNull()
  })

  it('returns null on blank stdout', async () => {
    const exec = fakeExec(ok('\n'))
    await expect(resolveWorktreePath('/tmp', exec)).resolves.toBeNull()
  })

  it('passes the pane path as -C to git rev-parse', async () => {
    let seenArgs: readonly string[] = []
    const exec: Exec = async (command, args) => {
      seenArgs = args
      return ok('/repo\n')
    }
    await resolveWorktreePath('/some/pane/cwd', exec)
    expect(seenArgs).toEqual(['-C', '/some/pane/cwd', 'rev-parse', '--show-toplevel'])
  })
})
