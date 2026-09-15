import type { Exec } from '@rhizomorph/core'
import type { ProcessRow, ProcessTableReading } from './read-table.js'

/**
 * THE WINDOWS LEG — prd-57 ruling 2, landed behind a real capture
 * (`fixtures/windows-cim.json`), never from a man page.
 *
 * ## What the capture taught that the documentation would not have
 *
 * Three things, each of which would have produced a plausible, broken parser:
 *
 * 1. **`CreationDate` is not ISO 8601.** `ConvertTo-Json` serialises a CIM
 *    datetime as `"\/Date(1788956011002)\/"` — .NET's own JSON date form. The
 *    number is epoch milliseconds, which is exactly what this leg wants, but
 *    nothing about `Get-CimInstance`'s documentation says so.
 * 2. **`CommandLine` is `null` for a process this user may not read.** Two of
 *    the five rows in the capture are system processes with no command line at
 *    all. That is the Windows form of the probe's fourth law — other users'
 *    processes are invisible, and that is fine — and a parser that assumed a
 *    string would throw on the first tick of any real machine.
 * 3. **`CommandLine` is ONE STRING, not an argv array.** Unlike `/proc`'s
 *    NUL-separated `cmdline`, Windows hands back the raw line, so this leg has
 *    to split it — and splitting it is the one place quoting matters, because
 *    the executable path routinely contains spaces.
 *
 * ## The gap this leg declares rather than guesses
 *
 * **`Win32_Process` has no working-directory field.** Not an omission in the
 * query below: the class does not expose one, and Windows will not give another
 * process's cwd without native calls into the target. So this leg identifies an
 * agent and cannot place it, which it reports as `cwd: null` — the honest
 * unknown the collector then renders as `placement: 'unknown'`.
 *
 * Placement on Windows therefore has to come from somewhere else: the
 * transcript's own `cwd`, or a hook beacon's. Both are prd-57 ruling 3's join,
 * and neither exists until wave 3 — so **this leg identifies agents today and
 * emits nothing**, and `doctor` says exactly that rather than claiming a
 * platform is unsupported when the truth is narrower.
 */

/** 100-nanosecond intervals, which is how Windows reports CPU time. */
const FILETIME_TICKS_PER_MS = 10_000

/** `"\/Date(1788956011002)\/"` — .NET's JSON date. The capture is why this exists. */
const DOTNET_DATE = /^\/Date\((-?\d+)\)\/$/

/**
 * The query, as one argv array. ADR-0019 clause 4's spirit applies even though
 * this is not the concierge: an argv array has no shell to inject into, and the
 * only interpolation here is none at all — the command is a constant.
 */
export const WINDOWS_CIM_ARGV: readonly string[] = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine, WorkingSetSize, UserModeTime, KernelModeTime | ConvertTo-Json -Depth 3',
]

interface CimRow {
  readonly ProcessId?: unknown
  readonly ParentProcessId?: unknown
  readonly CreationDate?: unknown
  readonly CommandLine?: unknown
  readonly WorkingSetSize?: unknown
  readonly UserModeTime?: unknown
  readonly KernelModeTime?: unknown
}

/**
 * Split a Windows command line into argv.
 *
 * Deliberately minimal: double-quoted runs are one token, everything else
 * splits on whitespace. That is enough for the one question this leg asks —
 * does any token's basename name a known agent — and the capture is what says
 * it is enough: every real row in it is `"<quoted path with spaces>" --flag
 * value`.
 *
 * It is NOT a general implementation of Windows' own command-line-to-argv
 * rules, which handle far more than this does. Backslash-escaped quotes and
 * embedded quotes inside a token are not handled, because handling them would
 * be precision in a direction that does not matter here and risk in one that
 * does: a miss makes an agent invisible, and `matchesAgentCommand` is already
 * permissive behind a known interpreter for exactly that reason.
 */
export function splitWindowsCommandLine(line: string): string[] {
  const argv: string[] = []
  let current = ''
  let quoted = false
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) argv.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.length > 0) argv.push(current)
  return argv
}

/** `"\/Date(n)\/"` to epoch ms, or `null` for anything this leg has not seen. */
export function parseDotNetDate(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = DOTNET_DATE.exec(value)
  if (match === null) return null
  const ms = Number(match[1])
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/**
 * Parse one `ConvertTo-Json` document into rows.
 *
 * Exported so the fixture can be driven directly, which is the whole point of
 * capturing: this function is tested against real bytes from a real machine by
 * someone who does not need that machine.
 */
export function parseWindowsCimJson(json: string): ProcessTableReading | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  // One process on the machine and `ConvertTo-Json` emits an object rather than
  // an array. Never observed here — the capture has five rows — but it is a
  // documented PowerShell behaviour and a single-agent machine is the likeliest
  // place this leg ever runs.
  const raw: CimRow[] = Array.isArray(parsed) ? (parsed as CimRow[]) : [parsed as CimRow]

  const rows: ProcessRow[] = []
  for (const row of raw) {
    const pid = Number(row.ProcessId)
    if (!Number.isInteger(pid) || pid <= 0) continue

    // A command line this user may not read. The process is real and is simply
    // not identifiable, which is not the same as "not an agent" — but it is the
    // same OUTCOME, because identity here is argv and there is no argv.
    if (typeof row.CommandLine !== 'string' || row.CommandLine.length === 0) continue

    const startedAt = parseDotNetDate(row.CreationDate)
    if (startedAt === null) continue

    const userTicks = Number(row.UserModeTime ?? 0)
    const kernelTicks = Number(row.KernelModeTime ?? 0)
    const rssBytes = Number(row.WorkingSetSize ?? 0)
    const parentPid = Number(row.ParentProcessId ?? 0)
    if (![userTicks, kernelTicks, rssBytes, parentPid].every(Number.isFinite)) continue

    rows.push({
      pid,
      argv: splitWindowsCommandLine(row.CommandLine),
      // The gap, stated. Windows does not expose another process's working
      // directory, so this leg identifies and does not place.
      cwd: null,
      startedAt,
      cpuMs: Math.round((userTicks + kernelTicks) / FILETIME_TICKS_PER_MS),
      rssBytes,
      parentPid,
    })
  }
  return { rows }
}

/**
 * ADR-0004's seam: a pure fold over command output, behind an injected `Exec`.
 * A failed spawn is `null` — unknown, never "nothing is running", so a machine
 * without PowerShell on PATH degrades to silence rather than to a flatline.
 */
export async function readWindowsTable(exec: Exec): Promise<ProcessTableReading | null> {
  const result = await exec('powershell', WINDOWS_CIM_ARGV)
  if (result.failed || result.stdout.trim().length === 0) return null
  return parseWindowsCimJson(result.stdout)
}
