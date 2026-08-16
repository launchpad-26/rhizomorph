import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { serverSpawnRequest, SHELL_FLAGS } from './spawn-contract.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const ARGS_SOURCE = path.join(REPO_ROOT, 'packages', 'server', 'src', 'cli', 'args.ts')

const BASE = {
  execPath: '/Applications/rhizomorph.app/Contents/MacOS/rhizomorph',
  serverEntry: '/Resources/packages/server/bin/rhizomorph.mjs',
  repoPath: '/home/dev/project',
  env: { PATH: '/usr/bin', HOME: '/home/dev' } as NodeJS.ProcessEnv,
}

describe('the spawn contract', () => {
  it('runs the app\'s OWN binary as node — never a `node` found on PATH', () => {
    const request = serverSpawnRequest(BASE)
    expect(request.command).toBe(BASE.execPath)
    expect(request.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('spawns the server\'s bin, with the repo as the first positional', () => {
    const request = serverSpawnRequest(BASE)
    expect(request.args[0]).toBe(BASE.serverEntry)
    expect(request.args[1]).toBe('/home/dev/project')
  })

  it('asks for `--port 0` so a second launch never collides with the first', () => {
    const request = serverSpawnRequest(BASE)
    const at = request.args.indexOf('--port')
    expect(at).toBeGreaterThan(-1)
    expect(request.args[at + 1]).toBe('0')
    // The shell holds no port constant at all: 4321 must not appear anywhere in
    // what it asks for.
    expect(request.args.join(' ')).not.toContain('4321')
  })

  it('runs the child in the watched repo, so cwd and the positional cannot disagree', () => {
    expect(serverSpawnRequest(BASE).cwd).toBe('/home/dev/project')
  })

  it('passes no repo and no cwd before one is chosen — the CLI\'s own default then applies', () => {
    const request = serverSpawnRequest({ ...BASE, repoPath: null })
    expect(request.cwd).toBeUndefined()
    expect(request.args).toEqual([BASE.serverEntry, '--port', '0'])
  })

  it('inherits the environment rather than replacing it', () => {
    const request = serverSpawnRequest(BASE)
    expect(request.env.PATH).toBe('/usr/bin')
    expect(request.env.HOME).toBe('/home/dev')
  })

  it('carries no credential, no token and no auth flag — ADR-0012\'s handshake is in-band', () => {
    const request = serverSpawnRequest(BASE)
    const spelled = `${request.args.join(' ')} ${Object.keys(request.env).join(' ')}`
    expect(spelled).not.toMatch(/token|secret|credential|password|auth/i)
  })

  it('asks for no session flag — a relaunch resumes, which is what the resume window is for', () => {
    const request = serverSpawnRequest(BASE)
    expect(request.args).not.toContain('--fresh')
    expect(request.args).not.toContain('--backfill')
    expect(request.args).not.toContain('--resume-window')
  })
})

/**
 * THE FLAG-HONESTY LAW. The shell is a second caller of a CLI it does not own,
 * and the failure it would produce — a flag the server renamed, so every launch
 * dies with `unknown option` at a stranger's first run — is invisible to every
 * test that only reads this package. So the law reads the server's own
 * `parseArgs` and asserts each flag the shell passes is still declared there.
 */
describe('every flag the shell passes is one the server still declares', () => {
  const source = readFileSync(ARGS_SOURCE, 'utf8')

  it('reads the server\'s real arg parser', () => {
    // Guard against a vacuous pass: if this file moved, the assertions below
    // would hold against an empty string.
    expect(source).toContain('export function parseArgs')
    expect(source.length).toBeGreaterThan(1000)
  })

  it.each([...SHELL_FLAGS])('declares %s in its flag specs', (flag) => {
    expect(source).toContain(`flag: '${flag}'`)
  })

  it('still reads the repo path as the first positional', () => {
    expect(source).toContain('const path = positionals[0]')
  })

  it('still treats port 0 as legitimate rather than invalid', () => {
    expect(source).toContain('if (!Number.isInteger(port) || port < 0)')
  })

  it('would fail on a flag the server does not declare', () => {
    // The law's own mutation, run rather than described: a made-up flag is not
    // in the parser, and this is the assertion that would go red for a real one.
    expect(source).not.toContain("flag: '--not-a-real-flag'")
  })
})
