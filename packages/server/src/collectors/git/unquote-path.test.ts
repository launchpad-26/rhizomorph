import { describe, expect, it } from 'vitest'
import { unquotePath } from './unquote-path.js'

describe('unquotePath', () => {
  it('passes an already-unquoted path through unchanged', () => {
    expect(unquotePath('src/index.js')).toBe('src/index.js')
    expect(unquotePath('old name.txt')).toBe('old name.txt')
  })

  it('strips quotes from a plain quoted path', () => {
    expect(unquotePath('"hello world.txt"')).toBe('hello world.txt')
  })

  it('decodes octal escapes as raw UTF-8 bytes', () => {
    expect(unquotePath('"caf\\303\\251.txt"')).toBe('café.txt')
    expect(unquotePath('"src/n\\303\\244me.js"')).toBe('src/näme.js')
  })

  it('decodes the named single-character escapes', () => {
    expect(unquotePath('"a\\tb\\nc\\"d\\\\e"')).toBe('a\tb\nc"d\\e')
  })

  it('returns a lone quote or an empty string unchanged', () => {
    expect(unquotePath('"')).toBe('"')
    expect(unquotePath('')).toBe('')
  })

  it('preserves the backslash on a trailing lone backslash or an unknown escape', () => {
    expect(unquotePath('"trailing\\"')).toBe('trailing\\')
    expect(unquotePath('"un\\qknown"')).toBe('un\\qknown')
  })
})
