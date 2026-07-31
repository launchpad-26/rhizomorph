import type { CollisionPair } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import { elidePathMiddle, formatCheckedLine, formatPairEvidence, shortenBranch } from './format.js'

describe('elidePathMiddle', () => {
  it('returns short paths unchanged', () => {
    expect(elidePathMiddle('shared.ts')).toBe('shared.ts')
    expect(elidePathMiddle('docs/architecture.md')).toBe('docs/architecture.md')
  })

  it('elides the middle of a deep path, keeping the basename and nearby parents', () => {
    const path = 'packages/web/src/panels/collisions/index.tsx'
    expect(elidePathMiddle(path)).toBe('…/panels/collisions/index.tsx')
  })

  it('never cuts into the basename, even if it alone exceeds maxChars', () => {
    const path = 'a/b/this-basename-is-quite-long-on-its-own.ts'
    const result = elidePathMiddle(path, 20)
    expect(result.endsWith('this-basename-is-quite-long-on-its-own.ts')).toBe(true)
    expect(result.startsWith('…/')).toBe(true)
  })
})

describe('shortenBranch', () => {
  it('leaves plain branch names untouched', () => {
    expect(shortenBranch('main')).toBe('main')
    expect(shortenBranch('2-core')).toBe('2-core')
  })

  it('strips a refs/heads/ prefix', () => {
    expect(shortenBranch('refs/heads/21-collision-labels')).toBe('21-collision-labels')
  })

  it('keeps only the last segment of a namespaced branch', () => {
    expect(shortenBranch('feature/observatory/collision-labels')).toBe('collision-labels')
  })
})

describe('formatPairEvidence', () => {
  it('names the pair and its worst file — never a bare label (g4)', () => {
    const pair: CollisionPair = {
      branches: ['2-core', '3-git'],
      files: ['packages/core/src/index.ts'],
    }
    expect(formatPairEvidence(pair)).toBe(
      'collision: 2-core × 3-git — packages/core/src/index.ts',
    )
  })

  it('counts the rest when a pair contends over more than one file', () => {
    const pair: CollisionPair = {
      branches: ['2-core', '3-git'],
      files: ['a.ts', 'b.ts', 'c.ts'],
    }
    expect(formatPairEvidence(pair)).toBe('collision: 2-core × 3-git — a.ts (+2 more)')
  })

  it('shortens namespaced branch names the same way the columns do', () => {
    const pair: CollisionPair = {
      branches: ['refs/heads/2-core', 'feature/observatory/collision-labels'],
      files: ['shared.ts'],
    }
    expect(formatPairEvidence(pair)).toBe('collision: 2-core × collision-labels — shared.ts')
  })
})

describe('formatCheckedLine', () => {
  it('never a bare reassurance — carries the branch and file counts checked', () => {
    expect(
      formatCheckedLine({
        '2-core': [{ branch: '2-core', path: 'a.ts', dirty: true, committed: false }],
        '3-git': [
          { branch: '3-git', path: 'a.ts', dirty: false, committed: true },
          { branch: '3-git', path: 'b.ts', dirty: true, committed: false },
        ],
      }),
    ).toBe('collisions: 0 — checked 2 branches / 2 files')
  })

  it('is honest about a session with nothing touched yet', () => {
    expect(formatCheckedLine({})).toBe('collisions: 0 — checked 0 branches / 0 files')
  })

  it('singularises branch and file when there is exactly one', () => {
    expect(
      formatCheckedLine({
        main: [{ branch: 'main', path: 'a.ts', dirty: true, committed: false }],
      }),
    ).toBe('collisions: 0 — checked 1 branch / 1 file')
  })
})
