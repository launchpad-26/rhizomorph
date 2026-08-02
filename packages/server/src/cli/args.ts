import { AGENT_ROLES, DEFAULT_FLATLINE_MS, type AgentRole } from '@rhizomorph/core'
import { RESUME_WINDOW_MS } from '../log/session-log.js'

export interface CliArgs {
  /** Target repo path, or undefined to default to cwd. */
  path: string | undefined
  port: number
  /** Flatline threshold in minutes, passed through to the liveness selector's callers. */
  flatlineMinutes: number
  /** Collector poll cadence in ms. */
  pollIntervalMs: number
  /**
   * Extra session sources to tail (`--extra-sessions <path>[:<lane>]`,
   * repeatable) — for a conductor on a foreign filesystem, e.g.
   * `/mnt/c/Users/<u>/.claude/projects/<slug>` (the session-log dir itself,
   * mounted). Passed through as raw `<path>[:<lane>]` strings; the
   * sessionlog collector resolves each dir-first (session dir directly, then
   * cwd-slug fallback), attributes these `role: conductor`, and labels the
   * lane `conductor`/`conductor-2`/… when no explicit `:<lane>` is given.
   */
  extraSessionDirs: string[]
  /**
   * True when `--fresh` was passed: start a brand-new session even if the most
   * recent one is young enough to continue. Default (false) is to resume — see
   * `RESUME_WINDOW_MS`.
   */
  fresh: boolean
  /**
   * True when `--backfill` was passed: the sessionlog collector reads each log
   * from its beginning instead of starting at end-of-file, ingesting history on
   * purpose rather than by accident.
   */
  backfill: boolean
  /** True when `--help`/`-h` was passed; other fields are defaults and should be ignored. */
  help: boolean
  /** True when `--version` was passed; other fields are defaults and should be ignored. */
  version: boolean
}

export const DEFAULT_PORT = 4321
const DEFAULT_FLATLINE_MINUTES = DEFAULT_FLATLINE_MS / 60_000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MIN_POLL_INTERVAL_MS = 250
const DEFAULT_ROLE: AgentRole = 'worker'
/** Only for the help text — the boundary itself lives in one place, `RESUME_WINDOW_MS`. */
const RESUME_WINDOW_HOURS = RESUME_WINDOW_MS / 3_600_000

interface FlagSpec {
  flag: string
  read: (value: string | undefined) => void
  /**
   * True for a valueless switch: `--fresh` sets it and the *next* argv token is
   * left alone. Without this a switch would swallow the token after it, so
   * `rhizomorph --fresh /repo` would lose the path.
   */
  boolean?: boolean
}

/**
 * Walks argv once, dispatching recognised `--flag`/`--flag=value` tokens to
 * their spec's `read` and collecting everything else as positionals (in
 * order — callers decide how many they need). `--` ends flag parsing, same
 * as any POSIX tool. An unrecognised `-`-prefixed token throws, naming the
 * flag, so a typo fails loudly instead of booting with a silently-ignored
 * default.
 */
function parseFlags(argv: readonly string[], specs: readonly FlagSpec[]): string[] {
  const positionals: string[] = []
  let sawDoubleDash = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (!sawDoubleDash && arg === '--') {
      sawDoubleDash = true
      continue
    }

    if (!sawDoubleDash && arg.startsWith('-')) {
      const spec = specs.find((s) => arg === s.flag || arg.startsWith(`${s.flag}=`))
      if (spec) {
        if (spec.boolean) {
          // `--fresh=anything` is a typo, not a value: say so rather than
          // quietly treating the switch as set (or unset).
          if (arg !== spec.flag) throw new Error(`option "${spec.flag}" takes no value`)
          spec.read(undefined)
          continue
        }
        if (arg === spec.flag) {
          spec.read(argv[i + 1])
          i += 1
        } else {
          spec.read(arg.slice(spec.flag.length + 1))
        }
        continue
      }

      // Unknown flag (including misspellings like "--prot"): fail loudly instead
      // of silently ignoring it and booting with whatever default the flag was
      // meant to override. The CLI boundary (runCli) is responsible for
      // appending the usage table before printing this to the user — keep this
      // message on its own.
      const flagName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
      throw new Error(`unknown option: "${flagName}"`)
    }

    positionals.push(arg)
  }

  return positionals
}

