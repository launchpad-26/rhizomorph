import type { Exec } from '@rhizomorph/core'
import type { ProcessRow, ProcessTableReading } from './read-table.js'

/**
 * THE macOS LEG — prd-57 ruling 2, landed behind a real capture
 * (`fixtures/macos-ps.txt`, `macos-ps-args.txt`, `macos-lsof-cwd.txt`), never
 * from a man page.
 *
 * ## What the capture taught that the documentation would not have
 *
 * The headline one first, because it is the reason this leg makes THREE reads
 * where the recipe in `CAPTURE.md` named two:
 *
 * 1. **`ps -o command=` is argv joined by spaces, and it does not quote.**
 *    argv[0] of a real Claude Code session on macOS is
 *    `…/Library/Application Support/Claude/claude-code/<v>/claude.app/Contents/MacOS/claude`
 *    — it CONTAINS A SPACE. Split that on whitespace and argv[0] reads as
 *    `…/Library/Application`, whose basename is `Application`, which is in no
 *    roster. A leg built on `command=` alone parses the capture perfectly and
 *    matches **zero agents**. This is the macOS twin of the Windows `.exe`
 *    defect, and unlike that one the capture DOES show it — but only if you
 *    look at the bytes rather than at whether the parse succeeded.
 * 2. **`ps -o comm=` is the kernel's own executable path, so it IS argv[0],
 *    exactly.** That is why {@link MACOS_PS_ARGV} — the spine, carrying every
 *    numeric field — asks for `comm` and not `command`, and why
 *    {@link MACOS_PS_ARGS_ARGV} is a second call supplying only argv[1..].
 * 3. **`lstart` is five whitespace-separated tokens in the MIDDLE of the row.**
 *    `Sun Sep 13 12:41:26 2026`. Splitting from the left mis-reads every field
 *    after it, which is the same class of bug `/proc/<pid>/stat`'s unescaped
 *    `comm` causes on Linux. {@link PS_SPINE_ROW} solves it the same way the
 *    Linux leg does: parse from a known anchor. The anchor here is `lstart`'s
 *    own SHAPE, pinned in the pattern, rather than a token count.
 * 4. **`comm` itself can contain spaces and parentheses.** `Core Audio Driver
 *    (MSTeamsAudioDevice.driver)` is a real row in the capture. So `comm` is
 *    everything from its column to end of line, never a whitespace token.
 * 5. **`time=` is `MM:SS.ss`, and the minutes field is not bounded at 60.** The
 *    capture carries `404:34.97` — four hundred and four MINUTES, not four
 *    hundred and four hours. See {@link parseMacosCpuTime}.
 * 6. **`rss=` is kilobytes.** The contract wants bytes.
 *
 * ## The gap this leg declares rather than guesses
 *
 * **Only argv[0] is recoverable. argv[1..] is best-effort.** `ps` has already
 * destroyed the boundaries by the time this code sees anything: an argument
 * containing a space is indistinguishable from two arguments, and there is no
 * quoting to undo — the `--settings {…}` JSON on every captured agent row is
 * the live example. Windows at least quotes; `ps` does not.
 *
 * What that costs is narrow and worth stating exactly. argv[1..] is read for
 * ONE purpose: `matchesAgentCommand`'s interpreter arm, where argv[0] is
 * `node` and the agent is a later argument. So an agent launched as
 * `node "/path with a space/claude.js"` would be missed. Neither macOS install
 * shape on the capture machine has that problem — the desktop app and the
 * native CLI both put a real executable at argv[0], basename `claude` — and a
 * miss here is the safe direction anyway: it leaves an actor unseen rather
 * than inventing one.
 *
 * ## What `lsof` settled, which nobody in the project could answer
 *
 * **macOS behaves like Linux here, not like Windows.** `lsof -d cwd` returns
 * the working directory for every process the reader OWNS, with no sudo and no
 * prompt. For a process owned by anyone else it returns nothing — exit 1,
 * empty stdout, and *empty stderr*; it declines silently. Four of the seven
 * captured rows are root-owned and absent from `macos-lsof-cwd.txt` for
 * exactly that reason.
 *
 * That is the probe's fourth law — other users are invisible, and that is fine
 * — and it is not a gap for this instrument, because an agent process is
 * always the reader's own user. So this leg identifies AND places, and
 * `doctor-row.ts` gives macOS Linux's states rather than Windows's.
 *
 * ## The one degradation that is NOT modelled, said plainly
 *
 * If `ps` answers and `lsof` does not — it is missing, or the exec times out
 * on a wedged network mount — every row comes back with `cwd: null`, every
 * actor is unplaceable, and the collector emits nothing while `doctor` still
 * reports the leg as reading. That reads as "no agents in this repo" when the
 * truth is "cannot place any agent". It is not collapsed into `null`, because
 * the process table genuinely WAS read and a `null` there would suppress
 * `gone` for actors that really did exit. Nothing here measures how often that
 * happens, and no state is invented for it.
 */

