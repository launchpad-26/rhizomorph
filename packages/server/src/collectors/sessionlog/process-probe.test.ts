import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_COMMANDS,
  createProcProcessProbe,
  defaultProcessProbe,
  UNKNOWN_PROCESS_PROBE,
} from './process-probe.js'

/**
 * The probe is the one part of this organ that looks outside the transcripts,
 * so it is tested against a **fabricated procfs** rather than the real one:
 * hermetic, deterministic, and safe to run four at a time. The shapes it
 * fabricates were taken from this machine's real `/proc` (a `cwd` symlink and
 * a NUL-separated `cmdline`), which is what makes the fake faithful.
 */

const NUL = '\u0000'

interface FakeProcess {
  pid: number
  cwd: string
  /** argv, exactly as procfs stores it: NUL-separated with a trailing NUL. */
  argv: string[]
}

describe('the /proc process probe', () => {
  let root: string
  let procRoot: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sessionlog-probe-'))
    procRoot = path.join(root, 'proc')
    await mkdir(procRoot, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function fabricate(processes: readonly FakeProcess[]): Promise<void> {
    // A little non-process noise, exactly as the real /proc carries it.
    for (const name of ['self', 'cpuinfo', 'meminfo']) {
      await mkdir(path.join(procRoot, name), { recursive: true })
    }
    for (const proc of processes) {
      const dir = path.join(procRoot, String(proc.pid))
      await mkdir(dir, { recursive: true })
      await mkdir(proc.cwd, { recursive: true })
      await symlink(proc.cwd, path.join(dir, 'cwd'))
      await writeFile(path.join(dir, 'cmdline'), `${proc.argv.join(NUL)}${NUL}`)
    }
  }

  const laneA = () => path.join(root, 'wt', 'lane-a')
  const laneB = () => path.join(root, 'wt', 'lane-b')

  it('finds an agent by argv AND cwd together', async () => {
    await fabricate([{ pid: 4001, cwd: laneA(), argv: ['claude', '--model', 'opus'] }])
    const result = await createProcProcessProbe({ procRoot }).probe([laneA(), laneB()])
    expect(result.get(laneA())).toBe(true)
    expect(result.get(laneB())).toBe(false)
  })

  it('refuses a process in the right place that is not an agent', async () => {
    // argv-only identity, half one: a recycled pid, or the operator's own
    // shell sitting in the lane, must not read as a live agent.
    await fabricate([
      { pid: 4002, cwd: laneA(), argv: ['/bin/bash', '-c', 'sleep 900'] },
      { pid: 4003, cwd: laneA(), argv: ['vim', 'README.md'] },
    ])
    expect((await createProcProcessProbe({ procRoot }).probe([laneA()])).get(laneA())).toBe(false)
  })

  it('refuses an agent in the wrong place', async () => {
    // argv-only identity, half two: the conductor is a real `claude`, but it
    // is not this lane's, and a lane must never inherit another's liveness.
    await fabricate([{ pid: 4004, cwd: path.join(root, 'repo'), argv: ['claude'] }])
    expect((await createProcProcessProbe({ procRoot }).probe([laneA()])).get(laneA())).toBe(false)
  })

  it('counts an agent running in a subdirectory of the worktree', async () => {
    await fabricate([{ pid: 4005, cwd: path.join(laneA(), 'packages', 'server'), argv: ['claude'] }])
    expect((await createProcProcessProbe({ procRoot }).probe([laneA()])).get(laneA())).toBe(true)
  })

  it('does not let a repo-root process claim every lane beneath it', async () => {
    // Containment runs one way only. A conductor in the repo root is not
    // every worker's process, however many worktrees hang off it.
    const repo = path.join(root, 'wt')
    await fabricate([{ pid: 4006, cwd: repo, argv: ['claude'] }])
    const result = await createProcProcessProbe({ procRoot }).probe([laneA(), laneB(), repo])
    expect(result.get(laneA())).toBe(false)
    expect(result.get(laneB())).toBe(false)
    expect(result.get(repo)).toBe(true)
  })

  it('matches argv[0] by basename, so an absolute launch path still counts', async () => {
    await fabricate([{ pid: 4007, cwd: laneA(), argv: ['/usr/local/bin/claude', '--continue'] }])
    expect((await createProcProcessProbe({ procRoot }).probe([laneA()])).get(laneA())).toBe(true)
  })

  it('sees the other agent CLIs a lane may be running', async () => {
    // Their transcript *grammars* are later waves; their processes are alive
    // now, and refusing to see one would fabricate a death.
    for (const [index, command] of AGENT_COMMANDS.entries()) {
      const lane = path.join(root, 'wt', `cli-${command}`)
      await fabricate([{ pid: 5000 + index, cwd: lane, argv: [command] }])
      expect((await createProcProcessProbe({ procRoot }).probe([lane])).get(lane), command).toBe(true)
    }
  })

  it('answers for every worktree asked about, in one pass over the table', async () => {
    const lanes = Array.from({ length: 12 }, (_, i) => path.join(root, 'wt', `lane-${i}`))
    await fabricate(lanes.map((cwd, i) => ({ pid: 6000 + i, cwd, argv: i % 2 === 0 ? ['claude'] : ['zsh'] })))
    const result = await createProcProcessProbe({ procRoot }).probe(lanes)
    expect(result.size).toBe(lanes.length)
    expect(lanes.map((lane) => result.get(lane))).toEqual(lanes.map((_, i) => i % 2 === 0))
  })

  it('asks nothing and answers nothing when no lane has stalled', async () => {
    await fabricate([{ pid: 4008, cwd: laneA(), argv: ['claude'] }])
    expect((await createProcProcessProbe({ procRoot }).probe([])).size).toBe(0)
  })

  it('survives a pid that exits between the listing and the read', async () => {
    // The real race: /proc/<pid>/cwd is gone by the time we readlink it.
    await fabricate([{ pid: 4009, cwd: laneA(), argv: ['claude'] }])
    await mkdir(path.join(procRoot, '4010')) // listed, but with no cwd or cmdline
    const result = await createProcProcessProbe({ procRoot }).probe([laneA()])
    expect(result.get(laneA())).toBe(true)
  })

  it('survives a pid whose cwd it may not read — other users are invisible, not fatal', async () => {
    // 57 of 79 pids on the machine this was written on deny the cwd readlink.
    // Every one belongs to another user; a lane's own agent never does.
    await mkdir(path.join(procRoot, '4011'))
    await writeFile(path.join(procRoot, '4011', 'cmdline'), `claude${NUL}`)
    await fabricate([{ pid: 4012, cwd: laneA(), argv: ['claude'] }])
    expect((await createProcProcessProbe({ procRoot }).probe([laneA()])).get(laneA())).toBe(true)
  })

  it('splits argv on NUL and lets no NUL byte out', async () => {
    await fabricate([{ pid: 4013, cwd: laneA(), argv: ['claude', '--model', 'opus', 'a prompt with spaces'] }])
    const stored = await readFile(path.join(procRoot, '4013', 'cmdline'), 'utf8')
    expect(stored).toContain(NUL)
    expect((await createProcProcessProbe({ procRoot }).probe([laneA()])).get(laneA())).toBe(true)
  })
})

describe('unknown is never death', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sessionlog-probe-unknown-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('answers null when there is no procfs to read', async () => {
    const probe = createProcProcessProbe({ procRoot: path.join(root, 'no-such-proc') })
    expect((await probe.probe(['/repo-wt/lane-a'])).get('/repo-wt/lane-a')).toBeNull()
  })

  it('answers null when the directory is not a process table at all', async () => {
    // A readable directory with no numeric entries is something else mounted
    // where procfs was expected. Calling that "no agent anywhere" would
    // declare an entire fleet dead on a misconfiguration.
    const notProc = path.join(root, 'not-proc')
    await mkdir(notProc, { recursive: true })
    await writeFile(path.join(notProc, 'README'), 'not a process table')
    const probe = createProcProcessProbe({ procRoot: notProc })
    expect((await probe.probe(['/repo-wt/lane-a'])).get('/repo-wt/lane-a')).toBeNull()
  })

  it('answers null for every lane on a platform with no equivalent', async () => {
    const result = await UNKNOWN_PROCESS_PROBE.probe(['/a', '/b'])
    expect([...result.values()]).toEqual([null, null])
  })

  it('picks /proc on linux and the honest unknown everywhere else', () => {
    expect(defaultProcessProbe('linux').name).toContain('proc')
    for (const platform of ['darwin', 'win32', 'freebsd'] as const) {
      expect(defaultProcessProbe(platform), platform).toBe(UNKNOWN_PROCESS_PROBE)
    }
  })
})

