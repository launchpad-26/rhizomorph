import { describe, expect, it } from 'vitest'
import { RESUME_WINDOW_MS } from '../log/session-log.js'
import {
  doctorHelpText,
  envHelpText,
  exportRecordHelpText,
  helpText,
  labCheckpointHelpText,
  labCompareHelpText,
  labelHelpText,
  labForkHelpText,
  labHelpText,
  parseArgs,
  parseDoctorArgs,
  parseEnvArgs,
  parseExportRecordArgs,
  parseLabCheckpointArgs,
  parseLabCompareArgs,
  parseLabelArgs,
  parseLabForkArgs,
  parseReplayArgs,
  parseSessionsArgs,
  replayHelpText,
  sessionsHelpText,
} from './args.js'

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

  it('mentions the doctor subcommand', () => {
    expect(helpText()).toContain('rhizomorph doctor')
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
    expect(text).toContain('rhizomorph doctor [path]')
    expect(text).toContain('--port')
    expect(text).toContain('4321')
    expect(text).toContain('--help')
  })
})

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

describe('parseExportRecordArgs', () => {
  const exportDefaults = { path: undefined, sessionId: undefined, out: undefined, handle: undefined, help: false }

  it('defaults everything to undefined', () => {
    expect(parseExportRecordArgs([])).toEqual(exportDefaults)
  })

  it('takes the first non-flag token as the path', () => {
    expect(parseExportRecordArgs(['../some-repo'])).toEqual({ ...exportDefaults, path: '../some-repo' })
  })

  it('parses --session', () => {
    expect(parseExportRecordArgs(['--session', '123'])).toEqual({ ...exportDefaults, sessionId: '123' })
  })

  it('parses --out=<file>', () => {
    expect(parseExportRecordArgs(['--out=/tmp/x.rhizorecord.json'])).toEqual({
      ...exportDefaults,
      out: '/tmp/x.rhizorecord.json',
    })
  })

  it('parses --handle', () => {
    expect(parseExportRecordArgs(['--handle', 'alice'])).toEqual({ ...exportDefaults, handle: 'alice' })
  })

  it('throws on an empty --session value', () => {
    expect(() => parseExportRecordArgs(['--session', ''])).toThrow(/invalid --session/)
  })

  it('throws on an unknown flag, naming it', () => {
    expect(() => parseExportRecordArgs(['--foo'])).toThrow(/unknown option.*"--foo"/is)
  })

  it('parses --help without requiring anything else', () => {
    expect(parseExportRecordArgs(['--help']).help).toBe(true)
    expect(parseExportRecordArgs(['-h']).help).toBe(true)
  })
})

describe('exportRecordHelpText', () => {
  it('documents path, --session, --out, --handle and --help', () => {
    const text = exportRecordHelpText()
    expect(text).toContain('rhizomorph export-record')
    expect(text).toContain('--session')
    expect(text).toContain('--out')
    expect(text).toContain('--handle')
    expect(text).toContain('--help')
  })
})

describe('parseReplayArgs', () => {
  it('takes the first positional as the record file', () => {
    expect(parseReplayArgs(['./out.rhizorecord.json'])).toEqual({
      file: './out.rhizorecord.json',
      port: 4321,
      help: false,
    })
  })

  it('parses --port', () => {
    expect(parseReplayArgs(['./out.rhizorecord.json', '--port', '5000'])).toEqual({
      file: './out.rhizorecord.json',
      port: 5000,
      help: false,
    })
  })

  it('throws when the record file is missing', () => {
    expect(() => parseReplayArgs([])).toThrow(/missing required argument.*<record-file>/is)
  })

  it('throws on a non-numeric --port', () => {
    expect(() => parseReplayArgs(['./out.rhizorecord.json', '--port', 'nope'])).toThrow(/invalid --port/)
  })

  it('parses --help without requiring a file', () => {
    expect(parseReplayArgs(['--help']).help).toBe(true)
    expect(parseReplayArgs(['-h']).help).toBe(true)
  })
})

describe('replayHelpText', () => {
  it('documents the record-file argument, --port and --help', () => {
    const text = replayHelpText()
    expect(text).toContain('rhizomorph replay <record-file>')
    expect(text).toContain('--port')
    expect(text).toContain('--help')
  })
})

