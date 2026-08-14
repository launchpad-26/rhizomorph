import { access, readFile, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { matchesAgentCommand, processProbeCapability } from '../../collectors/sessionlog/process-probe.js'
import type { DetectOptions, HarnessDetection, HarnessId, HarnessPresence } from './types.js'

/**
 * Harness detection, in three states — prd-20 ruling 4's detection half, and
 * the place this lane is most likely to lie if it is careless.
 *
 * Two independent questions, answered separately because their platform
 * stories are completely different:
 *
 * 1. **Is there an executable file this hand could launch?** A pure filesystem
 *    walk of `PATH`. This works on every platform, including the ones with no
 *    `/proc`, so a macOS operator still gets a real answer to the question the
 *    picker actually needs.
 * 2. **Is one running?** A process-table read. That is `/proc`-only in this
 *    build, so on macOS and Windows the answer is `unknown` **with a named
 *    reason** — never `absent`. And on Linux, `absent` is reached only from a
 *    process table that was read in FULL: one entry that refused to say what it
 *    is could be the harness, so a partial read is `unknown` too.
 *
 * ## The argv matcher is the probe's, not a second copy
 *
 * `matchesAgentCommand` lives in `collectors/sessionlog/process-probe.ts` and is
 * imported rather than reimplemented here. The direction matters: the probe may
 * never import from the concierge (the namespace law's clause 1 forbids anything
 * outside this module reaching in), so the shared rule belongs in the file that
 * already owns reading the process table, and this hand borrows it. Both callers
 * then answer "is an agent in this argv" the same way, which is the point — the
 * two answering differently is what let an interpreter-launched lane read as
 * dead to one and alive to the other.
 *
 * ## `installed` and `launchable` are not the same question
 *
 * On Windows an npm-installed CLI is a `.cmd` shim, and Node cannot spawn a
 * `.bat`/`.cmd` without a shell — which ADR-0019 clause 4 forbids this hand.
 * Such a file is therefore found, reported with its path, and reported as
 * `installed-not-launchable`: neither the false `absent` ("your CLI is not
 * installed") nor the false `present` (a launch the launch path cannot
 * perform). See {@link SHELL_ONLY_EXTENSIONS}.
 *
 * ## Why PATH detection reads the filesystem instead of asking a shell
 *
 * `which`/`command -v` would answer a *different and wrong* question. ADR-0019
 * clause 4 forbids this hand a shell: when the launch power lands it passes an
 * argv array or it does not launch at all. A shell alias or shell function is
 * therefore something the concierge **cannot start**, however happily the
 * operator types it — so "is there an executable file on PATH" is precisely the
 * question whose answer the launcher can act on, and asking a shell would
 * report launchable things that are not.
 *
 * That is not hypothetical: on the machine this lane was written on, `pi`
 * resolves to a shell function and has no executable file on `PATH` at all. The
 * `absent` evidence string below says so in those words, so the picker reports
 * "no executable file on PATH" rather than the false and insulting "not
 * installed".
 *
 * Reading the filesystem also keeps clause 3 (no clock) free: a subprocess
 * would want a timeout, and a timeout is a thing this module may not own.
 *
 * ## Never resolved from the working directory
 *
 * Empty and relative `PATH` entries are skipped. POSIX reads an empty entry as
 * the current directory, and this hand's current directory may be the *watched
 * repo* — resolving an executable from there would let a file inside somebody's
 * working tree become the thing the concierge launches. That is a launch-power
 * hole, not a tidiness point.
 */

/**
 * Windows' default executable extensions when `PATHEXT` says nothing.
 *
 * All four are SEARCHED, including `.BAT` and `.CMD` — and the two groups are
 * then reported differently, which is the whole point of
 * {@link SHELL_ONLY_EXTENSIONS}.
 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * The extensions Node cannot spawn without a shell — and therefore the ones
 * this hand cannot launch at all.
 *
 * `child_process.spawn` cannot start a `.bat` or `.cmd` directly: it needs
 * `shell: true` or an explicit `cmd.exe /c`
 * (nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
 * ADR-0019 clause 4 forbids this hand a shell, so a `.cmd` on `PATH` is a file
 * this hand structurally cannot start.
 *
 * They are still SEARCHED rather than dropped, because on Windows this is the
 * NORMAL shape rather than an exotic one — an npm-installed CLI on Windows *is*
 * a `.cmd` shim — so `absent` would tell an operator their installed CLI is not
 * installed. The honest answer is the fourth state:
 * `installed-not-launchable`, with the file named and clause 4 as the reason.
 * The same shape pi already uses: "installed, and this instrument cannot
 * instrument it" is two true statements.
 */
const SHELL_ONLY_EXTENSIONS: ReadonlySet<string> = new Set(['.BAT', '.CMD'])

/** `.CMD` and `.cmd` are the same file on Windows, so the test is on the case-folded suffix. */
function needsAShellToStart(candidate: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false
  return SHELL_ONLY_EXTENSIONS.has(path.extname(candidate).toUpperCase())
}

/** The `PATH` separator of the TARGET platform, not the host's — so a simulated platform is really simulated. */
function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

/** `PATH` is case-insensitive on Windows, where the real spelling is often `Path`. */
function readPathVar(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env.PATH
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path')
  return key === undefined ? undefined : env[key]
}

function executableNames(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [command]
  const pathext = Object.keys(env).find((name) => name.toLowerCase() === 'pathext')
  const extensions = (pathext === undefined ? DEFAULT_PATHEXT : (env[pathext] ?? DEFAULT_PATHEXT))
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
  // The bare name too: a Windows install may ship an extensionless shim.
  return [...extensions.map((extension) => `${command}${extension}`), command]
}

/**
 * Is `candidate` a *file* this hand could hand to an argv-array launch?
 *
 * `X_OK` is meaningful on POSIX and not on Windows, where executability is
 * carried by the extension — so Windows asks only whether the file is there,
 * which is why {@link executableNames} does the `PATHEXT` work instead.
 *
 * **The `stat`/`isFile` check is not tidiness.** `access(dir, X_OK)` succeeds
 * for any *searchable* directory on POSIX, and `F_OK` succeeds for any existing
 * object at all on Windows — so a DIRECTORY named `claude` in a `PATH` entry
 * would otherwise be reported `present`, with an `executablePath` pointing at
 * something no spawn can ever run. A symlink to an executable is still a file
 * here, because `stat` follows symlinks.
 */
async function isLaunchableFile(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const stats = await stat(candidate)
    if (!stats.isFile()) return false
    await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Is there an executable file named `command` on `PATH`?
 *
 * Three outcomes, and the `unknown` one is real rather than defensive: an
 * environment with no `PATH` at all has not told us the harness is missing, it
 * has told us nothing.
 */
export async function detectOnPath(command: string, options: DetectOptions = {}): Promise<HarnessPresence> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const rawPath = readPathVar(env, platform)

  if (rawPath === undefined || rawPath.trim().length === 0) {
    return {
      state: 'unknown',
      reason: `this environment has no PATH, so whether ${command} is installed cannot be read from it`,
      remedy: 'launch the server from a shell with a normal PATH, or hand the concierge an explicit executable path',
    }
  }

  const entries = rawPath.split(pathDelimiter(platform))
  const names = executableNames(command, env, platform)
  // Skipped, not searched — see the module comment: an empty entry means the
  // working directory, which may be the watched repo.
  const searchable = entries.filter((entry) => entry.length > 0 && path.isAbsolute(entry))

  if (searchable.length === 0) {
    return {
      state: 'unknown',
      reason: `PATH holds no absolute directory to search, so whether ${command} is installed cannot be read from it`,
      remedy: 'relative and empty PATH entries are deliberately not searched, because they resolve against the cwd',
    }
  }

  // A shell-only shim found early must not shadow a real executable found later
  // on PATH: the launchable answer always wins, so the first shim is reported
  // only once the whole search has produced nothing better.
  let shellOnly: string | undefined

  for (const entry of searchable) {
    for (const name of names) {
      const candidate = path.join(entry, name)
      if (!(await isLaunchableFile(candidate, platform))) continue
      if (needsAShellToStart(candidate, platform)) {
        shellOnly ??= candidate
        continue
      }
      return { state: 'present', evidence: `an executable file on PATH at ${candidate}`, executablePath: candidate }
    }
  }

  if (shellOnly !== undefined) {
    return {
      state: 'installed-not-launchable',
      foundAt: shellOnly,
      evidence: `${command} is installed on PATH at ${shellOnly}`,
      reason:
        `${path.extname(shellOnly)} is a Windows shell script: Node cannot spawn one without a shell (it needs ` +
        'the spawn shell option, or an explicit `cmd.exe /c`), and ADR-0019 clause 4 forbids this hand a shell. So it is ' +
        'genuinely installed and this hand genuinely cannot start it — reporting it as launchable would promise ' +
        'something the launch path structurally cannot do',
      remedy:
        `start ${command} yourself and let the running-process detection find it, or point the concierge at a ` +
        `native executable (.EXE/.COM) for ${command} if one is installed`,
    }
  }

  return {
    state: 'absent',
    evidence:
      `no executable file named ${command} in any of the ${searchable.length} absolute PATH directories searched. ` +
      'A shell alias or shell function of that name is deliberately not counted: this hand launches an argv array ' +
      'and never a shell (ADR-0019 clause 4), so it could not start one.',
  }
}

/**
 * Is a `command` process running?
 *
 * `/proc` where it exists; a named `unknown` everywhere else. The mapping that
 * matters is in the first branch: a process-probe *capability* of `absent`
 * means "this build cannot see", and it becomes a **reading of `unknown`**, not
 * a reading of `absent`. Collapsing those two is the specific failure that
 * makes the picker lie, and `detect.test.ts` asserts it cannot happen.
 */
export async function detectRunning(command: string, options: DetectOptions = {}): Promise<HarnessPresence> {
  const platform = options.platform ?? process.platform
  const capability = processProbeCapability(platform)

  if (capability.level !== 'provided') {
    return { state: 'unknown', reason: capability.reason, remedy: capability.remedy }
  }

  const procRoot = options.procRoot ?? '/proc'
  let entries: string[]
  try {
    entries = await readdir(procRoot)
  } catch {
    return {
      state: 'unknown',
      reason: `the process table at ${procRoot} could not be read, so whether ${command} is running is not known`,
    }
  }

  const pids = entries.filter((entry) => /^\d+$/.test(entry))
  if (pids.length === 0) {
    // An empty or non-numeric listing is not a process table. Refusing to call
    // that "nothing is running" is the same judgement `process-probe.ts` makes.
    return {
      state: 'unknown',
      reason: `${procRoot} holds no numeric entries, so it is not a process table this build can read`,
    }
  }

  let readable = 0
  // Counted separately from the exited ones, because they are two different
  // events with different consequences — see the `denied > 0` branch below.
  let denied = 0
  for (const pid of pids) {
    let cmdline: string
    try {
      cmdline = await readFile(path.join(procRoot, pid, 'cmdline'), 'utf8')
    } catch (err) {
      // ENOENT: the process exited between the listing and the read. Genuinely
      // nothing to report — it is not running because it is not there.
      // Anything else (EACCES/EPERM in practice): a process IS there and would
      // not say what it is. That is a blind spot, and it must not be counted as
      // a process this reader has cleared.
      if (errorCode(err) !== 'ENOENT') denied += 1
      continue
    }
    readable += 1

    // NUL-separated argv, exactly as procfs writes it. No shell string is ever
    // reassembled, so no quoting and no NUL byte escapes this function.
    const argv = cmdline.split('\0').filter((part) => part.length > 0)
    if (matchesAgentCommand(argv, new Set([command]))) {
      return { state: 'present', evidence: `pid ${pid} in ${procRoot} has ${command} in its argv` }
    }
  }

  if (denied > 0) {
    // The partial read — and the reason this is `unknown` rather than `absent`.
    //
    // A readable non-target process is not evidence about the TARGET. If even
    // one process refused to say what it is, that process could be the harness,
    // so "none of the ones that answered is claude" is true and is NOT an answer
    // to "is claude running". Falling through to `absent` here would be the
    // false negative this whole lane forbids: the picker would offer to relaunch
    // a conductor that is already running. On any multi-user box — or any box
    // with a root daemon — a denied /proc entry is the COMMON case rather than a
    // rare one, so `readable === 0` was far too weak a guard: it caught total
    // blindness only, and never the partial blindness that actually happens.
    return {
      state: 'unknown',
      reason:
        `${denied} of the ${pids.length} processes in ${procRoot} would not reveal its argv to this reader, so ` +
        `whether one of them is ${command} is not known — ${readable} were read and none of those is ${command}`,
      remedy:
        'read the process table as the user that owns the harness process, or as root, so every argv is visible',
    }
  }

  if (readable === 0) {
    // Every pid in the listing had exited before it could be read: there is no
    // table left to conclude anything from — `process-probe.ts` rule 4 makes the
    // same call. (A table that DENIED us is the branch above.)
    return {
      state: 'unknown',
      reason: `none of the ${pids.length} processes in ${procRoot} would reveal its argv to this reader`,
    }
  }

  return {
    state: 'absent',
    evidence: `${readable} of ${pids.length} processes in ${procRoot} were readable and none is ${command}`,
  }
}

/** An errno off an unknown caught value, without asserting a shape it may not have. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Both questions, for one harness. The shape every adapter's `detect` returns. */
export async function detectHarness(
  harness: HarnessId,
  command: string,
  options: DetectOptions = {},
): Promise<HarnessDetection> {
  const [onPath, running] = await Promise.all([detectOnPath(command, options), detectRunning(command, options)])
  return { harness, onPath, running }
}
