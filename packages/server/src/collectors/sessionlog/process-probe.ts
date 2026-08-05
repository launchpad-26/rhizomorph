import { readFile, readdir, readlink } from 'node:fs/promises'
import path from 'node:path'

/**
 * Process aliveness — input (c) of the transcript-tail state machine
 * (prd15 ruling 1), and the one input that reaches outside the transcript.
 *
 * ## The observer's constitution, restated for this probe
 *
 * Rhizomorph observes; it never instruments, and it never writes to the
 * watched system. A liveness probe is the closest this product comes to
 * touching a process it does not own, so the rules are stricter here than
 * anywhere else and `process-probe.test.ts` states each one as a law:
 *
 * 1. **Read-only, always.** `readdir` + `readlink` + `readFile`, and nothing
 *    else — no writes, no subprocess, and deliberately **no signal-0 liveness
 *    check**. Sending signal 0 delivers nothing and is the usual POSIX idiom,
 *    but it is still a call *at* the observed process, and a recycled pid
 *    answers it happily. Reading `/proc` answers the same question by looking
 *    rather than by knocking. `process-probe.test.ts` greps this file for all
 *    three, so the rule outlives whatever this probe grows into.
 * 2. **argv-only identity.** A pid alone is not a lane. A process counts only
 *    when its argv names a known agent CLI **and** its cwd is the lane's
 *    worktree — so a recycled pid, or an unrelated shell sitting in the same
 *    directory, cannot impersonate a live agent.
 * 3. **Unknown is never death.** Every failure path — no `/proc`, an
 *    unreadable one, a platform with no equivalent — returns `null`, not
 *    `false`. `lane-state.ts` may only escalate to GONE on an explicit
 *    `false`. A missing probe degrades a lane to FROZEN, the weaker claim; it
 *    can never invent a death.
 * 4. **Other users' processes are invisible, and that is fine.** On this
 *    machine 57 of 79 pids deny `readlink(/proc/<pid>/cwd)` to a non-root
 *    reader. Every one of them belongs to another user; a lane's own agent is
 *    always the reader's own process. Denials are skipped, never fatal, and
 *    never counted as absence on their own.
 *
 * ## Platform strategy (prd15 ruling 7: verified, never assumed)
 *
 * - **Linux, and WSL2 — SHIPPED and verified here.** WSL2 runs a real Linux
 *   kernel, so `/proc` is native and complete for Linux-side processes.
 *   Verified on this machine: 79 pids enumerated, `cwd` symlink and
 *   NUL-separated `cmdline` both readable for every own-user process, agent
 *   lanes correctly identified by `claude` in argv[0] with cwd equal to the
 *   worktree path. **Known gap:** a Windows-side `claude.exe` is not visible
 *   from WSL's `/proc` at all — that is the Windows-native row below, not this
 *   one, and it reads as `null` (unknown) rather than dead.
 * - **macOS — NOT SHIPPED; strategy named.** No `/proc`. The read-only
 *   equivalent is two base-system reads: `ps -axo pid=,command=` for argv, and
 *   `lsof -a -p <pid> -d cwd -Fn` for the working directory (macOS exposes cwd
 *   only through libproc, which `lsof` wraps). Both are read-only and neither
 *   signals the target. It is not built here because ruling 7 says a platform
 *   leg lands *behind a capture*, and no macOS capture exists — a probe
 *   written from `man` pages would validate our reading of the man page, not
 *   the machine. Until then macOS gets `null`.
 * - **Windows native — NOT SHIPPED; strategy named, with a real gap.** No
 *   `/proc`. `Get-CimInstance Win32_Process` (or `tasklist /v`) yields
 *   `ProcessId` and `CommandLine` read-only, so **argv matching ports
 *   directly**; the working directory does **not** — Windows does not expose
 *   another process's cwd without native calls into the target
 *   (agnosticism spike §1: "Windows cwd is effectively inaccessible"). The
 *   honest port is therefore argv-only, matching the lane's worktree where the
 *   dispatcher put it on the command line, and declaring cwd attribution a
 *   capability the Windows probe lacks. Behind ruling 7's verification pass;
 *   `null` until then.
 */

/**
 * Per-worktree aliveness:
 *
 * - `true` — an agent process is running in (or under) this worktree.
 * - `false` — the process table was read and no such process is in it.
 * - `null` — this platform/build cannot tell. Never treated as death.
 */
export type ProcessLiveness = boolean | null

/**
 * A probe answers about **many worktrees at once**, deliberately.
 *
 * A one-lane-at-a-time signature would walk the whole process table once per
 * lane, and a long-lived repo accumulates lanes without limit — this repo
 * already has 160+. Asking the question in one batch keeps the observer's cost
 * flat in the number of lanes: one process-table read per poll, however wide
 * the fleet, and none at all when every lane is healthy (see
 * `needsProcessProbe` in `lane-state.ts`).
 */
