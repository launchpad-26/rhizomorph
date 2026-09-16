import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Exec } from '@rhizomorph/core'
import { NO_LEG_READER, createProcTableReader, defaultProcessTableReader } from './read-table.js'

/** The Linux leg spawns nothing, so this is never called — it exists to satisfy the seam. */
const noExec: Exec = async () => ({ stdout: '', stderr: '', code: 0, failed: false })

/**
 * A fabricated procfs, so the Linux leg runs on any machine.
 *
 * That property is the whole reason `read-table.ts` takes every fact from a
 * FILE, including the clock: it is ADR-0004's stated payoff applied to a
 * surface with no `Exec`, and it is what makes ruling 10's three-platform
 * witness reachable at all — a leg tested from committed bytes can be verified
 * by someone who does not own the machine those bytes came from.
 */

const NUL = '\0'
const BOOT_SECONDS = 1_788_000_000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface FakeProcess {
  readonly pid: number
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly startTicks?: number
  readonly utime?: number
  readonly stime?: number
  readonly rssPages?: number
  readonly ppid?: number
  /** `comm` as the kernel writes it — in parentheses, unescaped. */
  readonly comm?: string
}

function fakeProc(processes: readonly FakeProcess[], options: { btime?: number | null } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rhizo-proctable-'))
  roots.push(root)
  const procRoot = path.join(root, 'proc')
  mkdirSync(procRoot, { recursive: true })

  if (options.btime !== null) {
    writeFileSync(path.join(procRoot, 'stat'), `cpu  1 2 3\nbtime ${options.btime ?? BOOT_SECONDS}\nprocesses 99\n`, 'utf8')
  }

  for (const p of processes) {
    const dir = path.join(procRoot, String(p.pid))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'cmdline'), `${p.argv.join(NUL)}${NUL}`, 'utf8')
    // proc(5): pid (comm) state ppid ... utime stime ... starttime ... rss
    const fields = new Array(50).fill('0')
    fields[0] = String(p.ppid ?? 1) // field 4
    fields[10] = String(p.utime ?? 0) // field 14
    fields[11] = String(p.stime ?? 0) // field 15
    fields[18] = String(p.startTicks ?? 1000) // field 22
    fields[20] = String(p.rssPages ?? 0) // field 24
    writeFileSync(path.join(dir, 'stat'), `${p.pid} (${p.comm ?? 'claude'}) S ${fields.join(' ')}\n`, 'utf8')
    if (p.cwd !== undefined) {
      const target = path.join(root, 'target', String(p.pid))
      mkdirSync(target, { recursive: true })
      // `junction` on Windows, which is the one directory link an unprivileged
      // process may create there — a plain symlink is EPERM without Developer
      // Mode, and this cohort runs Windows. `readlink` resolves both, so the
      // reader under test sees the same thing either way.
      symlinkSync(target, path.join(dir, 'cwd'), process.platform === 'win32' ? 'junction' : 'dir')
    }
  }
  return procRoot
}

