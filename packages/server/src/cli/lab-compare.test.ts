import { describe, expect, it } from 'vitest'
import { labCompareHelpText, parseLabCompareArgs } from './lab-compare.js'

describe('parseLabCompareArgs', () => {
  const compareDefaults = {
    forkId: 'fork-1',
    verify: 'npm test',
    skipVerify: false,
    path: undefined,
    help: false,
  }

  it('defaults the gate command to npm test', () => {
    expect(parseLabCompareArgs(['fork-1'])).toEqual(compareDefaults)
  })

  it('parses --verify and --path', () => {
    expect(parseLabCompareArgs(['fork-1', '--verify', 'npm run gate', '--path', '../repo'])).toEqual({
      ...compareDefaults,
      verify: 'npm run gate',
      path: '../repo',
    })
  })

  it('parses --no-verify as a valueless switch', () => {
    expect(parseLabCompareArgs(['fork-1', '--no-verify'])).toEqual({ ...compareDefaults, skipVerify: true })
  })

  it('refuses --verify and --no-verify together rather than silently preferring one', () => {
    expect(() => parseLabCompareArgs(['fork-1', '--verify', 'x', '--no-verify'])).toThrow(/contradict/)
  })

  it('throws on an empty --verify value', () => {
    expect(() => parseLabCompareArgs(['fork-1', '--verify', ''])).toThrow(/invalid --verify/)
  })

  it('throws when the fork id is missing, and on an unrecognised flag', () => {
    expect(() => parseLabCompareArgs([])).toThrow(/missing required argument.*<fork-id>/is)
    expect(() => parseLabCompareArgs(['fork-1', '--nope'])).toThrow(/unknown option.*"--nope"/is)
  })

  it('parses --help without requiring a fork id', () => {
    expect(parseLabCompareArgs(['--help']).help).toBe(true)
    expect(parseLabCompareArgs(['-h']).help).toBe(true)
  })
})

describe('labCompareHelpText', () => {
  it('labCompareHelpText says plainly that it will not rank below three arms', () => {
    const text = labCompareHelpText()
    expect(text).toContain('rhizomorph lab compare <fork-id>')
    expect(text).toContain('--verify')
    expect(text).toContain('--no-verify')
    expect(text).toContain('never a winner')
    expect(text).toContain('three')
  })
})
