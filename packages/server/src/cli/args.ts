import { AGENT_ROLES, DEFAULT_FLATLINE_MS, type AgentRole } from '@observatory/core'

export interface CliArgs {
  /** Target repo path, or undefined to default to cwd. */
  path: string | undefined
  port: number
  /** Flatline threshold in minutes, passed through to the liveness selector's callers. */
  flatlineMinutes: number
  /** Collector poll cadence in ms. */
  pollIntervalMs: number
  /**
   * Extra worktree-shaped session dirs to tail (`--extra-sessions`,
   * repeatable) — for a conductor on a foreign filesystem, e.g.
   * `/mnt/c/Users/<u>/.claude/projects/<slug>`. Fed to the sessionlog
   * collector, which attributes these `role: conductor`.
   */
  extraSessionDirs: string[]
  /** True when `--help`/`-h` was passed; other fields are defaults and should be ignored. */
  help: boolean
}

export const DEFAULT_PORT = 4321
const DEFAULT_FLATLINE_MINUTES = DEFAULT_FLATLINE_MS / 60_000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MIN_POLL_INTERVAL_MS = 250
const DEFAULT_ROLE: AgentRole = 'worker'

interface FlagSpec {
  flag: string
  read: (value: string | undefined) => void
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
        if (arg === spec.flag) {
          spec.read(argv[i + 1])
          i += 1
        } else {
          spec.read(arg.slice(spec.flag.length + 1))
        }
        continue
      }

      // Unknown flag (including misspellings like "--prot" and "--version", which
      // this CLI doesn't support): fail loudly instead of silently ignoring it and
      // booting with whatever default the flag was meant to override. The CLI
      // boundary (runCli) is responsible for appending the usage table before
      // printing this to the user — keep this message on its own.
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
 * Parses `observatory [path] [--port <n>] [--flatline-minutes <n>]
 * [--poll-interval <ms>] [--extra-sessions <dir>]... [--help]`.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      path: undefined,
      port: DEFAULT_PORT,
      flatlineMinutes: DEFAULT_FLATLINE_MINUTES,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      extraSessionDirs: [],
      help: true,
    }
  }

  let portArg: string | undefined
  let flatlineArg: string | undefined
  let pollIntervalArg: string | undefined
  const extraSessionRawValues: Array<string | undefined> = []

  const specs: FlagSpec[] = [
    { flag: '--port', read: (v) => { portArg = v } },
    { flag: '--flatline-minutes', read: (v) => { flatlineArg = v } },
    { flag: '--poll-interval', read: (v) => { pollIntervalArg = v } },
    { flag: '--extra-sessions', read: (v) => { extraSessionRawValues.push(v) } },
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

  return { path, port, flatlineMinutes, pollIntervalMs, extraSessionDirs, help: false }
}

/** Parses `observatory env <lane> [--role <role>] [--port <n>] [--help]`. */
export interface EnvArgs {
  lane: string
  role: AgentRole
  port: number
  help: boolean
}

/** `observatory env`'s own usage table, distinct from the main command's. */
export function envHelpText(): string {
  return `observatory env <lane> [options]

Prints the exact environment block a lane (or conductor) needs to export
telemetry to this Observatory's OTLP receiver.

Arguments:
  lane                    Lane handle (workmux worktree/branch name, or "conductor")

Options:
  --role <role>           ${AGENT_ROLES.join(' | ')} (default: ${DEFAULT_ROLE})
  --port <n>              Observatory server port to target (default: ${DEFAULT_PORT})
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
  return `observatory [path] [options]
observatory env <lane> [options]   Print the telemetry env block for a lane

Runs a live, replayable dashboard for a git-worktree agent swarm.

Arguments:
  path                    Repo to watch (default: current directory)

Options:
  --port <n>              Port to listen on (default: ${DEFAULT_PORT})
  --flatline-minutes <n>  Minutes of silence before an agent is flatlined (default: ${DEFAULT_FLATLINE_MINUTES})
  --poll-interval <ms>    Collector poll cadence in ms (default: ${DEFAULT_POLL_INTERVAL_MS}, minimum: ${MIN_POLL_INTERVAL_MS})
  --extra-sessions <dir>  Extra Claude session-log dir to tail as a conductor (repeatable)
  --help, -h              Show this help and exit

Run 'observatory env --help' for the env-block subcommand's own options.
`
}
