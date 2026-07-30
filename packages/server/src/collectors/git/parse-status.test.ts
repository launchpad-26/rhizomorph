import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseStatusPorcelain } from './parse-status.js'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/status/${name}`, import.meta.url), 'utf8')
}

describe('parseStatusPorcelain', () => {
  it('parses a mix of modified, staged-added, staged-renamed and untracked files', () => {
    expect(parseStatusPorcelain(fixture('mixed.txt'))).toEqual([
      { path: 'src/index.js', status: 'modified', staged: false },
      { path: 'src/lib/extra.js', status: 'added', staged: true },
      { path: 'src/lib/utils.js', status: 'renamed', staged: true },
      { path: 'notes.tmp', status: 'untracked', staged: false },
    ])
  })

  it('parses a clean staged rename, collapsing to the new path', () => {
    expect(parseStatusPorcelain(fixture('clean-rename.txt'))).toEqual([
      { path: 'src/main.js', status: 'renamed', staged: true },
    ])
  })

  it('parses an unmerged conflict', () => {
    expect(parseStatusPorcelain(fixture('unmerged.txt'))).toEqual([
      { path: 'conflict.txt', status: 'unmerged', staged: true },
    ])
  })

  it('returns an empty array for a clean worktree', () => {
    expect(parseStatusPorcelain(fixture('clean.txt'))).toEqual([])
    expect(parseStatusPorcelain('')).toEqual([])
  })
})