/** macOS reports resident memory in kilobytes. The contract wants bytes. */
const KILOBYTES = 1024

/**
 * The spine: every numeric field, plus argv[0] exactly.
 *
 * `-ww` is deliberate. `ps` truncates its output to the terminal width when
 * stdout is a tty, and ADR-0004's `Exec` reads through a pipe where it does
 * not — so this flag changes nothing in production and everything when a
 * human runs the same command by hand to check what the leg sees. A recipe
 * whose output differs from the leg's is not a recipe.
 *
 * ADR-0019 clause 4's spirit: an argv array has no shell to inject into, and
 * the only interpolation here is none at all — the command is a constant.
 */
export const MACOS_PS_ARGV: readonly string[] = ['-axww', '-o', 'pid=,ppid=,lstart=,time=,rss=,comm=']

/**
 * The second read, and it supplies argv[1..] and nothing else — see the
 * docblock above for why it cannot be the spine.
 */
export const MACOS_PS_ARGS_ARGV: readonly string[] = ['-axww', '-o', 'pid=,command=']

/**
 * Every process's working directory, in ONE call.
 *
 * `CAPTURE.md`'s recipe is `-a -p <pid> -d cwd -Fn`, one process at a time.
 * That is right for a capture and wrong for a tick: this leg needs a cwd for
 * every row it returns, and the per-pid form would be one exec per process —
 * 487 of them on the capture machine. `-Fp` declares the process field rather
 * than relying on lsof emitting it anyway, which it does.
 */
export const MACOS_LSOF_ARGV: readonly string[] = ['-d', 'cwd', '-Fpn']

/**
 * One `ps` row, anchored on `lstart`'s SHAPE.
 *
 * The anchor is the whole point. `lstart` is five tokens (`Sun Sep 13
 * 12:41:26 2026`) sitting between `ppid` and `time`, so a left-to-right
 * whitespace split mis-reads `time`, `rss` and `comm` — and mis-reads them
 * into plausible-looking values rather than failing, which is the dangerous
 * kind of wrong. Pinning the date's own form here means a row that does not
 * carry one is SKIPPED rather than silently shifted by a field.
 *
 * Anchoring on the shape rather than on a token count is the stronger of the
 * two: counting five tokens would also "work" on a line whose fifth token
 * happened to be a number, and would keep working after `ps` changed format.
 */
const PS_SPINE_ROW =
  /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(\d+)\s+(.+)$/

/** `pid` then everything else — `command` is the last field and holds spaces. */
const PS_ARGS_ROW = /^\s*(\d+)\s+(.+)$/

/** `Sun Sep 13 12:41:26 2026`, already isolated by {@link PS_SPINE_ROW}. */
const LSTART = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/

/**
 * `[DD-][HH:]MM:SS[.ss]`.
 *
 * Every real row in the capture is the `MM:SS.ss` form, including
 * `404:34.97` — the minutes field is NOT bounded at 60, so a parser that read
 * three-digit leading values as hours would report a WindowServer with 404
 * hours of CPU. The day and hour arms are here because `ps(1)` documents them
 * and this instrument runs on machines that stay up longer than the capture
 * machine had; they are not exercised by the fixture and that is stated in the
 * test rather than hidden.
 */
const PS_TIME = /^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?(\.\d+)?$/

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

/**
 * `ps`'s `lstart` to epoch ms, or `null` for anything this leg has not seen.
 *
 * Built field by field through the local-time `Date` constructor rather than
 * handed to `Date.parse`. `ps` prints local time with no zone marker, and
 * `Date.parse`'s behaviour on a non-ISO string is implementation-defined —
 * so the lenient path would be a start time that is correct on one runtime and
 * silently hours out on another. Start time is half of an actor's identity.
 */