describe('parseSessionsArgs', () => {
  it('takes the first positional as the path, defaulting to undefined', () => {
    expect(parseSessionsArgs([])).toEqual({ path: undefined, help: false })
    expect(parseSessionsArgs(['../other-repo'])).toEqual({ path: '../other-repo', help: false })
  })

  it('parses --help without requiring a path', () => {
    expect(parseSessionsArgs(['--help']).help).toBe(true)
    expect(parseSessionsArgs(['-h']).help).toBe(true)
  })
})

describe('sessionsHelpText', () => {
  it('documents the path argument and --help', () => {
    const text = sessionsHelpText()
    expect(text).toContain('rhizomorph sessions [path]')
    expect(text).toContain('--help')
  })
})

describe('parseLabelArgs', () => {
  it('takes the first positional as the session id and the rest as the label', () => {
    expect(parseLabelArgs(['1000', 'a', 'label'])).toEqual({
      sessionId: '1000',
      label: 'a label',
      path: undefined,
      help: false,
    })
  })

  it('accepts a single quoted label argument', () => {
    expect(parseLabelArgs(['1000', 'the scene lands'])).toEqual({
      sessionId: '1000',
      label: 'the scene lands',
      path: undefined,
      help: false,
    })
  })

  it('parses --path', () => {
    expect(parseLabelArgs(['1000', 'a label', '--path', '../other-repo'])).toEqual({
      sessionId: '1000',
      label: 'a label',
      path: '../other-repo',
      help: false,
    })
  })

  it('throws when the session id is missing', () => {
    expect(() => parseLabelArgs([])).toThrow(/missing required argument.*<sessionId>/is)
  })

  it('throws when the label text is missing', () => {
    expect(() => parseLabelArgs(['1000'])).toThrow(/missing required argument.*<text>/is)
  })

  it('throws for a whitespace-only label', () => {
    expect(() => parseLabelArgs(['1000', '   '])).toThrow(/missing required argument.*<text>/is)
  })

  it('parses --help without requiring a session id or text', () => {
    expect(parseLabelArgs(['--help']).help).toBe(true)
    expect(parseLabelArgs(['-h']).help).toBe(true)
  })
})

describe('labelHelpText', () => {
  it('documents the sessionId/text arguments, --path and --help', () => {
    const text = labelHelpText()
    expect(text).toContain('rhizomorph label <sessionId>')
    expect(text).toContain('--path')
    expect(text).toContain('--help')
  })
})

describe('parseLabCheckpointArgs', () => {
  const labDefaults = { lane: 'my-lane', path: undefined, capturedBy: 'operator', help: false }

  it('takes the lane as the first positional, defaulting path and capturedBy', () => {
    expect(parseLabCheckpointArgs(['my-lane'])).toEqual(labDefaults)
  })

  it('parses --path', () => {
    expect(parseLabCheckpointArgs(['my-lane', '--path', '../some-repo'])).toEqual({
      ...labDefaults,
      path: '../some-repo',
    })
  })

  it('parses --captured-by', () => {
    expect(parseLabCheckpointArgs(['my-lane', '--captured-by', 'gate'])).toEqual({
      ...labDefaults,
      capturedBy: 'gate',
    })
    expect(parseLabCheckpointArgs(['my-lane', '--captured-by', 'dispatch'])).toEqual({
      ...labDefaults,
      capturedBy: 'dispatch',
    })
  })

  it('parses --captured-by=<value>', () => {
    expect(parseLabCheckpointArgs(['my-lane', '--captured-by=gate'])).toEqual({
      ...labDefaults,
      capturedBy: 'gate',
    })
  })

  it('throws on an invalid --captured-by', () => {
    expect(() => parseLabCheckpointArgs(['my-lane', '--captured-by', 'human'])).toThrow(/invalid --captured-by/)
  })

  it('throws when the lane is missing', () => {
    expect(() => parseLabCheckpointArgs([])).toThrow(/missing required argument.*<lane>/is)
  })

  it('throws on an unrecognised flag, naming it', () => {
    expect(() => parseLabCheckpointArgs(['my-lane', '--foo'])).toThrow(/unknown option.*"--foo"/is)
  })

  it('parses --help without requiring a lane', () => {
    expect(parseLabCheckpointArgs(['--help']).help).toBe(true)
    expect(parseLabCheckpointArgs(['-h']).help).toBe(true)
  })
})