function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value)
}

/**
 * Parses `rhizomorph [path] [--port <n>] [--flatline-minutes <n>]
 * [--poll-interval <ms>] [--extra-sessions <path>[:<lane>]]... [--fresh]
 * [--backfill] [--version] [--help]`.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      path: undefined,
      port: DEFAULT_PORT,
      flatlineMinutes: DEFAULT_FLATLINE_MINUTES,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      extraSessionDirs: [],
      fresh: false,
      backfill: false,
      help: true,
      version: false,
    }
  }

  if (argv.includes('--version')) {
    return {
      path: undefined,
      port: DEFAULT_PORT,
      flatlineMinutes: DEFAULT_FLATLINE_MINUTES,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      extraSessionDirs: [],
      fresh: false,
      backfill: false,
      help: false,
      version: true,
    }
  }

  let portArg: string | undefined
  let flatlineArg: string | undefined
  let pollIntervalArg: string | undefined
  let fresh = false
  let backfill = false
  const extraSessionRawValues: Array<string | undefined> = []

  const specs: FlagSpec[] = [
    { flag: '--port', read: (v) => { portArg = v } },
    { flag: '--flatline-minutes', read: (v) => { flatlineArg = v } },
    { flag: '--poll-interval', read: (v) => { pollIntervalArg = v } },
    { flag: '--extra-sessions', read: (v) => { extraSessionRawValues.push(v) } },
    { flag: '--fresh', boolean: true, read: () => { fresh = true } },
    { flag: '--backfill', boolean: true, read: () => { backfill = true } },
  ]

  const positionals = parseFlags(argv, specs)
  const path = positionals[0]

  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg)
  // 0 is a legitimate value ("let the OS pick a free port"), used by tests.
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid --port value: "${portArg}" (must be a non-negative integer)`)
  }

  const flatlineMinutes = flatlineArg === undefined ? DEFAULT_FLATLINE_MINUTES : Number(flatlineArg)
  if (!Number.isFinite(flatlineMinutes) || flatlineMinutes <= 0) {
    throw new Error(`invalid --flatline-minutes value: "${flatlineArg}" (must be a positive number)`)
  }

  const pollIntervalMs = pollIntervalArg === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(pollIntervalArg)
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < MIN_POLL_INTERVAL_MS) {
    throw new Error(
      `invalid --poll-interval value: "${pollIntervalArg}" (must be a number >= ${MIN_POLL_INTERVAL_MS}ms)`,
    )
  }

  const extraSessionDirs = extraSessionRawValues.map((raw) => {
    if (raw === undefined || raw.trim().length === 0) {
      throw new Error('invalid --extra-sessions value: (must be a non-empty directory path)')
    }
    return raw
  })

  return { path, port, flatlineMinutes, pollIntervalMs, extraSessionDirs, fresh, backfill, help: false, version: false }
}

/** Parses `rhizomorph env <lane> [--role <role>] [--port <n>] [--help]`. */
export interface EnvArgs {
  lane: string
  role: AgentRole
  port: number
  help: boolean
}

/** `rhizomorph env`'s own usage table, distinct from the main command's. */
export function envHelpText(): string {
  return `rhizomorph env <lane> [options]

Prints the exact environment block a lane (or conductor) needs to export
telemetry to this Rhizomorph's OTLP receiver.

Arguments:
  lane                    Lane handle (workmux worktree/branch name, or "conductor")

Options:
  --role <role>           ${AGENT_ROLES.join(' | ')} (default: ${DEFAULT_ROLE})
  --port <n>              Rhizomorph server port to target (default: ${DEFAULT_PORT})
  --help, -h              Show this help and exit
`
}

