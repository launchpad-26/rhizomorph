import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { BEACON_ATTENTION_KINDS } from '@rhizomorph/core'
import { afterEach, describe, expect, it } from 'vitest'
import { beaconDirFor } from '../collectors/beacon/paths.js'
import { parseBeaconLine } from '../collectors/beacon/parse-beacon-line.js'
import {
  CLAUDE_HOOK_EVENTS,
  envHelpText,
  parseEnvArgs,
  renderClaudeHooks,
} from './env.js'

const execFileAsync = promisify(execFile)

describe('parseEnvArgs', () => {
  const envDefaults = { lane: 'my-lane', role: 'worker', port: 4321, shell: 'sh', hooks: null, help: false }

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

  it('parses --hooks claude', () => {
    expect(parseEnvArgs(['my-lane', '--hooks', 'claude'])).toEqual({ ...envDefaults, hooks: 'claude' })
  })

  it('parses --hooks=claude', () => {
    expect(parseEnvArgs(['my-lane', '--hooks=claude'])).toEqual({ ...envDefaults, hooks: 'claude' })
  })

  it('throws on an unsupported --hooks, naming the supported list', () => {
    expect(() => parseEnvArgs(['my-lane', '--hooks', 'codex'])).toThrow(/invalid --hooks.*claude/s)
  })

  it('--hooks does not require or reject --role and --shell', () => {
    expect(parseEnvArgs(['my-lane', '--hooks', 'claude', '--shell', 'cmd'])).toEqual({
      ...envDefaults,
      hooks: 'claude',
      shell: 'cmd',
    })
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
  it('documents the lane argument, --role, --port, --shell, --hooks and --help', () => {
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
    expect(text).toContain('--hooks')
    expect(text).toContain('claude')
    expect(text).toContain('--help')
  })
})

describe('renderClaudeHooks', () => {
  const beaconDir = '/repo-data/repo-slug/beacons'
  const lane = 'my-lane'

  it('is a settings.json hooks fragment with exactly the four events, in order', () => {
    const output = renderClaudeHooks({ lane, beaconDir })
    const parsed = JSON.parse(output) as { hooks: Record<string, unknown> }
    expect(Object.keys(parsed.hooks)).toEqual(['Notification', 'Stop', 'UserPromptSubmit', 'PostToolUse'])
    for (const value of Object.values(parsed.hooks)) {
      expect(value).toEqual([{ hooks: [{ type: 'command', command: expect.any(String) }] }])
    }
  })

  it('every hook speaks a ruled kind', () => {
    const output = renderClaudeHooks({ lane, beaconDir })
    const parsed = JSON.parse(output) as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }

    for (const [event, kind] of CLAUDE_HOOK_EVENTS) {
      expect(BEACON_ATTENTION_KINDS).toContain(kind)
      const command = parsed.hooks[event]?.[0]?.hooks[0]?.command ?? ''
      expect(command).toContain(`"kind":"${kind}"`)
      expect(command).toContain(`"detail":"hook: ${event}"`)
    }

    const kindOf = (event: string): string => {
      const [, kind] = CLAUDE_HOOK_EVENTS.find(([e]) => e === event) ?? []
      return kind ?? ''
    }
    expect(kindOf('Notification')).toBe('waiting')
    expect(kindOf('Stop')).toBe('stopped')
    expect(kindOf('UserPromptSubmit')).toBe('working')
    expect(kindOf('PostToolUse')).toBe('working')
  })

  it('every command is cwd-independent by construction', () => {
    const output = renderClaudeHooks({ lane, beaconDir })
    const parsed = JSON.parse(output) as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }

    expect(path.isAbsolute(beaconDir)).toBe(true)
    for (const [event] of CLAUDE_HOOK_EVENTS) {
      const command = parsed.hooks[event]?.[0]?.hooks[0]?.command ?? ''
      expect(command).toContain("mkdir -p '")
      expect(command).toContain(" >> '")
      expect(command).not.toMatch(/ >(?!>)/)
      expect(command).toContain(`'${beaconDir}'`)
    }
  })

  it('output is newline-terminated and two-space indented', () => {
    const output = renderClaudeHooks({ lane, beaconDir })
    expect(output.endsWith('\n')).toBe(true)
    expect(output.startsWith('{\n  "hooks"')).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('a printed hook command, executed', () => {
  let root: string
  let cwd: string

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  })

  async function run(command: string): Promise<void> {
    await execFileAsync('sh', ['-c', command], { cwd })
  }

  async function readBeaconLines(beaconDir: string): Promise<string[]> {
    const content = await readFile(path.join(beaconDir, 'claude-hook.jsonl'), 'utf8')
    return content.split('\n').filter((line) => line.length > 0)
  }

  it('writes one parseable v1 line into a directory that did not exist, from an unrelated cwd', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'beacon-hook-root-'))
    cwd = await mkdtemp(path.join(tmpdir(), 'beacon-hook-cwd-'))
    const beaconDir = beaconDirFor('/repo', root)
    const output = renderClaudeHooks({ lane: 'my-lane', beaconDir })
    const parsed = JSON.parse(output) as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }
    const command = parsed.hooks.Notification?.[0]?.hooks[0]?.command
    if (command === undefined) throw new Error('no Notification command')

    const before = Date.now()
    await run(command)
    const after = Date.now()

    const lines = await readBeaconLines(beaconDir)
    expect(lines).toHaveLength(1)
    const parsedLine = parseBeaconLine(lines[0] ?? '')
    expect(parsedLine).toEqual({
      kind: 'beacon',
      at: expect.any(Number),
      payload: { writer: 'claude-hook', kind: 'waiting', lane: 'my-lane', detail: 'hook: Notification' },
    })
    if (parsedLine.kind !== 'beacon') throw new Error('expected a beacon')
    expect(parsedLine.at).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000)
    expect(parsedLine.at).toBeLessThanOrEqual(after)
    expect(parsedLine.at % 1000).toBe(0)
  })

  it('appends: run twice, two lines, both parse', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'beacon-hook-root-'))
    cwd = await mkdtemp(path.join(tmpdir(), 'beacon-hook-cwd-'))
    const beaconDir = beaconDirFor('/repo', root)
    const output = renderClaudeHooks({ lane: 'my-lane', beaconDir })
    const parsed = JSON.parse(output) as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }
    const command = parsed.hooks.Stop?.[0]?.hooks[0]?.command
    if (command === undefined) throw new Error('no Stop command')

    await run(command)
    await run(command)

    const lines = await readBeaconLines(beaconDir)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(parseBeaconLine(line).kind).toBe('beacon')
    }
  })

  it('a lane with a single quote and a double quote round-trips', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'beacon-hook-root-'))
    cwd = await mkdtemp(path.join(tmpdir(), 'beacon-hook-cwd-'))
    const beaconDir = beaconDirFor('/repo', root)
    const lane = `it's "odd"`
    const output = renderClaudeHooks({ lane, beaconDir })
    const parsed = JSON.parse(output) as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }
    const command = parsed.hooks.Notification?.[0]?.hooks[0]?.command
    if (command === undefined) throw new Error('no Notification command')

    await run(command)

    const lines = await readBeaconLines(beaconDir)
    expect(lines).toHaveLength(1)
    const parsedLine = parseBeaconLine(lines[0] ?? '')
    if (parsedLine.kind !== 'beacon') throw new Error('expected a beacon')
    expect(parsedLine.payload.lane).toBe(lane)
  })

  it('a beacon dir with a space and a single quote round-trips', async () => {
    root = await mkdtemp(path.join(tmpdir(), "beacon-hook-root-o'clock dir-"))
    cwd = await mkdtemp(path.join(tmpdir(), 'beacon-hook-cwd-'))
    const beaconDir = beaconDirFor('/repo', root)
    const output = renderClaudeHooks({ lane: 'my-lane', beaconDir })
    const parsed = JSON.parse(output) as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }
    const command = parsed.hooks.Notification?.[0]?.hooks[0]?.command
    if (command === undefined) throw new Error('no Notification command')

    await run(command)

    const lines = await readBeaconLines(beaconDir)
    expect(lines).toHaveLength(1)
    expect(parseBeaconLine(lines[0] ?? '').kind).toBe('beacon')
  })

  it('the kind and detail come from the table, per event', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'beacon-hook-root-'))
    cwd = await mkdtemp(path.join(tmpdir(), 'beacon-hook-cwd-'))
    const beaconDir = beaconDirFor('/repo', root)
    const output = renderClaudeHooks({ lane: 'my-lane', beaconDir })
    const parsed = JSON.parse(output) as { hooks: Record<string, [{ hooks: [{ command: string }] }]> }

    for (const [event] of CLAUDE_HOOK_EVENTS) {
      const command = parsed.hooks[event]?.[0]?.hooks[0]?.command
      if (command === undefined) throw new Error(`no ${event} command`)
      await run(command)
    }

    const lines = await readBeaconLines(beaconDir)
    expect(lines).toHaveLength(4)
    const pairs = lines.map((line) => {
      const p = parseBeaconLine(line)
      if (p.kind !== 'beacon') throw new Error('expected a beacon')
      return [p.payload.kind, p.payload.detail]
    })
    expect(pairs).toEqual(CLAUDE_HOOK_EVENTS.map(([event, kind]) => [kind, `hook: ${event}`]))
  })
})
