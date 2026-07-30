import { describe, expect, it } from 'vitest'
import { helpText, parseArgs } from './args.js'

const defaults = { path: undefined, port: 4321, flatlineMinutes: 5, pollIntervalMs: 2000, help: false }

describe('parseArgs', () => {
  it('defaults to no path, port 4321, 5 flatline minutes, and a 2000ms poll interval', () => {
    expect(parseArgs([])).toEqual(defaults)
  })

  it('takes the first non-flag token as the path', () => {
    expect(parseArgs(['../some-repo'])).toEqual({ ...defaults, path: '../some-repo' })
  })

  it('parses --port as a separate token', () => {
    expect(parseArgs(['../repo', '--port', '5000'])).toEqual({ ...defaults, path: '../repo', port: 5000 })
  })

  it('parses --port=n', () => {
    expect(parseArgs(['--port=5000', '../repo'])).toEqual({ ...defaults, path: '../repo', port: 5000 })
  })

  it('throws on a non-numeric port', () => {
    expect(() => parseArgs(['--port', 'nope'])).toThrow(/invalid --port/)
  })

  it('accepts port 0 (let the OS pick a free port)', () => {
    expect(parseArgs(['--port', '0'])).toEqual({ ...defaults, port: 0 })
  })

  it('throws on a negative port', () => {
    expect(() => parseArgs(['--port', '-1'])).toThrow(/invalid --port/)
  })

  it('parses --flatline-minutes as a separate token', () => {
    expect(parseArgs(['--flatline-minutes', '10'])).toEqual({ ...defaults, flatlineMinutes: 10 })
  })

  it('parses --flatline-minutes=n', () => {
    expect(parseArgs(['--flatline-minutes=2.5'])).toEqual({ ...defaults, flatlineMinutes: 2.5 })
  })

  it('throws on a non-numeric --flatline-minutes', () => {
    expect(() => parseArgs(['--flatline-minutes', 'soon'])).toThrow(/invalid --flatline-minutes/)
  })

  it('throws on a zero --flatline-minutes', () => {
    expect(() => parseArgs(['--flatline-minutes', '0'])).toThrow(/invalid --flatline-minutes/)
  })

  it('throws on a negative --flatline-minutes', () => {
    expect(() => parseArgs(['--flatline-minutes', '-3'])).toThrow(/invalid --flatline-minutes/)
  })

  it('parses --poll-interval as a separate token', () => {
    expect(parseArgs(['--poll-interval', '5000'])).toEqual({ ...defaults, pollIntervalMs: 5000 })
  })

  it('parses --poll-interval=ms', () => {
    expect(parseArgs(['--poll-interval=500'])).toEqual({ ...defaults, pollIntervalMs: 500 })
  })

  it('accepts --poll-interval at the 250ms floor', () => {
    expect(parseArgs(['--poll-interval', '250'])).toEqual({ ...defaults, pollIntervalMs: 250 })
  })

  it('throws on a non-numeric --poll-interval', () => {
    expect(() => parseArgs(['--poll-interval', 'fast'])).toThrow(/invalid --poll-interval/)
  })

  it('throws on a --poll-interval below the 250ms floor', () => {
    expect(() => parseArgs(['--poll-interval', '249'])).toThrow(/invalid --poll-interval/)
  })

  it('throws on a negative --poll-interval', () => {
    expect(() => parseArgs(['--poll-interval', '-100'])).toThrow(/invalid --poll-interval/)
  })

  it('parses --help', () => {
    expect(parseArgs(['--help'])).toEqual({ ...defaults, help: true })
  })

  it('parses -h', () => {
    expect(parseArgs(['-h'])).toEqual({ ...defaults, help: true })
  })

  it('short-circuits to help even when other args are otherwise invalid', () => {
    expect(() => parseArgs(['--port', 'nope', '--help'])).not.toThrow()
    expect(parseArgs(['--port', 'nope', '--help']).help).toBe(true)
  })

  it('throws on an unrecognised flag, naming it and printing usage', () => {
    expect(() => parseArgs(['--flatline-minute', '3'])).toThrow(/unknown option.*"--flatline-minute"/is)
  })

  it('throws on an unrecognised flag with an "=" value', () => {
    expect(() => parseArgs(['--prot=4400'])).toThrow(/unknown option.*"--prot"/is)
  })

  it('names the offending flag and includes the usage table in the error', () => {
    try {
      parseArgs(['--prot', '4400'])
      expect.unreachable('parseArgs should have thrown')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('--prot')
      expect(message).toContain(helpText())
    }
  })

  it('rejects --version instead of booting the server', () => {
    expect(() => parseArgs(['--version'])).toThrow(/unknown option.*"--version"/is)
  })

  it('treats "--" as the end of flags, so a later "--foo" is a positional, not a flag', () => {
    expect(parseArgs(['--', '--foo'])).toEqual({ ...defaults, path: '--foo' })
  })

  it('still rejects unknown flags that appear before "--"', () => {
    expect(() => parseArgs(['--foo', '--', 'some-path'])).toThrow(/unknown option.*"--foo"/is)
  })
})

describe('helpText', () => {
  it('documents every flag with its default', () => {
    const text = helpText()
    expect(text).toContain('--port')
    expect(text).toContain('4321')
    expect(text).toContain('--flatline-minutes')
    expect(text).toContain('--poll-interval')
    expect(text).toContain('2000')
    expect(text).toContain('250')
    expect(text).toContain('--help')
  })
})
