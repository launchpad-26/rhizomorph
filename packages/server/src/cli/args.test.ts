import { describe, expect, it } from 'vitest'
import { RESUME_WINDOW_MS } from '../log/session-log.js'
import { helpText, parseArgs } from './args.js'

const defaults = {
  path: undefined,
  port: 4321,
  flatlineMinutes: 5,
  pollIntervalMs: 2000,
  extraSessionDirs: [],
  fresh: false,
  resumeWindowMs: RESUME_WINDOW_MS,
  backfill: false,
  help: false,
  version: false,
}

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

  it('names the offending flag in the error (the CLI boundary adds the usage table)', () => {
    try {
      parseArgs(['--prot', '4400'])
      expect.unreachable('parseArgs should have thrown')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('--prot')
      expect(message).not.toContain(helpText())
    }
  })

  it('parses --version', () => {
    expect(parseArgs(['--version'])).toEqual({ ...defaults, version: true })
  })

  it('short-circuits to version even when other args are otherwise invalid', () => {
    expect(() => parseArgs(['--port', 'nope', '--version'])).not.toThrow()
    expect(parseArgs(['--port', 'nope', '--version']).version).toBe(true)
  })

  it('prefers --help over --version when both are passed', () => {
    expect(parseArgs(['--version', '--help'])).toEqual({ ...defaults, help: true })
  })

  it('treats "--" as the end of flags, so a later "--foo" is a positional, not a flag', () => {
    expect(parseArgs(['--', '--foo'])).toEqual({ ...defaults, path: '--foo' })
  })

  it('still rejects unknown flags that appear before "--"', () => {
    expect(() => parseArgs(['--foo', '--', 'some-path'])).toThrow(/unknown option.*"--foo"/is)
  })

  it('defaults --extra-sessions to an empty list', () => {
    expect(parseArgs([]).extraSessionDirs).toEqual([])
  })

  it('parses a single --extra-sessions', () => {
    expect(parseArgs(['--extra-sessions', '/mnt/c/Users/operator/.claude/projects/foo']).extraSessionDirs).toEqual([
      '/mnt/c/Users/operator/.claude/projects/foo',
    ])
  })

  it('accumulates repeated --extra-sessions flags in order', () => {
    expect(
      parseArgs(['--extra-sessions', '/one', '--extra-sessions', '/two']).extraSessionDirs,
    ).toEqual(['/one', '/two'])
  })

  it('parses --extra-sessions=<dir>', () => {
    expect(parseArgs(['--extra-sessions=/one']).extraSessionDirs).toEqual(['/one'])
  })

  it('passes a <dir>:<lane> value through untouched, for the sessionlog collector to split', () => {
    expect(
      parseArgs(['--extra-sessions', '/mnt/c/Users/operator/.claude/projects/foo:conductor']).extraSessionDirs,
    ).toEqual(['/mnt/c/Users/operator/.claude/projects/foo:conductor'])
  })

  it('accumulates a mix of plain and <dir>:<lane> --extra-sessions values in order', () => {
    expect(
      parseArgs(['--extra-sessions', '/one:conductor', '--extra-sessions', '/two']).extraSessionDirs,
    ).toEqual(['/one:conductor', '/two'])
  })

  it('throws on a missing --extra-sessions value', () => {
    expect(() => parseArgs(['--extra-sessions'])).toThrow(/invalid --extra-sessions/)
  })

  it('throws on an empty --extra-sessions value', () => {
    expect(() => parseArgs(['--extra-sessions=  '])).toThrow(/invalid --extra-sessions/)
  })

  it('defaults to resuming: --fresh and --backfill are both off', () => {
    expect(parseArgs([])).toEqual({ ...defaults, fresh: false, backfill: false })
  })

  it('parses --fresh as a switch', () => {
    expect(parseArgs(['--fresh'])).toEqual({ ...defaults, fresh: true })
  })

  it('parses --backfill as a switch', () => {
    expect(parseArgs(['--backfill'])).toEqual({ ...defaults, backfill: true })
  })

  it('parses --fresh and --backfill together', () => {
    expect(parseArgs(['--fresh', '--backfill'])).toEqual({ ...defaults, fresh: true, backfill: true })
  })

  it('defaults --resume-window to RESUME_WINDOW_MS', () => {
    expect(parseArgs([]).resumeWindowMs).toBe(RESUME_WINDOW_MS)
  })

  it('parses --resume-window as a ms value', () => {
    expect(parseArgs(['--resume-window', '1000'])).toEqual({ ...defaults, resumeWindowMs: 1000 })
    expect(parseArgs(['--resume-window=60000'])).toEqual({ ...defaults, resumeWindowMs: 60000 })
  })

  it('allows --resume-window 0 — the law that makes it act exactly like --fresh lives in decideSessionBoot', () => {
    expect(parseArgs(['--resume-window', '0'])).toEqual({ ...defaults, resumeWindowMs: 0 })
  })

  it('rejects a negative or non-numeric --resume-window', () => {
    expect(() => parseArgs(['--resume-window', '-1'])).toThrow(/invalid --resume-window/)
    expect(() => parseArgs(['--resume-window', 'soon'])).toThrow(/invalid --resume-window/)
  })

  it('does not swallow the token after a switch, so the path still parses', () => {
    expect(parseArgs(['--fresh', '../some-repo'])).toEqual({ ...defaults, path: '../some-repo', fresh: true })
    expect(parseArgs(['--backfill', '--port', '5000', '../repo'])).toEqual({
      ...defaults,
      path: '../repo',
      port: 5000,
      backfill: true,
    })
  })

  it('rejects a value on a switch instead of guessing what it meant', () => {
    expect(() => parseArgs(['--fresh=true'])).toThrow(/"--fresh" takes no value/)
    expect(() => parseArgs(['--backfill=1'])).toThrow(/"--backfill" takes no value/)
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
    expect(text).toContain('--extra-sessions')
    expect(text).toContain('[:<lane>]')
    expect(text).toContain('--fresh')
    expect(text).toContain('--backfill')
    expect(text).toContain('--version')
    expect(text).toContain('--help')
  })

  it('says a boot continues the recent session by default, and names the window in hours', () => {
    expect(helpText()).toMatch(/continues the most recent session/i)
    expect(helpText()).toContain('4h')
  })

  it('mentions the env subcommand', () => {
    expect(helpText()).toContain('rhizomorph env')
  })

  it('mentions the rotate subcommand — the operator\'s session boundary is discoverable', () => {
    expect(helpText()).toContain('rhizomorph rotate')
    expect(helpText()).toContain("'rhizomorph rotate --help'")
  })

  it('mentions the doctor subcommand', () => {
    expect(helpText()).toContain('rhizomorph doctor')
  })
})


