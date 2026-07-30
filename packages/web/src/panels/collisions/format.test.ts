import { describe, expect, it } from 'vitest'
import { elidePathMiddle, shortenBranch } from './format.js'

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
