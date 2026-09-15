import { readFile, readdir, readlink } from 'node:fs/promises'
import path from 'node:path'
import type { Exec } from '@rhizomorph/core'
import { readWindowsTable } from './read-table-windows.js'

/**
 * READING THE PROCESS TABLE — prd-57 ruling 2, licensed by ADR-0052.
 *
 * One row per process this reader could see and identify. Everything here is a
 * fact the operating system already published; nothing is derived from argv
 * beyond the signature match the caller performs, and no environment is read at
 * all. `process-law.test.ts` greps this directory for `environ` and for every
 * signal idiom, so those are structural rather than promised.
 *
 * ## Why `/proc` is parsed rather than `ps` on Linux
 *
 * `collectors/sessionlog/process-probe.ts` already reads `/proc` for the stall
 * check, and prd-57 ruling 2 keeps that file untouched (Success 3) — its own
 * law pins its filesystem imports to exactly three names, so it could not
 * delegate here even if we wanted it to. This module re-reads independently.
 * The duplication is deliberate and cheaper than amending a law written to be
 * hard to amend.
 *
 * ## Why everything comes from FILES, including the clock
 *
 * A fabricated `procRoot` is a directory of plain files, so the whole Linux leg
 * runs in a test with no live process table — which is ADR-0004's stated payoff
 * ("collector tests run against captured fixtures with no git, tmux or workmux
 * present") applied to a surface that has no `Exec` at all. It is also the only
 * way ruling 10's three-platform witness is reachable: a macOS capture is
 * `ps`/`lsof` output committed as a fixture, and a leg tested that way can be
 * verified by someone who does not own the machine it came from.
 */

/** One process, as the table described it. Placement is the caller's to decide. */
export interface ProcessRow {
  readonly pid: number
  /** NUL-split argv. The caller matches a signature against it and keeps nothing else. */
  readonly argv: readonly string[]
  /** The process's working directory, already resolved by the kernel. `null` where the platform will not say. */
  readonly cwd: string | null
  /** Epoch ms. See {@link CLOCK_TICKS_PER_SECOND} for the one assumption in it. */
  readonly startedAt: number
  /** Cumulative user+system CPU, in ms. A delta is the caller's to compute. */
  readonly cpuMs: number
  readonly rssBytes: number
  /** The OS parent. The caller keeps it only when that parent is itself a matched actor. */
  readonly parentPid: number
}

export interface ProcessTableReading {
  /** Every row this reader could parse. Empty is a real answer; `null` is the other one. */
  readonly rows: readonly ProcessRow[]
}

/**
 * `null` means **this build cannot look**, and is never "nothing is running".
 *
 * That distinction is the probe's third law — unknown is never death — and it
 * is what stops an unbuilt platform leg from emitting a fleet-wide `gone`.
 */
export type ProcessTableReader = (exec: Exec) => Promise<ProcessTableReading | null>

/**
 * USER_HZ. Fixed at 100 on Linux for every architecture this instrument runs
 * on, and unreadable from userland without a native call.
 *
 * **What a wrong value would and would not break, stated rather than assumed:**
 * `startedAt` is used for two things — as half of an actor's identity
 * (`pid:startedAt`), and to tell a recycled pid from a live one. Both are
 * *comparisons between values produced by this same reader*, so a wrong HZ
 * shifts every start time by the same factor and neither breaks. What it would
 * skew is the absolute wall-clock instant, which only the inferred-join window
 * reads — and prd-57 ruling 3 requires that window be chosen from measurement,
 * which would measure this skew along with everything else.
 */
const CLOCK_TICKS_PER_SECOND = 100

/** Linux reports resident memory in pages. 4 KiB everywhere this runs. */
const PAGE_SIZE_BYTES = 4096

/**
 * `/proc/<pid>/stat`, from the field after `comm` onward.
 *
 * `comm` is the executable name **in parentheses and not escaped**, so a
 * process called `weird ) name` breaks any split-on-whitespace parse. Splitting
 * on the LAST `)` is the standard defence and the reason this is a function
 * rather than a one-liner: the fields before it are `pid` and `comm`, and this
 * reader already knows the pid from the directory name.
 */
function fieldsAfterComm(stat: string): string[] | null {
  const close = stat.lastIndexOf(')')
  if (close === -1) return null
  const rest = stat.slice(close + 1).trim()
  return rest.length === 0 ? null : rest.split(/\s+/)
}

/** Field numbers are 1-based in `proc(5)`; the first token here is field 3. */
const FIELD = { ppid: 4, utime: 14, stime: 15, starttime: 22, rss: 24 } as const
const at = (fields: readonly string[], field: number): number => Number(fields[field - 3])

/**
 * Boot time, epoch seconds, from `/proc/stat`'s `btime` line — the anchor that
 * turns a per-process tick count into a wall-clock instant.
 */