export function parseMacosLstart(value: string): number | null {
  const match = LSTART.exec(value.trim())
  if (match === null) return null
  const month = MONTHS[match[1] ?? '']
  if (month === undefined) return null
  const parts = [match[2], match[3], match[4], match[5], match[6]].map(Number)
  if (!parts.every(Number.isFinite)) return null
  const [day, hour, minute, second, year] = parts as [number, number, number, number, number]
  const ms = new Date(year, month, day, hour, minute, second).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * `ps`'s `time` to milliseconds of cumulative CPU, or `null`.
 *
 * The rule that makes every documented form work without branching on which
 * one arrived: the LAST colon-separated field is seconds, the one before it
 * minutes, the one before that hours. So `27:46.42` is 27 minutes and
 * `1:02:03` is one hour — and neither reading depends on guessing from the
 * magnitude of the leading number, which is what `404:34.97` in the capture
 * would defeat.
 */
export function parseMacosCpuTime(value: string): number | null {
  const match = PS_TIME.exec(value.trim())
  if (match === null) return null
  const days = Number(match[1] ?? 0)
  const first = Number(match[2])
  const second = Number(match[3])
  const third = match[4] === undefined ? null : Number(match[4])
  const fraction = Number(match[5] ?? 0)
  if (![days, first, second, fraction].every(Number.isFinite)) return null
  if (third !== null && !Number.isFinite(third)) return null

  const [hours, minutes, seconds] = third === null ? [0, first, second] : [first, second, third]
  const total = ((days * 24 + hours) * 60 + minutes) * 60 + seconds + fraction
  return Math.round(total * 1000)
}

/**
 * `lsof -Fpn` to pid -> working directory.
 *
 * The field-descriptor line is checked rather than assumed. `-d cwd` should
 * make every `n` line a working directory, but reading the `f` field means a
 * future flag change cannot quietly turn some other open file into a process's
 * placement — and placement is what decides which lane an actor reaches.
 *
 * A pid absent from this map is not an error and not a skip: it is a process
 * whose cwd this reader may not see, which the row reports as `cwd: null`.
 */
export function parseMacosCwdMap(lsofText: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | null = null
  let descriptor: string | null = null
  for (const line of lsofText.split('\n')) {
    const tag = line[0]
    const value = line.slice(1).trim()
    if (tag === 'p') {
      pid = Number(value)
      descriptor = null
    } else if (tag === 'f') {
      descriptor = value
    } else if (tag === 'n' && descriptor === 'cwd' && pid !== null && Number.isInteger(pid) && pid > 0) {
      // First answer wins. A process has one working directory; a second `n`
      // under the same `f` would be lsof telling us something this leg does
      // not model, and overwriting on it would make placement order-dependent.
      if (!cwds.has(pid)) cwds.set(pid, line.slice(1))
    }
  }
  return cwds
}

/** `pid -> the whole command line`, from the second `ps` read. */
function parseArgsMap(argsText: string): Map<number, string> {
  const commands = new Map<number, string>()
  for (const line of argsText.split('\n')) {
    const match = PS_ARGS_ROW.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    if (Number.isInteger(pid) && pid > 0) commands.set(pid, match[2] ?? '')
  }
  return commands
}

/**
 * argv for one process: argv[0] exact from `comm`, the rest best-effort.
 *
 * `command` starts with `comm` for every process on the capture machine
 * (463 of 463 that appeared in both reads), so the tail after that prefix is
 * argv[1..] and the space inside argv[0] never reaches the splitter. When it
 * does NOT start with `comm` — a process that rewrote its own argv[0], a login
 * shell's `-zsh` — the first whitespace token is dropped as that rewritten
 * argv[0] and `comm` stands in its place, because `comm` is what the kernel
 * says the program IS and the roster is a list of programs.
 *
 * With no `command` at all the row is still returned, carrying `comm` alone.
 * The two `ps` reads are not one atomic snapshot, so a pid can appear in the
 * first and not the second; dropping the row would turn that race into a
 * `gone` for a process that never left.
 */
function argvFor(comm: string, command: string | undefined): string[] {
  if (command === undefined || command.length === 0) return [comm]
  if (command === comm) return [comm]
  if (command.startsWith(`${comm} `)) {
    return [comm, ...command.slice(comm.length).trim().split(/\s+/).filter((part) => part.length > 0)]
  }
  const [, ...rest] = command.trim().split(/\s+/)
  return [comm, ...rest.filter((part) => part.length > 0)]
}

/**
 * Parse one capture into rows.
 *
 * Exported so the fixture can be driven directly, which is the whole point of
 * capturing: this function is tested against real bytes from a real machine by
 * someone who does not need that machine.
 *
 * `argsText` and `lsofText` are nullable on purpose, and they are not the same
 * kind of missing as a missing spine. No spine means the process table could
 * not be read — `null`, unknown, never "nothing is running". No args means
 * every row keeps argv[0] and loses the interpreter arm. No lsof means every
 * row keeps `cwd: null`, which is the honest unknown the collector renders as
 * `placement: 'unknown'`.
 */
export function parseMacosTable(
  spineText: string,
  argsText: string | null,
  lsofText: string | null,
): ProcessTableReading | null {
  const commands = argsText === null ? new Map<number, string>() : parseArgsMap(argsText)
  const cwds = lsofText === null ? new Map<number, string>() : parseMacosCwdMap(lsofText)

  const rows: ProcessRow[] = []
  let sawRow = false
  for (const line of spineText.split('\n')) {
    const match = PS_SPINE_ROW.exec(line)
    // A header comment, a blank line, or anything that is not a `ps` row. Not
    // an error and not an absence — skipped, the way the Linux leg steps over
    // a pid that exited between the listing and the read.
    if (match === null) continue
    sawRow = true

    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const startedAt = parseMacosLstart(match[3] ?? '')
    const cpuMs = parseMacosCpuTime(match[4] ?? '')
    const rssKilobytes = Number(match[5])
    const comm = (match[6] ?? '').trim()

    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!Number.isFinite(parentPid)) continue
    // A row whose start time or CPU will not parse is skipped rather than
    // guessed at. `startedAt` is half of an actor's identity and a fabricated
    // one would make a live agent look like a recycled pid on the next tick.
    if (startedAt === null || cpuMs === null) continue
    if (!Number.isFinite(rssKilobytes)) continue
    // A process with no executable name is never an agent — the macOS twin of
    // the Linux leg skipping a kernel thread's empty `cmdline`.
    if (comm.length === 0) continue

    rows.push({
      pid,
      argv: argvFor(comm, commands.get(pid)),
      cwd: cwds.get(pid) ?? null,
      startedAt,
      cpuMs,
      rssBytes: rssKilobytes * KILOBYTES,
      parentPid,
    })
  }

  // Not one parseable row in the whole output. That is not an empty process
  // table — `ps -ax` on a running machine always has at least `launchd` — so
  // something other than a process table came back, and the honest answer is
  // "I cannot look" rather than "there is nothing there".
  return sawRow ? { rows } : null
}

/**
 * ADR-0004's seam: a pure fold over command output, behind an injected `Exec`.
 *
 * The three reads go out together rather than in sequence. Two of them are the
 * same process table read twice, and the pid in one is joined against the pid
 * in the other — so the window in which a process can exit between them is a
 * source of wrong answers, and it is the one thing here worth minimising. The
 * cost of issuing all three when the first is doomed is one failed spawn.
 *
 * A failed spine is `null` — unknown, never "nothing is running", so a machine
 * where `ps` is not on PATH degrades to silence rather than to a flatline.
 */
export async function readMacosTable(exec: Exec): Promise<ProcessTableReading | null> {
  const [spine, args, cwd] = await Promise.all([
    exec('ps', MACOS_PS_ARGV),
    exec('ps', MACOS_PS_ARGS_ARGV),
    exec('lsof', MACOS_LSOF_ARGV),
  ])
  if (spine.failed || spine.stdout.trim().length === 0) return null
  return parseMacosTable(
    spine.stdout,
    args.failed || args.stdout.trim().length === 0 ? null : args.stdout,
    cwd.failed || cwd.stdout.trim().length === 0 ? null : cwd.stdout,
  )
}
