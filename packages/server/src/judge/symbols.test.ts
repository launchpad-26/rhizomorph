import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exec as realExec } from '../server/exec.js'
import { extractLaneSymbols, intersectSymbols, parseAddedDeclarations } from './symbols.js'

describe('parseAddedDeclarations', () => {
  it('extracts an exported function added in a TS file', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index abc..def 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -0,0 +1,3 @@
+export function formatDuration(ms: number) {
+  return ms
+}
`
    expect(parseAddedDeclarations(diff)).toEqual(['formatDuration'])
  })

  it('ignores non-TS/TSX files entirely', () => {
    const diff = `diff --git a/README.md b/README.md
index abc..def 100644
--- a/README.md
+++ b/README.md
@@ -0,0 +1,1 @@
+export function formatDuration() {}
`
    expect(parseAddedDeclarations(diff)).toEqual([])
  })

  it('ignores removed lines — only additions are facts about this lane', () => {
    const diff = `diff --git a/src/a.tsx b/src/a.tsx
index abc..def 100644
--- a/src/a.tsx
+++ b/src/a.tsx
@@ -1,2 +0,0 @@
-export function stale() {}
-export const gone = 1
`
    expect(parseAddedDeclarations(diff)).toEqual([])
  })

  it('collects const, class, type and interface declarations, deduped and sorted', () => {
    const diff = `diff --git a/src/b.tsx b/src/b.tsx
index abc..def 100644
--- a/src/b.tsx
+++ b/src/b.tsx
@@ -0,0 +1,6 @@
+export const shared = 1
+export class Thing {}
+export type Widget = { id: string }
+export interface Props { name: string }
+export const shared2 = 2
+function helper() {}
`
    expect(parseAddedDeclarations(diff)).toEqual(['Props', 'Thing', 'Widget', 'helper', 'shared', 'shared2'])
  })

  it('tracks the current file across multiple diff sections in one diff', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index abc..def 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -0,0 +1,1 @@
+export const fromA = 1
diff --git a/src/b.ts b/src/b.ts
index abc..def 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -0,0 +1,1 @@
+export const fromB = 2
`
    expect(parseAddedDeclarations(diff)).toEqual(['fromA', 'fromB'])
  })
})

describe('intersectSymbols', () => {
  it('returns the sorted overlap and nothing else', () => {
    expect(intersectSymbols(['b', 'a', 'c'], ['c', 'a', 'z'])).toEqual(['a', 'c'])
  })

  it('is empty when nothing overlaps', () => {
    expect(intersectSymbols(['a'], ['b'])).toEqual([])
  })
})

/**
 * Hermetic real-git-repo tests — the #148 lesson: a fresh `mkdtemp` per test,
 * never a shared fixture path, so this survives 4x concurrent runs.
 */
describe('extractLaneSymbols (real git)', () => {
  let repoDir: string

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
  }

  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-judge-symbols-test-'))
    repoDir = path.join(root, 'repo')
    await mkdir(repoDir, { recursive: true })
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    await writeFile(path.join(repoDir, 'base.ts'), 'export const base = 1\n')
    git(['add', 'base.ts'])
    git(['commit', '-q', '-m', 'base'])
  })

  afterEach(async () => {
    await rm(path.dirname(repoDir), { recursive: true, force: true })
  })

  it('extracts a symbol a lane adds in a new file', async () => {
    git(['switch', '-q', '-c', 'lane-a'])
    await writeFile(
      path.join(repoDir, 'a.ts'),
      'export function formatDuration(ms: number) {\n  return ms\n}\n',
    )
    git(['add', 'a.ts'])
    git(['commit', '-q', '-m', 'lane-a adds formatDuration'])

    const extracted = await extractLaneSymbols({
      exec: realExec,
      repoPath: repoDir,
      mainBranch: 'main',
      branch: 'lane-a',
    })
    expect(extracted).toEqual({ branch: 'lane-a', symbols: ['formatDuration'] })
  })

  it('the spike\'s headline case: two lanes independently adding the same symbol in different files intersect', async () => {
    git(['switch', '-q', '-c', 'lane-a'])
    await writeFile(
      path.join(repoDir, 'a.ts'),
      'export function formatDuration(ms: number) {\n  return ms\n}\n',
    )
    git(['add', 'a.ts'])
    git(['commit', '-q', '-m', 'lane-a adds formatDuration in a.ts'])

    git(['switch', '-q', 'main'])
    git(['switch', '-q', '-c', 'lane-b'])
    await writeFile(
      path.join(repoDir, 'b.ts'),
      'export function formatDuration(ms: number) {\n  return ms * 2\n}\n',
    )
    git(['add', 'b.ts'])
    git(['commit', '-q', '-m', 'lane-b adds formatDuration in b.ts'])

    const a = await extractLaneSymbols({ exec: realExec, repoPath: repoDir, mainBranch: 'main', branch: 'lane-a' })
    const b = await extractLaneSymbols({ exec: realExec, repoPath: repoDir, mainBranch: 'main', branch: 'lane-b' })

    expect(intersectSymbols(a.symbols, b.symbols)).toEqual(['formatDuration'])
  })

  it('reports no symbols for a lane that only touches non-TS files', async () => {
    git(['switch', '-q', '-c', 'lane-docs'])
    await writeFile(path.join(repoDir, 'README.md'), '# hello\n')
    git(['add', 'README.md'])
    git(['commit', '-q', '-m', 'docs only'])

    const extracted = await extractLaneSymbols({
      exec: realExec,
      repoPath: repoDir,
      mainBranch: 'main',
      branch: 'lane-docs',
    })
    expect(extracted.symbols).toEqual([])
  })

  it('throws on a git failure rather than silently reporting no symbols', async () => {
    await expect(
      extractLaneSymbols({ exec: realExec, repoPath: repoDir, mainBranch: 'main', branch: 'nonexistent-branch' }),
    ).rejects.toThrow(/git diff failed/)
  })
})
