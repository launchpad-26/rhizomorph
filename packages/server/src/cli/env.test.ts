import { describe, expect, it } from 'vitest'
import { envHelpText, parseEnvArgs } from './env.js'

describe('parseEnvArgs', () => {
  const envDefaults = { lane: 'my-lane', role: 'worker', port: 4321, shell: 'sh', help: false }

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

  it('defaults --shell to sh', () => {
    expect(parseEnvArgs(['my-lane'])).toEqual({ ...envDefaults, shell: 'sh' })
  })

  it('parses --shell powershell', () => {
    expect(parseEnvArgs(['my-lane', '--shell', 'powershell'])).toEqual({ ...envDefaults, shell: 'powershell' })
  })

  it('parses --shell=cmd', () => {
    expect(parseEnvArgs(['my-lane', '--shell=cmd'])).toEqual({ ...envDefaults, shell: 'cmd' })
  })

  it('throws on an invalid --shell', () => {
    expect(() => parseEnvArgs(['my-lane', '--shell', 'fish'])).toThrow(/invalid --shell/)
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
  it('documents the lane argument, --role, --port, --shell and --help', () => {
    const text = envHelpText()
    expect(text).toContain('rhizomorph env <lane>')
    expect(text).toContain('--role')
    expect(text).toContain('worker')
    expect(text).toContain('conductor')
    expect(text).toContain('auxiliary')
    expect(text).toContain('--port')
    expect(text).toContain('4321')
    expect(text).toContain('--shell')
    expect(text).toContain('powershell')
    expect(text).toContain('cmd')
    expect(text).toContain('--help')
  })
})