export interface ProcessProbe {
  /** Stable name, for the evidence string a reading carries. */
  readonly name: string
  /**
   * Answers for exactly the worktrees asked about. Every requested path
   * appears in the result; an unmentioned one was never asked.
   */
  probe(worktreePaths: readonly string[]): Promise<Map<string, ProcessLiveness>>
}

/**
 * Agent CLI executables a lane may be running. argv[0]'s basename is matched
 * against this set. `codex` and `pi` are named here — not as built adapters
 * (their *grammars* are later waves) but because a lane running one of them is
 * still a live process, and refusing to see it would fabricate a death.
 */
export const AGENT_COMMANDS = ['claude', 'codex', 'pi'] as const

export interface ProcProcessProbeOptions {
  /** Overridable so tests can point at a fabricated procfs. Never written to. */
  procRoot?: string
  /** argv[0] basenames that count as an agent. Defaults to {@link AGENT_COMMANDS}. */
  commands?: readonly string[]
}

/** True when `candidate` is `root` itself or lives underneath it. */
function isWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * The `/proc` probe (Linux + WSL2). Enumerates numeric entries, reads each
 * one's cwd symlink and NUL-separated argv, and answers whether any of them is
 * an agent CLI running in (or under) `worktreePath`.
 *
 * A lane's agent frequently runs from a subdirectory of its worktree, so
 * "under" counts — but never the other way round: a conductor sitting in the
 * repo root must not be read as every lane's process.
 */
export function createProcProcessProbe(options: ProcProcessProbeOptions = {}): ProcessProbe {
  const procRoot = options.procRoot ?? '/proc'
  const commands = new Set(options.commands ?? AGENT_COMMANDS)

  return {
    name: `proc(${procRoot})`,

    async probe(worktreePaths: readonly string[]): Promise<Map<string, ProcessLiveness>> {
      const wanted = [...new Set(worktreePaths)]
      if (wanted.length === 0) return new Map()

      let entries: string[]
      try {
        entries = await readdir(procRoot)
      } catch {
        // No procfs on this platform, or it is unreadable. Unknown, not dead.
        return unknownFor(wanted)
      }

      const pids = entries.filter((entry) => /^\d+$/.test(entry))
      // An empty or non-numeric listing is not a process table — something
      // other than procfs is mounted here. Refuse to call that "no agent".
      if (pids.length === 0) return unknownFor(wanted)

      // Absence is the default only once the table has actually been read.
      const result = new Map<string, ProcessLiveness>(wanted.map((wt) => [wt, false]))

      for (const pid of pids) {
        let cwd: string
        try {
          cwd = await readlink(path.join(procRoot, pid, 'cwd'))
        } catch {
          continue // exited between readdir and readlink, or another user's.
        }

        const matches = wanted.filter((worktreePath) => isWithin(cwd, worktreePath))
        if (matches.length === 0) continue

        let cmdline: string
        try {
          cmdline = await readFile(path.join(procRoot, pid, 'cmdline'), 'utf8')
        } catch {
          continue
        }

        // procfs writes argv NUL-separated, with a trailing NUL. Splitting on
        // it is the whole of "argv-only": no shell string is ever reassembled,
        // so no quoting or NUL byte escapes this function.
        const argv = cmdline.split('\0').filter((part) => part.length > 0)
        const command = argv[0]
        if (command === undefined || !commands.has(path.basename(command))) continue

        for (const worktreePath of matches) result.set(worktreePath, true)
      }

      return result
    },
  }
}

function unknownFor(worktreePaths: readonly string[]): Map<string, ProcessLiveness> {
  return new Map(worktreePaths.map((worktreePath) => [worktreePath, null]))
}

/**
 * The probe for a platform this build cannot read (macOS, Windows native, or
 * any Linux where `/proc` is not mounted). Answers `null` to everything: the
 * state machine then never reaches GONE, and a stalled lane reads FROZEN —
 * true, weaker, and honest, which is the whole point.
 */
export const UNKNOWN_PROCESS_PROBE: ProcessProbe = {
  name: 'unknown',
  probe: async (worktreePaths) => unknownFor(worktreePaths),
}

/**
 * The probe this collector uses when the operator has not supplied one:
 * `/proc` where it exists, an honest `null` everywhere else. Chosen by
 * platform rather than by trying and failing, so a macOS boot does not pay for
 * a doomed `readdir` on every poll.
 */
export function defaultProcessProbe(platform: NodeJS.Platform = process.platform): ProcessProbe {
  return platform === 'linux' ? createProcProcessProbe() : UNKNOWN_PROCESS_PROBE
}
