import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { countLines, hashPaneContent, lastNonEmptyLine } from './capture.js'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

describe('hashPaneContent', () => {
  it('is deterministic for identical content', () => {
    const content = fixture('capture-pane.before.real.txt')
    expect(hashPaneContent(content)).toBe(hashPaneContent(content))
  })

  it('differs for two real captures of the same pane taken moments apart', () => {
    const before = fixture('capture-pane.before.real.txt')
    const after = fixture('capture-pane.after.real.txt')
    expect(hashPaneContent(before)).not.toBe(hashPaneContent(after))
  })
})

describe('countLines', () => {
  it('counts zero for empty content', () => {
    expect(countLines('')).toBe(0)
  })

  it('counts lines in a real capture', () => {
    const content = fixture('capture-pane.before.real.txt')
    expect(countLines(content)).toBe(content.split('\n').length)
  })
})

describe('lastNonEmptyLine', () => {
  it('returns undefined for blank content', () => {
    expect(lastNonEmptyLine('\n\n   \n')).toBeUndefined()
  })

  it('finds the last non-blank line, trimmed', () => {
    expect(lastNonEmptyLine('first\nsecond  \n\n\n')).toBe('second')
  })

  it('finds a trailing line in a real capture', () => {
    const content = fixture('capture-pane.before.real.txt')
    expect(lastNonEmptyLine(content)).toBeDefined()
  })
})
