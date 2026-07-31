import { describe, expect, it } from 'vitest'
import { doctorHelpText, envHelpText, helpText, parseArgs, parseDoctorArgs, parseEnvArgs } from './args.js'

const defaults = {
  path: undefined,
  port: 4321,
  flatlineMinutes: 5,
  pollIntervalMs: 2000,
  extraSessionDirs: [],
  help: false,
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

  it('rejects --version instead of booting the server', () => {
    expect(() => parseArgs(['--version'])).toThrow(/unknown option.*"--version"/is)
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
    expect(text).toContain('--help')
  })

  it('mentions the env subcommand', () => {
    expect(helpText()).toContain('observatory env')
  })

  it('mentions the doctor subcommand', () => {
    expect(helpText()).toContain('observatory doctor')
  })
})

describe('parseDoctorArgs', () => {
  const doctorDefaults = { path: undefined, port: 4321, help: false }

  it('defaults to no path and port 4321', () => {
    expect(parseDoctorArgs([])).toEqual(doctorDefaults)
  })

  it('takes the first non-flag token as the path', () => {
    expect(parseDoctorArgs(['../some-repo'])).toEqual({ ...doctorDefaults, path: '../some-repo' })
  })

  it('parses --port as a separate token', () => {
    expect(parseDoctorArgs(['../repo', '--port', '5000'])).toEqual({
      ...doctorDefaults,
      path: '../repo',
      port: 5000,
    })
  })

  it('parses --port=n', () => {
    expect(parseDoctorArgs(['--port=5000'])).toEqual({ ...doctorDefaults, port: 5000 })
  })

  it('throws on a non-numeric port', () => {
    expect(() => parseDoctorArgs(['--port', 'nope'])).toThrow(/invalid --port/)
  })

  it('parses --help', () => {
    expect(parseDoctorArgs(['--help'])).toEqual({ ...doctorDefaults, help: true })
  })

  it('parses -h', () => {
    expect(parseDoctorArgs(['-h'])).toEqual({ ...doctorDefaults, help: true })
  })

  it('throws on an unrecognised flag, naming it', () => {
    expect(() => parseDoctorArgs(['--flatline-minutes', '3'])).toThrow(
      /unknown option.*"--flatline-minutes"/is,
    )
  })
})

describe('doctorHelpText', () => {
  it('documents the path argument, --port and --help', () => {
    const text = doctorHelpText()
    expect(text).toContain('observatory doctor [path]')
    expect(text).toContain('--port')
    expect(text).toContain('4321')
    expect(text).toContain('--help')
  })
})

describe('parseEnvArgs', () => {
  const envDefaults = { lane: 'my-lane', role: 'worker', port: 4321, help: false }

  it('defaults role to worker and port to 4321', () => {
    expect(parseEnvArgs(['my-lane'])).toEqual(envDefaults)
  })

  it('takes the lane as the first positional', () => {
    expect(parseEnvArgs(['conductor'])).toEqual({ ...envDefaults, lane: 'conductor' })
  })

  it('parses --role', () => {
    expect(parseEnvArgs(['my-lane', '--role', 'conductor'])).toEqual({ ...envDefaults, role: 'conductor' })
  })

  it('parses --role=auxiliary', () => {
    expect(parseEnvArgs(['my-lane', '--role=auxiliary'])).toEqual({ ...envDefaults, role: 'auxiliary' })
  })

  it('parses --port', () => {
    expect(parseEnvArgs(['my-lane', '--port', '5000'])).toEqual({ ...envDefaults, port: 5000 })
  })

  it('throws when the lane is missing', () => {
    expect(() => parseEnvArgs([])).toThrow(/missing required argument.*<lane>/is)
  })

  it('throws on an invalid --role', () => {
    expect(() => parseEnvArgs(['my-lane', '--role', 'manager'])).toThrow(/invalid --role/)
  })

  it('throws on a non-numeric --port', () => {
    expect(() => parseEnvArgs(['my-lane', '--port', 'nope'])).toThrow(/invalid --port/)
  })

  it('throws on an unknown flag, naming it', () => {
    expect(() => parseEnvArgs(['my-lane', '--foo'])).toThrow(/unknown option.*"--foo"/is)
  })

  it('parses --help without requiring a lane', () => {
    expect(parseEnvArgs(['--help']).help).toBe(true)
    expect(parseEnvArgs(['-h']).help).toBe(true)
  })
})

describe('envHelpText', () => {
  it('documents the lane argument, --role, --port and --help', () => {
    const text = envHelpText()
    expect(text).toContain('observatory env <lane>')
    expect(text).toContain('--role')
    expect(text).toContain('worker')
    expect(text).toContain('conductor')
    expect(text).toContain('auxiliary')
    expect(text).toContain('--port')
    expect(text).toContain('4321')
    expect(text).toContain('--help')
  })
})