describe('the observer\'s constitution, asserted over the source text', () => {
  /**
   * Grep-law, in the shape `drawer/readonly.test.ts` already uses: whatever
   * this probe grows into, it may look at the process table and it may not
   * touch it. A behavioural test cannot prove that about code nobody has
   * written yet; a grep over the file can.
   */
  const SOURCE = readFileSync(fileURLToPath(new URL('./process-probe.ts', import.meta.url)), 'utf8')

  it('has a source file to check at all — an empty grep proves nothing', () => {
    expect(SOURCE.length).toBeGreaterThan(1_000)
  })

  it('names no way to write, anywhere', () => {
    for (const forbidden of [/\bwriteFile\b/, /\bappendFile\b/, /\bmkdir\b/, /\bunlink\b/, /\brm\b/, /\brename\b/, /\bcreateWriteStream\b/, /\butimes\b/, /\bchmod\b/]) {
      expect(SOURCE, `process-probe.ts names ${forbidden}`).not.toMatch(forbidden)
    }
  })

  it('names no way to reach the observed process', () => {
    // `process.kill(pid, 0)` is the usual POSIX liveness idiom and is
    // deliberately refused: it is a call AT the process, and a recycled pid
    // answers it happily. Spawning is refused for the same reason plus cost.
    for (const forbidden of [/\.kill\(/, /\bspawn\b/, /\bexecFile\b/, /child_process/, /\bexec\(/]) {
      expect(SOURCE, `process-probe.ts names ${forbidden}`).not.toMatch(forbidden)
    }
  })

  it('reads through exactly three filesystem calls', () => {
    expect(SOURCE).toMatch(/from 'node:fs\/promises'/)
    const imported = SOURCE.match(/import \{([^}]*)\} from 'node:fs\/promises'/)?.[1] ?? ''
    expect(imported.split(',').map((name) => name.trim()).sort()).toEqual(['readFile', 'readdir', 'readlink'])
  })

  it('states its macOS and Windows strategy rather than assuming one', () => {
    // prd15 ruling 7: a platform leg is verified, never assumed. Until a
    // capture exists the strategy is prose plus a null answer — which the
    // behavioural tests above already pin.
    expect(SOURCE).toMatch(/macOS/)
    expect(SOURCE).toMatch(/lsof/)
    expect(SOURCE).toMatch(/Win32_Process/)
    expect(SOURCE).toMatch(/WSL2/)
  })
})

describe('nothing under the probe was written to', () => {
  it('leaves the fabricated procfs byte-identical after a probe', async () => {
    // The strongest form of "read-only": take the whole tree before and after.
    const root = await mkdtemp(path.join(tmpdir(), 'sessionlog-probe-ro-'))
    try {
      const procRoot = path.join(root, 'proc')
      const lane = path.join(root, 'wt', 'lane-a')
      await mkdir(path.join(procRoot, '7001'), { recursive: true })
      await mkdir(lane, { recursive: true })
      await symlink(lane, path.join(procRoot, '7001', 'cwd'))
      await writeFile(path.join(procRoot, '7001', 'cmdline'), `claude${NUL}`)

      const snapshot = async (): Promise<string> => {
        const names = (await readdir(procRoot, { recursive: true })).sort()
        const cmdline = await readFile(path.join(procRoot, '7001', 'cmdline'), 'utf8')
        return JSON.stringify({ names, cmdline })
      }

      const before = await snapshot()
      await createProcProcessProbe({ procRoot }).probe([lane])
      expect(await snapshot()).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the collector directory writes nothing anywhere', () => {
  /**
   * The observer's constitution for the whole organ, not just the probe: zero
   * writes anywhere in this collector. Stated over every non-test source file
   * in the directory, so a future reader of transcripts cannot quietly grow a
   * cache, a lockfile or a marker in the watched tree.
   */
  const DIR = path.dirname(fileURLToPath(import.meta.url))

  it('names no filesystem write in any source file', () => {
    const sources = readdirSync(DIR)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => ({ name, text: readFileSync(path.join(DIR, name), 'utf8') }))

    expect(sources.length).toBeGreaterThan(5)
    for (const source of sources) {
      for (const forbidden of [/\bwriteFile\b/, /\bappendFile\b/, /\bcreateWriteStream\b/, /\bmkdir\b/, /\bunlink\b/, /\brmdir\b/]) {
        expect(source.text, `${source.name} names ${forbidden}`).not.toMatch(forbidden)
      }
    }
  })
})
