import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exec as realExec } from '../server/exec.js'
import { parseMergeTreeOutput, speculativeMergeTree } from './mergetree.js'

describe('parseMergeTreeOutput', () => {
  it('finds no conflicting files in a clean-merge tree-oid-only output', () => {
    expect(parseMergeTreeOutput('e25f1ee1cd91ad381d8412b0349059ba5d282d54\0').conflictingFiles).toEqual([])
  })

  it('collects the distinct conflicted paths from the -z conflict-info section', () => {
    const stdout =
      'e25f1ee1cd91ad381d8412b0349059ba5d282d54\0' +
      '100644 6c22836ad8e0e090bf304446e410b71bf05b48b8 1\ta.ts\0' +
      '100644 e63d4d51e27733787be626f9f3c05337c6edeb50 2\ta.ts\0' +
      '100644 d9dc8fc463f4756b7ef8a558a23950f1718addf4 3\ta.ts\0' +
      '\0' +
      '1\0a.ts\0Auto-merging\0Auto-merging a.ts\n\0' +
      '1\0a.ts\0CONFLICT (contents)\0CONFLICT (content): Merge conflict in a.ts\n\0'
    expect(parseMergeTreeOutput(stdout).conflictingFiles).toEqual(['a.ts'])
  })

  it('dedupes multiple conflicted files across stages', () => {
    const stdout =
      'oid\0' +
      '100644 aaa 1\tx.ts\0' +
      '100644 bbb 2\tx.ts\0' +
      '100644 ccc 1\ty.ts\0' +
      '100644 ddd 3\ty.ts\0' +
      '\0'
    expect(parseMergeTreeOutput(stdout).conflictingFiles).toEqual(['x.ts', 'y.ts'])
  })
})

/**
 * Hermetic real-git-repo tests — the #148 lesson: a fresh `mkdtemp` per test,
 * never a shared fixture path, so this survives 4x concurrent runs.
 */
describe('speculativeMergeTree (real git)', () => {
  let repoDir: string

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
  }

  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-judge-mergetree-test-'))
    repoDir = path.join(root, 'repo')
    await mkdir(repoDir, { recursive: true })
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    await writeFile(path.join(repoDir, 'shared.ts'), 'line one\nline two\n')
    git(['add', 'shared.ts'])
    git(['commit', '-q', '-m', 'base'])
  })

  afterEach(async () => {
    await rm(path.dirname(repoDir), { recursive: true, force: true })
  })

  it('reports clean when two lanes touch different files', async () => {
    git(['switch', '-q', '-c', 'lane-a'])
    await writeFile(path.join(repoDir, 'a.ts'), 'export const a = 1\n')
    git(['add', 'a.ts'])
    git(['commit', '-q', '-m', 'lane-a adds a.ts'])

    git(['switch', '-q', 'main'])
    git(['switch', '-q', '-c', 'lane-b'])
    await writeFile(path.join(repoDir, 'b.ts'), 'export const b = 1\n')
    git(['add', 'b.ts'])
    git(['commit', '-q', '-m', 'lane-b adds b.ts'])

    const result = await speculativeMergeTree({ exec: realExec, repoPath: repoDir, branchA: 'lane-a', branchB: 'lane-b' })
    expect(result).toEqual({ clean: true, conflictingFiles: [] })
  })

  it('reports the conflicting file when two lanes edit the same line', async () => {
    git(['switch', '-q', '-c', 'lane-a'])
    await writeFile(path.join(repoDir, 'shared.ts'), 'line one CHANGED BY A\nline two\n')
    git(['add', 'shared.ts'])
    git(['commit', '-q', '-m', 'lane-a edits shared.ts'])

    git(['switch', '-q', 'main'])
    git(['switch', '-q', '-c', 'lane-b'])
    await writeFile(path.join(repoDir, 'shared.ts'), 'line one CHANGED BY B\nline two\n')
    git(['add', 'shared.ts'])
    git(['commit', '-q', '-m', 'lane-b edits shared.ts'])

    const result = await speculativeMergeTree({ exec: realExec, repoPath: repoDir, branchA: 'lane-a', branchB: 'lane-b' })
    expect(result).toEqual({ clean: false, conflictingFiles: ['shared.ts'] })
  })

  it('touches no ref, index, HEAD or working tree — the read-only law', async () => {
    git(['switch', '-q', '-c', 'lane-a'])
    await writeFile(path.join(repoDir, 'shared.ts'), 'line one CHANGED BY A\nline two\n')
    git(['add', 'shared.ts'])
    git(['commit', '-q', '-m', 'lane-a edits shared.ts'])

    git(['switch', '-q', 'main'])
    git(['switch', '-q', '-c', 'lane-b'])
    await writeFile(path.join(repoDir, 'shared.ts'), 'line one CHANGED BY B\nline two\n')
    git(['add', 'shared.ts'])
    git(['commit', '-q', '-m', 'lane-b edits shared.ts'])

    const headBefore = git(['rev-parse', 'HEAD']).trim()
    const refsBefore = git(['for-each-ref']).trim()
    const statusBefore = git(['status', '--porcelain']).trim()

    await speculativeMergeTree({ exec: realExec, repoPath: repoDir, branchA: 'lane-a', branchB: 'lane-b' })

    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    expect(git(['for-each-ref']).trim()).toBe(refsBefore)
    expect(git(['status', '--porcelain']).trim()).toBe(statusBefore)
  })

  it('throws on an unknown branch rather than silently reporting clean', async () => {
    git(['switch', '-q', '-c', 'lane-a'])
    await expect(
      speculativeMergeTree({ exec: realExec, repoPath: repoDir, branchA: 'lane-a', branchB: 'nonexistent-branch' }),
    ).rejects.toThrow(/git merge-tree failed/)
  })
})
