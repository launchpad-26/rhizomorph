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

/** A pid whose `cmdline` cannot be read for a reason that is NOT "it exited". */
async function givenUnreadablePid(procRoot: string, pid: string): Promise<void> {
  // `cmdline` as a DIRECTORY yields EISDIR — deterministic on every platform and
  // for every user, including root. The real-world case is EACCES (another
  // user's process), which the test below exercises where the OS permits it;
  // both land on the same branch, because it keys on "not ENOENT" rather than on
  // one errno.
  await mkdir(path.join(procRoot, pid, 'cmdline'), { recursive: true })
}

/** A pid that exited between the listing and the read: the directory is there, `cmdline` is not. */
async function givenExitedPid(procRoot: string, pid: string): Promise<void> {
  await mkdir(path.join(procRoot, pid), { recursive: true })
}

const RUNNING_AS_ROOT = process.getuid?.() === 0

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

describe('installed is not the same question as launchable (Windows .bat/.cmd)', () => {
  /**
   * **Simulated, not run.** These drive the win32 branch through an injected
   * `platform` on a POSIX host; no Windows machine executed them. What they pin
   * is the decision — that a shell-only shim is neither `present` nor `absent` —
   * not that Node's spawn behaves as documented on a real Windows box.
   */
  it('reports a .CMD shim as installed-not-launchable, naming the file and clause 4', async () => {
    const bin = path.join(root, 'bin')
    const shim = await givenExecutable(bin, 'claude.CMD')

    const presence = await detectOnPath('claude', { platform: 'win32', env: { Path: bin, PATHEXT: '.EXE;.CMD' } })

    // An npm-installed CLI on Windows IS a .cmd shim, so this is the normal
    // shape. `present` would promise a launch clause 4 structurally forbids;
    // `absent` would tell an operator their installed CLI is not installed.
    expect(presence.state).toBe('installed-not-launchable')
    expect(presence).toMatchObject({ foundAt: shim })
    expect((presence as { reason: string }).reason).toMatch(/clause 4/)
  })

  it('does the same for .BAT', async () => {
    const bin = path.join(root, 'bin')
    await givenExecutable(bin, 'claude.BAT')

    const presence = await detectOnPath('claude', { platform: 'win32', env: { Path: bin, PATHEXT: '.BAT' } })

    expect(presence.state).toBe('installed-not-launchable')
  })

  it('never reports a shim as launchable — no executablePath a spawn could use', async () => {
    const bin = path.join(root, 'bin')
    await givenExecutable(bin, 'claude.CMD')

    const presence = await detectOnPath('claude', { platform: 'win32', env: { Path: bin, PATHEXT: '.CMD' } })

    expect(presence.state).not.toBe('present')
    expect((presence as { executablePath?: string }).executablePath).toBeUndefined()
  })

  it('a real .EXE later on PATH still wins over a shim found first', async () => {
    // The shim must not shadow a genuinely launchable file: the search keeps
    // going and only falls back to the shim once nothing better exists.
    const shimDir = path.join(root, 'shim')
    const realDir = path.join(root, 'real')
    await givenExecutable(shimDir, 'claude.CMD')
    const real = await givenExecutable(realDir, 'claude.EXE')

    const presence = await detectOnPath('claude', {
      platform: 'win32',
      env: { Path: `${shimDir};${realDir}`, PATHEXT: '.EXE;.CMD' },
    })

    expect(presence.state).toBe('present')
    expect(presence).toMatchObject({ executablePath: real })
  })

  it('treats .bat and .cmd case-insensitively, as Windows does', async () => {
    const bin = path.join(root, 'bin')
    await givenExecutable(bin, 'claude.cmd')

    const presence = await detectOnPath('claude', { platform: 'win32', env: { Path: bin, PATHEXT: '.cmd' } })

    expect(presence.state).toBe('installed-not-launchable')
  })

  it('a .cmd on POSIX is just a file, and this rule does not fire there', async () => {
    const bin = path.join(root, 'bin')
    await givenExecutable(bin, 'claude.cmd')

    // Nothing special about the suffix off Windows — the name simply is not `claude`.
    const presence = await detectOnPath('claude', { platform: 'linux', env: { PATH: bin } })

    expect(presence.state).toBe('absent')
  })
})

