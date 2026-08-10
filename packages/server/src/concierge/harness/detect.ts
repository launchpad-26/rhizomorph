import { access, readFile, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { processProbeCapability } from '../../collectors/sessionlog/process-probe.js'
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
 *    reason** — never `absent`.
 *
 * ## Why PATH detection reads the filesystem instead of asking a shell
 *
 * `which`/`command -v` would answer a *different and wrong* question. ADR-0014
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

/** Interpreters that front a JS/Python CLI, where the real name is argv[1]. */
const INTERPRETERS = new Set(['node', 'node.exe', 'bun', 'deno', 'python', 'python3'])

/** Windows' default executable extensions when `PATHEXT` says nothing. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

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
 * Is `candidate` a file this hand could hand to an argv-array launch?
 *
 * `X_OK` is meaningful on POSIX and not on Windows, where executability is
 * carried by the extension — so Windows asks only whether the file is there,
 * which is why {@link executableNames} does the `PATHEXT` work instead.
 */
async function isLaunchable(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
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

  for (const entry of searchable) {
    for (const name of names) {
      const candidate = path.join(entry, name)
      if (await isLaunchable(candidate, platform)) {
        return { state: 'present', evidence: `an executable file on PATH at ${candidate}`, executablePath: candidate }
      }
    }
  }

  return {
    state: 'absent',
    evidence:
      `no executable file named ${command} in any of the ${searchable.length} absolute PATH directories searched. ` +
      'A shell alias or shell function of that name is deliberately not counted: this hand launches an argv array ' +
      'and never a shell (ADR-0014 clause 4), so it could not start one.',
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
  for (const pid of pids) {
    let cmdline: string
    try {
      cmdline = await readFile(path.join(procRoot, pid, 'cmdline'), 'utf8')
    } catch {
      continue // exited between the listing and the read, or another user's.
    }
    readable += 1

    // NUL-separated argv, exactly as procfs writes it. No shell string is ever
    // reassembled, so no quoting and no NUL byte escapes this function.
    const argv = cmdline.split('\0').filter((part) => part.length > 0)
    if (matchesCommand(argv, command)) {
      return { state: 'present', evidence: `pid ${pid} in ${procRoot} has ${command} in its argv` }
    }
  }

  if (readable === 0) {
    // Every process denied us. That is the reader's blindness, not an answer —
    // `process-probe.ts` rule 4 makes the same call for the same reason.
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

/**
 * argv[0]'s basename, or argv[1]'s when argv[0] is an interpreter.
 *
 * The second arm exists because a false *absent* is the failure this lane
 * forbids: `claude` is frequently a JS entry point launched as
 * `node /path/to/claude`, whose argv[0] basename is `node`. Matching argv[1]
 * only behind a known interpreter keeps `vim claude` from reading as a running
 * harness, so neither error is traded for the other.
 */
function matchesCommand(argv: readonly string[], command: string): boolean {
  const first = argv[0]
  if (first === undefined) return false
  const firstName = path.basename(first)
  if (firstName === command) return true

  const second = argv[1]
  return INTERPRETERS.has(firstName) && second !== undefined && path.basename(second) === command
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
