import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectHarness, detectOnPath, detectRunning } from './detect.js'

/**
 * Detection's laws. The one this lane exists to defend is the third state:
 * a platform this build cannot probe reports **unknown**, never **absent**.
 *
 * Hermetic: one `mkdtemp` root per test, a fabricated procfs, and an injected
 * `env`/`platform` — nothing here reads the real machine, so the suite answers
 * the same on Linux, macOS and Windows CI.
 */

const NUL = '\0'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-harness-detect-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A real executable file in a real directory, so `access(X_OK)` is answering about something. */
async function givenExecutable(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, name)
  await writeFile(file, '#!/bin/sh\n')
  await chmod(file, 0o755)
  return file
}

/** A fabricated procfs: pid -> argv array, written NUL-separated as procfs does. */
async function givenProcfs(processes: Record<string, readonly string[]>): Promise<string> {
  const procRoot = path.join(root, 'proc')
  await mkdir(procRoot, { recursive: true })
  for (const [pid, argv] of Object.entries(processes)) {
    await mkdir(path.join(procRoot, pid), { recursive: true })
    await writeFile(path.join(procRoot, pid, 'cmdline'), `${argv.join(NUL)}${NUL}`)
  }
  return procRoot
}

describe('detectOnPath — is there an executable file this hand could launch?', () => {
  it('finds an executable file and names where it found it', async () => {
    const bin = path.join(root, 'bin')
    const file = await givenExecutable(bin, 'claude')

    const presence = await detectOnPath('claude', { platform: 'linux', env: { PATH: bin } })

    expect(presence.state).toBe('present')
    expect(presence).toMatchObject({ executablePath: file })
    // The evidence is a fact a human can go and check, not a verdict.
    expect((presence as { evidence: string }).evidence).toContain(file)
  })

  it('reports absent only after really searching, and says how many places', async () => {
    const bin = path.join(root, 'bin')
    await givenExecutable(bin, 'something-else')

    const presence = await detectOnPath('claude', { platform: 'linux', env: { PATH: bin } })

    expect(presence.state).toBe('absent')
    expect((presence as { evidence: string }).evidence).toContain('1')
  })

  it('does not count a non-executable file of the right name', async () => {
    const bin = path.join(root, 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(path.join(bin, 'claude'), 'not executable\n')
    await chmod(path.join(bin, 'claude'), 0o644)

    const presence = await detectOnPath('claude', { platform: 'linux', env: { PATH: bin } })

    // A file this hand cannot execute is not a harness it can launch.
    expect(presence.state).toBe('absent')
  })

  it('says UNKNOWN, not absent, when the environment has no PATH at all', async () => {
    const presence = await detectOnPath('claude', { platform: 'linux', env: {} })

    expect(presence.state).toBe('unknown')
    expect((presence as { reason: string }).reason).toContain('PATH')
  })

  it('says UNKNOWN when PATH holds nothing absolute to search', async () => {
    // Empty and relative entries are deliberately skipped — an empty entry
    // means the cwd, which may be the watched repo. Having skipped them all,
    // this build has looked nowhere, and "nowhere" is not "not installed".
    const presence = await detectOnPath('claude', { platform: 'linux', env: { PATH: ':.:relative/bin' } })

    expect(presence.state).toBe('unknown')
  })

  it('never resolves an executable out of the working directory', async () => {
    // The hostile shape: a `claude` sitting in the watched repo, reachable only
    // through PATH's empty-entry-means-cwd rule.
    const cwdLike = path.join(root, 'watched-repo')
    await givenExecutable(cwdLike, 'claude')

    const presence = await detectOnPath('claude', { platform: 'linux', env: { PATH: `:${path.join(root, 'empty')}` } })

    expect(presence.state).not.toBe('present')
  })

  it('explains that a shell alias or function is not counted, and why', async () => {
    // The real trap: on the machine this lane was written on, `pi` is a shell
    // function with no executable file anywhere on PATH. Reporting that as a
    // bare "not installed" would be false to an operator who types `pi` daily,
    // so the evidence has to say what was actually looked for.
    const bin = path.join(root, 'bin')
    await mkdir(bin, { recursive: true })

    const presence = await detectOnPath('pi', { platform: 'linux', env: { PATH: bin } })

    expect(presence.state).toBe('absent')
    const evidence = (presence as { evidence: string }).evidence
    expect(evidence).toMatch(/alias or shell function/)
    expect(evidence).toContain('argv array')
  })

  it('works on Windows, where executability is carried by PATHEXT', async () => {
    const bin = path.join(root, 'bin')
    const file = await givenExecutable(bin, 'codex.EXE')

    const presence = await detectOnPath('codex', {
      platform: 'win32',
      env: { Path: bin, PATHEXT: '.COM;.EXE;.BAT' },
    })

    expect(presence.state).toBe('present')
    expect(presence).toMatchObject({ executablePath: file })
  })

  it('splits PATH with the TARGET platform\'s delimiter, not the host\'s', async () => {
    // A `;`-joined PATH must work when the platform is win32 even though this
    // suite runs on a `:` host — otherwise the Windows leg is never really tested.
    const bin = path.join(root, 'bin')
    await givenExecutable(bin, 'codex.EXE')

    const presence = await detectOnPath('codex', {
      platform: 'win32',
      env: { Path: `${path.join(root, 'nowhere')};${bin}`, PATHEXT: '.EXE' },
    })

    expect(presence.state).toBe('present')
  })
})

describe('detectRunning — and the three-state rule this lane turns on', () => {
  it.each(['darwin', 'win32', 'freebsd'] as const)(
    'on %s reports UNKNOWN with a reason — never absent',
    async (platform) => {
      const presence = await detectRunning('claude', { platform })

      // The whole point. A detector that reports a present harness as absent is
      // worse than one that admits it cannot see.
      expect(presence.state).toBe('unknown')
      expect(presence.state).not.toBe('absent')
      expect((presence as { reason: string }).reason.length).toBeGreaterThan(0)
    },
  )

  it('names a real strategy for the platform it cannot read, rather than shrugging', async () => {
    const macos = await detectRunning('claude', { platform: 'darwin' })
    const windows = await detectRunning('claude', { platform: 'win32' })

    expect((macos as { remedy?: string }).remedy).toMatch(/lsof/)
    expect((windows as { remedy?: string }).remedy).toMatch(/Win32_Process/)
  })

  it('finds a running process by argv[0] on linux', async () => {
    const procRoot = await givenProcfs({ '4021': ['/usr/local/bin/claude', '--continue'] })

    const presence = await detectRunning('claude', { platform: 'linux', procRoot })

    expect(presence.state).toBe('present')
    expect((presence as { evidence: string }).evidence).toContain('4021')
  })

  it('finds one launched through an interpreter — the false-absent this lane forbids', async () => {
    // `claude` is frequently a JS entry point started as `node /path/to/claude`,
    // whose argv[0] basename is `node`. Reading that as "not running" would be
    // exactly the lie the three-state rule exists to prevent.
    const procRoot = await givenProcfs({ '5150': ['/usr/bin/node', '/opt/claude/bin/claude'] })

    const presence = await detectRunning('claude', { platform: 'linux', procRoot })

    expect(presence.state).toBe('present')
  })

  it('does not read an editor holding the name as a running harness', async () => {
    // The symmetric error: argv[1] counts only behind a known interpreter, so
    // avoiding the false absent above does not buy a false present here.
    const procRoot = await givenProcfs({ '6001': ['/usr/bin/vim', 'claude'] })

    const presence = await detectRunning('claude', { platform: 'linux', procRoot })

    expect(presence.state).toBe('absent')
  })

  it('reports absent only once the table was really read', async () => {
    const procRoot = await givenProcfs({ '7001': ['/usr/bin/zsh'], '7002': ['/usr/bin/codex'] })

    const presence = await detectRunning('claude', { platform: 'linux', procRoot })

    expect(presence.state).toBe('absent')
    expect((presence as { evidence: string }).evidence).toContain('2')
  })

  it('says UNKNOWN when the process table cannot be read at all', async () => {
    const presence = await detectRunning('claude', {
      platform: 'linux',
      procRoot: path.join(root, 'no-such-proc'),
    })

    expect(presence.state).toBe('unknown')
  })

  it('says UNKNOWN when the directory is not a process table', async () => {
    // Something other than procfs is mounted here. Refusing to call that "no
    // agent" is the same judgement `process-probe.ts` makes.
    const procRoot = path.join(root, 'proc')
    await mkdir(procRoot, { recursive: true })
    await writeFile(path.join(procRoot, 'README'), 'not a procfs\n')

    const presence = await detectRunning('claude', { platform: 'linux', procRoot })

    expect(presence.state).toBe('unknown')
  })

  it('says UNKNOWN when every process refused to reveal its argv', async () => {
    // Every pid present, no cmdline readable — the reader's blindness, not an
    // answer about the harness.
    const procRoot = path.join(root, 'proc')
    await mkdir(path.join(procRoot, '8001'), { recursive: true })
    await mkdir(path.join(procRoot, '8002'), { recursive: true })

    const presence = await detectRunning('claude', { platform: 'linux', procRoot })

    expect(presence.state).toBe('unknown')
    expect((presence as { reason: string }).reason).toContain('argv')
  })
})

describe('detectHarness — the two questions answered independently', () => {
  it('can be present on PATH while whether it is running is unknown — the macOS case', async () => {
    const bin = path.join(root, 'bin')
    await givenExecutable(bin, 'codex')

    const detection = await detectHarness('codex', 'codex', { platform: 'darwin', env: { PATH: bin } })

    expect(detection.harness).toBe('codex')
    // Installed: knowable everywhere. Running: not knowable here. Both honest.
    expect(detection.onPath.state).toBe('present')
    expect(detection.running.state).toBe('unknown')
  })
})