describe('a directory is not an executable', () => {
  it('does not report a DIRECTORY named like the harness as present', async () => {
    // `access(dir, X_OK)` succeeds for any searchable directory on POSIX, so
    // without the isFile() check this reported `present` with an
    // `executablePath` pointing at something no spawn can ever run.
    const bin = path.join(root, 'bin')
    await mkdir(path.join(bin, 'claude'), { recursive: true })

    const presence = await detectOnPath('claude', { platform: 'linux', env: { PATH: bin } })

    expect(presence.state).toBe('absent')
    expect((presence as { executablePath?: string }).executablePath).toBeUndefined()
  })

  it('does not report a directory as present on win32 either, where F_OK is even weaker', async () => {
    const bin = path.join(root, 'bin')
    await mkdir(path.join(bin, 'claude.EXE'), { recursive: true })

    const presence = await detectOnPath('claude', { platform: 'win32', env: { Path: bin, PATHEXT: '.EXE' } })

    expect(presence.state).toBe('absent')
  })

  it('still finds a real file in the same directory as a same-named subdirectory', async () => {
    const bin = path.join(root, 'bin')
    await mkdir(path.join(bin, 'claude'), { recursive: true })
    const real = await givenExecutable(path.join(root, 'real'), 'claude')

    const presence = await detectOnPath('claude', { platform: 'linux', env: { PATH: `${bin}:${path.join(root, 'real')}` } })

    expect(presence).toMatchObject({ state: 'present', executablePath: real })
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

  it('says UNKNOWN on a PARTLY unreadable table — the false absent this lane forbids', async () => {
    // The regression: one readable non-target process plus one that refused.
    // Counting only total blindness let this fall through to `absent` while the
    // harness may well have been the process that refused — and the picker would
    // then offer to relaunch a conductor that is already running.
    const procRoot = await givenProcfs({ '7001': ['/usr/bin/zsh'] })
    await givenUnreadablePid(procRoot, '7002')

    const presence = await detectRunning('claude', { platform: 'linux', procRoot })

    expect(presence.state).toBe('unknown')
    expect(presence.state).not.toBe('absent')
  })

  it('says how many refused and how many were read, so the gap is legible', async () => {
    const procRoot = await givenProcfs({ '7001': ['/usr/bin/zsh'], '7002': ['/usr/bin/vim'] })
    await givenUnreadablePid(procRoot, '7003')

    const presence = await detectRunning('claude', { platform: 'linux', procRoot })
    const reason = (presence as { reason: string }).reason

    expect(reason).toContain('1 of the 3')
    expect(reason).toContain('2 were read')
  })

  it.skipIf(RUNNING_AS_ROOT)('does the same for a genuinely permission-denied read', async () => {
    // The real-world shape — EACCES, another user's process. Skipped when the
    // suite runs as root, where chmod cannot deny anything; the EISDIR test
    // above covers the branch unconditionally.
    const procRoot = await givenProcfs({ '7001': ['/usr/bin/zsh'], '7002': ['/usr/bin/claude-ish'] })
    await chmod(path.join(procRoot, '7002', 'cmdline'), 0o000)

    const presence = await detectRunning('claude', { platform: 'linux', procRoot })

    expect(presence.state).toBe('unknown')
  })

  it('a process that EXITED is not a blind spot, and still permits absent', async () => {
    // The other half of splitting the errno: ENOENT means the process is gone,
    // which is genuinely nothing to report. Treating it as a refusal would make
    // `absent` unreachable on any busy machine and the state would stop meaning
    // anything.
    const procRoot = await givenProcfs({ '7001': ['/usr/bin/zsh'] })
    await givenExitedPid(procRoot, '7002')

    const presence = await detectRunning('claude', { platform: 'linux', procRoot })

    expect(presence.state).toBe('absent')
  })

  it('still finds the harness when another process refused', async () => {
    // A refusal must not mask a positive: the target was found, so `present` is
    // a fact and the unread ones cannot make it less true.
    const procRoot = await givenProcfs({ '7001': ['/usr/local/bin/claude'] })
    await givenUnreadablePid(procRoot, '7002')

    const presence = await detectRunning('claude', { platform: 'linux', procRoot })

    expect(presence.state).toBe('present')
  })

  it('says UNKNOWN when every process vanished before it could be read', async () => {
    // Every pid listed, none with a `cmdline` left — ENOENT throughout, so each
    // one exited between the listing and the read. Nothing was refused here (the
    // `denied` branch above is that case); the point is that a table which
    // produced no readings at all is not a table to conclude `absent` from.
    const procRoot = path.join(root, 'proc')
    await givenExitedPid(procRoot, '8001')
    await givenExitedPid(procRoot, '8002')

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