async function bootTimeSeconds(procRoot: string): Promise<number | null> {
  let text: string
  try {
    text = await readFile(path.join(procRoot, 'stat'), 'utf8')
  } catch {
    return null
  }
  const line = text.split('\n').find((candidate) => candidate.startsWith('btime '))
  if (line === undefined) return null
  const seconds = Number(line.slice('btime '.length).trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

export interface ProcReaderOptions {
  /** Overridable so a test points at a fabricated procfs. Never written to. */
  readonly procRoot?: string
}

/**
 * The `/proc` reader — Linux and WSL2, which is the same leg because WSL2 runs
 * a real kernel and is `linux` to Node.
 *
 * Every failure is a SKIP, never a throw and never an absence: a pid that exits
 * between the listing and the read, or one belonging to another user, is
 * stepped over. That is the probe's fourth law — other users are invisible, and
 * that is fine — and the reason it matters here is that a denial counted as
 * absence would emit `gone` for a process that is still running.
 */
export function createProcTableReader(options: ProcReaderOptions = {}): ProcessTableReader {
  const procRoot = options.procRoot ?? '/proc'

  return async () => {
    let entries: string[]
    try {
      entries = await readdir(procRoot)
    } catch {
      // No procfs here, or unreadable. Unknown — never "nothing is running".
      return null
    }

    const pids = entries.filter((entry) => /^\d+$/.test(entry))
    // An empty or non-numeric listing is not a process table; something else is
    // mounted at this path. Refuse to call that "no processes", which is the
    // same refusal `process-probe.ts` makes for the same reason.
    if (pids.length === 0) return null

    const boot = await bootTimeSeconds(procRoot)
    if (boot === null) return null

    const rows: ProcessRow[] = []
    for (const pid of pids) {
      const row = await readRow(procRoot, pid, boot)
      if (row !== null) rows.push(row)
    }
    return { rows }
  }
}

async function readRow(procRoot: string, pid: string, bootSeconds: number): Promise<ProcessRow | null> {
  const dir = path.join(procRoot, pid)

  let cmdline: string
  try {
    cmdline = await readFile(path.join(dir, 'cmdline'), 'utf8')
  } catch {
    return null // exited, or another user's
  }
  // procfs writes argv NUL-separated with a trailing NUL. Splitting on it is the
  // whole of "argv-only": no shell string is ever reassembled, so no quoting and
  // no NUL byte escapes this function.
  const argv = cmdline.split('\0').filter((part) => part.length > 0)
  if (argv.length === 0) return null // a kernel thread, which is never an agent

  let stat: string
  try {
    stat = await readFile(path.join(dir, 'stat'), 'utf8')
  } catch {
    return null
  }
  const fields = fieldsAfterComm(stat)
  if (fields === null) return null

  const starttimeTicks = at(fields, FIELD.starttime)
  const utime = at(fields, FIELD.utime)
  const stime = at(fields, FIELD.stime)
  const rssPages = at(fields, FIELD.rss)
  const parentPid = at(fields, FIELD.ppid)
  if (![starttimeTicks, utime, stime, rssPages, parentPid].every(Number.isFinite)) return null

  // A cwd this reader may not read is `null`, not a guess and not a skip: the
  // process is real and its placement is what is unknown. Windows reaches this
  // state for every process, which is why the leg declares cwd a capability it
  // lacks rather than pretending.
  let cwd: string | null
  try {
    cwd = await readlink(path.join(dir, 'cwd'))
  } catch {
    cwd = null
  }

  return {
    pid: Number(pid),
    argv,
    cwd,
    startedAt: Math.round((bootSeconds + starttimeTicks / CLOCK_TICKS_PER_SECOND) * 1000),
    cpuMs: Math.round(((utime + stime) / CLOCK_TICKS_PER_SECOND) * 1000),
    rssBytes: rssPages * PAGE_SIZE_BYTES,
    parentPid,
  }
}

/**
 * The reader for a platform with no leg built — macOS, Windows native, or any
 * Linux where `/proc` is not mounted.
 *
 * Answers `null` to everything, which the collector renders as **no events at
 * all** rather than as an empty table. prd-57 ruling 2 and prd-15 ruling 7: a
 * leg lands behind a real capture, never from a man page, and until then it
 * yields nothing and `doctor` says so with the capture command as the remedy.
 */
export const NO_LEG_READER: ProcessTableReader = async () => null

/**
 * Chosen by platform rather than by trying and failing, so a macOS boot does
 * not pay for a doomed `readdir` on every tick.
 */
export function defaultProcessTableReader(platform: NodeJS.Platform = process.platform): ProcessTableReader {
  if (platform === 'linux') return createProcTableReader()
  // The Windows leg landed behind `fixtures/windows-cim.json`, captured on a
  // real machine with three real agents running. It identifies an agent and
  // cannot place one, because `Win32_Process` exposes no working directory —
  // see `read-table-windows.ts` for what the capture taught that the
  // documentation would not have.
  if (platform === 'win32') return readWindowsTable
  // macOS is still unbuilt: no capture, so no leg. `doctor` says so with the
  // capture command as its remedy rather than reporting an empty table.
  return NO_LEG_READER
}