describe('the /proc reader parses what the kernel published', () => {
  it('reads argv, parent, start time, CPU and RSS from one process', async () => {
    const procRoot = fakeProc([
      { pid: 4321, argv: ['claude', '--resume'], cwd: 'x', startTicks: 500, utime: 30, stime: 20, rssPages: 100, ppid: 900 },
    ])
    const reading = await createProcTableReader({ procRoot })(noExec)

    expect(reading).not.toBeNull()
    const row = reading?.rows[0]
    expect(row?.pid).toBe(4321)
    expect(row?.argv).toEqual(['claude', '--resume'])
    expect(row?.parentPid).toBe(900)
    // 500 ticks at 100 Hz = 5s after boot.
    expect(row?.startedAt).toBe((BOOT_SECONDS + 5) * 1000)
    // (30 + 20) ticks = 500ms of CPU.
    expect(row?.cpuMs).toBe(500)
    expect(row?.rssBytes).toBe(100 * 4096)
  })

  it('survives a comm containing a close-paren — the classic /proc/stat parse bug', async () => {
    // A process really can be called `weird ) name`, and `comm` is NOT escaped.
    // Splitting on whitespace from the left mis-reads every field after it, so
    // the parse takes everything after the LAST `)`.
    const procRoot = fakeProc([{ pid: 7, argv: ['claude'], comm: 'weird ) name', startTicks: 100 }])
    const reading = await createProcTableReader({ procRoot })(noExec)
    expect(reading?.rows[0]?.startedAt).toBe((BOOT_SECONDS + 1) * 1000)
  })

  it('splits argv on NUL and lets no NUL byte out', async () => {
    const procRoot = fakeProc([{ pid: 8, argv: ['node', '/path/to/claude', '-p', 'a prompt'] }])
    const reading = await createProcTableReader({ procRoot })(noExec)
    for (const part of reading?.rows[0]?.argv ?? []) expect(part).not.toContain(NUL)
    expect(reading?.rows[0]?.argv).toEqual(['node', '/path/to/claude', '-p', 'a prompt'])
  })

  it('a process whose cwd it may not read is kept with a null cwd — real, placement unknown', async () => {
    // Windows reaches this for every process. The row is not dropped: the
    // process exists, and it is the PLACEMENT that is unknown.
    const procRoot = fakeProc([{ pid: 9, argv: ['claude'] }])
    const reading = await createProcTableReader({ procRoot })(noExec)
    expect(reading?.rows).toHaveLength(1)
    expect(reading?.rows[0]?.cwd).toBeNull()
  })

  it('skips a kernel thread — an empty cmdline is never an agent', async () => {
    const procRoot = fakeProc([{ pid: 2, argv: [] }, { pid: 3, argv: ['claude'] }])
    const reading = await createProcTableReader({ procRoot })(noExec)
    expect(reading?.rows.map((r) => r.pid)).toEqual([3])
  })
})

describe('unknown is never death — the probe\'s third law, one layer up', () => {
  it('answers null when there is no procfs at all', async () => {
    expect(await createProcTableReader({ procRoot: path.join(tmpdir(), 'rhizo-does-not-exist-9d2f') })(noExec)).toBeNull()
  })

  it('answers null when the directory is not a process table', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rhizo-notproc-'))
    roots.push(root)
    writeFileSync(path.join(root, 'README'), 'not a process table', 'utf8')
    expect(await createProcTableReader({ procRoot: root })(noExec)).toBeNull()
  })

  it('answers null when boot time cannot be read — every start time would otherwise be invented', async () => {
    // Without `btime` there is no anchor turning ticks into an instant. A
    // reader that guessed would produce start times that look real and are not,
    // and start time is half of an actor's identity.
    const procRoot = fakeProc([{ pid: 4321, argv: ['claude'] }], { btime: null })
    expect(await createProcTableReader({ procRoot })(noExec)).toBeNull()
  })

  it('an EMPTY table is a real answer, distinct from null', async () => {
    // The distinction that matters: "I looked and there are no agents" versus
    // "I cannot look". The first may retire actors; the second may not.
    const procRoot = fakeProc([{ pid: 2, argv: [] }])
    const reading = await createProcTableReader({ procRoot })(noExec)
    expect(reading).not.toBeNull()
    expect(reading?.rows).toEqual([])
  })

  it('the no-leg reader answers null, and is what every UNBUILT platform gets', async () => {
    expect(await NO_LEG_READER(noExec)).toBeNull()
    // freebsd has no capture and no named read-only strategy, and it is now
    // the only standing example: the three platforms this instrument actually
    // runs on have all left this reader.
    expect(defaultProcessTableReader('freebsd')).toBe(NO_LEG_READER)
  })

  it.each([['win32'], ['darwin']] as const)(
    '%s is BUILT and is no longer the no-leg reader — the capture is what changed that',
    (platform) => {
      // Asserted by identity rather than by result, and that choice is the
      // whole value of these two lines. Every one of these readers ALSO
      // answers null when handed an exec that returns nothing, so a
      // `toBeNull()` here would pass whether or not the leg existed — which is
      // exactly the shape that let a platform look supported while being
      // absent. `darwin` was on the other side of this assertion until its
      // capture was taken; it was inverted rather than deleted, so the fact
      // that changed is visible in the diff.
      expect(defaultProcessTableReader(platform)).not.toBe(NO_LEG_READER)
    },
  )

  it('picks the /proc reader on linux, which is WSL2 too — it is `linux` to Node, not a second leg', () => {
    expect(defaultProcessTableReader('linux')).not.toBe(NO_LEG_READER)
  })
})