describe('parseLabForkArgs', () => {
  const forkDefaults = {
    lane: 'my-lane',
    at: undefined,
    model: undefined,
    promptFile: undefined,
    arms: 3,
    path: undefined,
    launch: false,
    help: false,
  }

  it('defaults to three arms — prd12 ruling 4\'s floor — and no launch', () => {
    expect(parseLabForkArgs(['my-lane'])).toEqual(forkDefaults)
  })

  it('parses --at, --model, --prompt-file, --arms and --path', () => {
    expect(
      parseLabForkArgs([
        'my-lane', '--at', 'ckpt-1', '--model', 'opus',
        '--prompt-file', './p.md', '--arms', '5', '--path', '../repo',
      ]),
    ).toEqual({
      ...forkDefaults,
      at: 'ckpt-1',
      model: 'opus',
      promptFile: './p.md',
      arms: 5,
      path: '../repo',
    })
  })

  it('parses the =value spelling too', () => {
    expect(parseLabForkArgs(['my-lane', '--arms=2', '--model=sonnet'])).toEqual({
      ...forkDefaults,
      arms: 2,
      model: 'sonnet',
    })
  })

  it('parses --launch as a valueless switch that does not swallow the next token', () => {
    expect(parseLabForkArgs(['--launch', 'my-lane'])).toEqual({ ...forkDefaults, launch: true })
    expect(() => parseLabForkArgs(['my-lane', '--launch=yes'])).toThrow(/takes no value/)
  })

  it('throws on a zero, negative or non-integer arm count', () => {
    expect(() => parseLabForkArgs(['my-lane', '--arms', '0'])).toThrow(/invalid --arms/)
    expect(() => parseLabForkArgs(['my-lane', '--arms', '-1'])).toThrow(/invalid --arms/)
    expect(() => parseLabForkArgs(['my-lane', '--arms', '2.5'])).toThrow(/invalid --arms/)
    expect(() => parseLabForkArgs(['my-lane', '--arms', 'three'])).toThrow(/invalid --arms/)
  })

  it('throws on empty --at, --model or --prompt-file values', () => {
    expect(() => parseLabForkArgs(['my-lane', '--at', ''])).toThrow(/invalid --at/)
    expect(() => parseLabForkArgs(['my-lane', '--model', ''])).toThrow(/invalid --model/)
    expect(() => parseLabForkArgs(['my-lane', '--prompt-file', ''])).toThrow(/invalid --prompt-file/)
  })

  it('throws when the lane is missing, and on an unrecognised flag', () => {
    expect(() => parseLabForkArgs([])).toThrow(/missing required argument.*<lane>/is)
    expect(() => parseLabForkArgs(['my-lane', '--foo'])).toThrow(/unknown option.*"--foo"/is)
  })

  it('parses --help without requiring a lane', () => {
    expect(parseLabForkArgs(['--help']).help).toBe(true)
    expect(parseLabForkArgs(['-h']).help).toBe(true)
  })
})

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

describe('lab help text', () => {
  it('labHelpText documents every subcommand the namespace has', () => {
    const text = labHelpText()
    expect(text).toContain('checkpoint <lane>')
    expect(text).toContain('fork <lane>')
    expect(text).toContain('compare <fork-id>')
  })

  it('labForkHelpText documents the treatment flags, the arm default and why --launch is opt-in', () => {
    const text = labForkHelpText()
    expect(text).toContain('rhizomorph lab fork <lane>')
    expect(text).toContain('--at <checkpointId>')
    expect(text).toContain('--model')
    expect(text).toContain('--prompt-file')
    expect(text).toContain('--arms <n>')
    expect(text).toContain('default: 3')
    expect(text).toContain('--launch')
    expect(text).toContain('ruling 1')
  })

  it('labCompareHelpText says plainly that it will not rank below three arms', () => {
    const text = labCompareHelpText()
    expect(text).toContain('rhizomorph lab compare <fork-id>')
    expect(text).toContain('--verify')
    expect(text).toContain('--no-verify')
    expect(text).toContain('never a winner')
    expect(text).toContain('three')
  })

  it('labCheckpointHelpText documents the lane argument, --path, --captured-by and --help', () => {
    const text = labCheckpointHelpText()
    expect(text).toContain('rhizomorph lab checkpoint <lane>')
    expect(text).toContain('--path')
    expect(text).toContain('--captured-by')
    expect(text).toContain('--help')
  })
})
