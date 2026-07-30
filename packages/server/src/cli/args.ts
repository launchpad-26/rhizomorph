import { DEFAULT_FLATLINE_MS } from '@observatory/core'

export interface CliArgs {
  /** Target repo path, or undefined to default to cwd. */
  path: string | undefined
  port: number
  /** Flatline threshold in minutes, passed through to the liveness selector's callers. */
  flatlineMinutes: number
  /** Collector poll cadence in ms. */
  pollIntervalMs: number
  /** True when `--help`/`-h` was passed; other fields are defaults and should be ignored. */
  help: boolean
}

const DEFAULT_PORT = 4321
const DEFAULT_FLATLINE_MINUTES = DEFAULT_FLATLINE_MS / 60_000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MIN_POLL_INTERVAL_MS = 250

interface FlagSpec {
  flag: string
  read: (value: string | undefined) => void
}

/** Parses `observatory [path] [--port <n>] [--flatline-minutes <n>] [--poll-interval <ms>] [--help]`. */
export function parseArgs(argv: readonly string[]): CliArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      path: undefined,
      port: DEFAULT_PORT,
      flatlineMinutes: DEFAULT_FLATLINE_MINUTES,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      help: true,
    }
  }

  let path: string | undefined
  let portArg: string | undefined
  let flatlineArg: string | undefined
  let pollIntervalArg: string | undefined

  const specs: FlagSpec[] = [
    { flag: '--port', read: (v) => { portArg = v } },
    { flag: '--flatline-minutes', read: (v) => { flatlineArg = v } },
    { flag: '--poll-interval', read: (v) => { pollIntervalArg = v } },
  ]

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue

    const spec = specs.find((s) => arg === s.flag || arg.startsWith(`${s.flag}=`))
    if (spec) {
      if (arg === spec.flag) {
        spec.read(argv[i + 1])
        i += 1
      } else {
        spec.read(arg.slice(spec.flag.length + 1))
      }
    } else if (!arg.startsWith('-') && path === undefined) {
      path = arg
    }
  }

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

  return { path, port, flatlineMinutes, pollIntervalMs, help: false }
}

/** `--help` output: every flag, with its default shown. */
export function helpText(): string {
  return `observatory [path] [options]

Runs a live, replayable dashboard for a git-worktree agent swarm.

Arguments:
  path                    Repo to watch (default: current directory)

Options:
  --port <n>              Port to listen on (default: ${DEFAULT_PORT})
  --flatline-minutes <n>  Minutes of silence before an agent is flatlined (default: ${DEFAULT_FLATLINE_MINUTES})
  --poll-interval <ms>    Collector poll cadence in ms (default: ${DEFAULT_POLL_INTERVAL_MS}, minimum: ${MIN_POLL_INTERVAL_MS})
  --help, -h              Show this help and exit
`
}