export function parseEnvArgs(argv: readonly string[]): EnvArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { lane: '', role: DEFAULT_ROLE, port: DEFAULT_PORT, help: true }
  }

  let roleArg: string | undefined
  let portArg: string | undefined

  const specs: FlagSpec[] = [
    { flag: '--role', read: (v) => { roleArg = v } },
    { flag: '--port', read: (v) => { portArg = v } },
  ]

  const positionals = parseFlags(argv, specs)
  const lane = positionals[0]
  if (lane === undefined || lane.trim().length === 0) {
    throw new Error('missing required argument: <lane>')
  }

  const role = roleArg === undefined ? DEFAULT_ROLE : roleArg
  if (!isAgentRole(role)) {
    throw new Error(`invalid --role value: "${roleArg}" (must be one of ${AGENT_ROLES.join(', ')})`)
  }

  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg)
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid --port value: "${portArg}" (must be a non-negative integer)`)
  }

  return { lane, role, port, help: false }
}

/** `--help` output: every flag, with its default shown. */
export function helpText(): string {
  return `rhizomorph [path] [options]
rhizomorph doctor [path] [options]   Read-only preflight — say what's missing and how to fix it
rhizomorph env <lane> [options]      Print the telemetry env block for a lane

Runs a live, replayable dashboard for a git-worktree agent swarm.

Arguments:
  path                    Repo to watch (default: current directory)

Options:
  --port <n>              Port to listen on (default: ${DEFAULT_PORT})
  --flatline-minutes <n>  Minutes of silence before an agent is flatlined (default: ${DEFAULT_FLATLINE_MINUTES})
  --poll-interval <ms>    Collector poll cadence in ms (default: ${DEFAULT_POLL_INTERVAL_MS}, minimum: ${MIN_POLL_INTERVAL_MS})
  --extra-sessions <path>[:<lane>]
                          Foreign session-log dir to tail as a conductor (repeatable).
                          <path> is the dir of *.jsonl itself; if it has none, it falls
                          back to cwd-slug inference like today. <lane> defaults to
                          "conductor" for the first one, "conductor-2", "conductor-3"…
                          for the rest — never the raw project-dir slug.
  --fresh                 Start a new session instead of resuming. By default a boot
                          continues the most recent session for this repo when its newest
                          event is under ${RESUME_WINDOW_HOURS}h old — same file, same collector offsets,
                          no duplicated history.
  --backfill              Read session logs from the beginning instead of starting at
                          end-of-file: ingest history on purpose. Expect a large
                          first tick and old timestamps.
  --version               Print the installed rhizomorph version and exit
  --help, -h              Show this help and exit

Run 'rhizomorph doctor --help' or 'rhizomorph env --help' for a subcommand's own options.
`
}

/** Parses `rhizomorph doctor [path] [--port <n>] [--help]`. */
export interface DoctorArgs {
  path: string | undefined
  port: number
  help: boolean
}

/** `rhizomorph doctor`'s own usage table, distinct from the main command's. */
export function doctorHelpText(): string {
  return `rhizomorph doctor [path] [options]

Read-only preflight: checks the Node version, the target path (exists and is
a git repo), the web build, whether the port is free, Claude Code session
logs, tmux/workmux presence, and telemetry env — one ok/warn/FAIL line per
check, each with its remedy. Exits non-zero only when the app genuinely
cannot run (bad path, not a repo, no web build, port taken).

Arguments:
  path                    Repo to check (default: current directory)

Options:
  --port <n>              Port to check for availability (default: ${DEFAULT_PORT})
  --help, -h              Show this help and exit
`
}

export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { path: undefined, port: DEFAULT_PORT, help: true }
  }

  let portArg: string | undefined
  const specs: FlagSpec[] = [{ flag: '--port', read: (v) => { portArg = v } }]

  const positionals = parseFlags(argv, specs)
  const path = positionals[0]

  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg)
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid --port value: "${portArg}" (must be a non-negative integer)`)
  }

  return { path, port, help: false }
}
