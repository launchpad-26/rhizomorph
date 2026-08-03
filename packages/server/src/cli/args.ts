import { AGENT_ROLES, DEFAULT_FLATLINE_MS, type AgentRole } from '@rhizomorph/core'
import { RESUME_WINDOW_MS } from '../log/session-log.js'
import { ENV_SHELLS, type EnvShell } from './telemetry-env.js'

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
const DEFAULT_SHELL: EnvShell = 'sh'
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

function isEnvShell(value: string): value is EnvShell {
  return (ENV_SHELLS as readonly string[]).includes(value)
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

/** Parses `rhizomorph env <lane> [--role <role>] [--port <n>] [--shell <shell>] [--help]`. */
export interface EnvArgs {
  lane: string
  role: AgentRole
  port: number
  shell: EnvShell
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
  --shell <shell>         ${ENV_SHELLS.join(' | ')} (default: ${DEFAULT_SHELL}) — which
                          shell's assignment syntax to print (powershell:
                          $env:NAME = "value", cmd: set NAME=value)
  --help, -h              Show this help and exit
`
}

export function parseEnvArgs(argv: readonly string[]): EnvArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { lane: '', role: DEFAULT_ROLE, port: DEFAULT_PORT, shell: DEFAULT_SHELL, help: true }
  }

  let roleArg: string | undefined
  let portArg: string | undefined
  let shellArg: string | undefined

  const specs: FlagSpec[] = [
    { flag: '--role', read: (v) => { roleArg = v } },
    { flag: '--port', read: (v) => { portArg = v } },
    { flag: '--shell', read: (v) => { shellArg = v } },
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

  const shell = shellArg === undefined ? DEFAULT_SHELL : shellArg
  if (!isEnvShell(shell)) {
    throw new Error(`invalid --shell value: "${shellArg}" (must be one of ${ENV_SHELLS.join(', ')})`)
  }

  return { lane, role, port, shell, help: false }
}

/** `--help` output: every flag, with its default shown. */
export function helpText(): string {
  return `rhizomorph [path] [options]
rhizomorph doctor [path] [options]   Read-only preflight — say what's missing and how to fix it
rhizomorph env <lane> [options]      Print the telemetry env block for a lane
rhizomorph export-record [path] [options]   Write a portable session record (federation wire format)
rhizomorph replay <record-file> [options]   Serve a session record read-only, foreign or local
rhizomorph lab checkpoint <lane> [options]  Capture a live workspace + session snapshot (prd12)

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

Run 'rhizomorph doctor --help', 'rhizomorph env --help', 'rhizomorph export-record --help',
'rhizomorph replay --help' or 'rhizomorph lab checkpoint --help' for a subcommand's own options.
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

/** Parses `rhizomorph export-record [path] [--session <id>] [--out <file>] [--handle <name>] [--help]`. */
export interface ExportRecordArgs {
  path: string | undefined
  /** Session id to export; defaults to the most recently recorded one. */
  sessionId: string | undefined
  /** Output file path; defaults to alongside the session logs (see `export-record.ts`). */
  out: string | undefined
  /** Human-declared actor name; defaults to the OS username, marked `declared: false`. */
  handle: string | undefined
  help: boolean
}

/** `rhizomorph export-record`'s own usage table, distinct from the main command's. */
export function exportRecordHelpText(): string {
  return `rhizomorph export-record [path] [options]

Writes a portable, integrity-checked session record — prd11's federation wire
format — for one of this repo's recorded sessions. The artifact is written
OUTSIDE the watched repo (default: alongside its session logs), named
"<repo-slug>-<session-id>.rhizorecord.json". Hand the file to anyone; they
replay it read-only with 'rhizomorph replay <file>'.

Arguments:
  path                    Repo whose recorded sessions to read (default: current directory)

Options:
  --session <id>          Session id to export (default: the most recently recorded session)
  --out <file>            Output file path (default: alongside the session logs)
  --handle <name>         Human-declared actor name (default: the OS username, marked undeclared)
  --help, -h              Show this help and exit
`
}

export function parseExportRecordArgs(argv: readonly string[]): ExportRecordArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { path: undefined, sessionId: undefined, out: undefined, handle: undefined, help: true }
  }

  let sessionArg: string | undefined
  let outArg: string | undefined
  let handleArg: string | undefined

  const specs: FlagSpec[] = [
    { flag: '--session', read: (v) => { sessionArg = v } },
    { flag: '--out', read: (v) => { outArg = v } },
    { flag: '--handle', read: (v) => { handleArg = v } },
  ]

  const positionals = parseFlags(argv, specs)
  const path = positionals[0]

  if (sessionArg !== undefined && sessionArg.trim().length === 0) {
    throw new Error('invalid --session value: (must be a non-empty session id)')
  }
  if (outArg !== undefined && outArg.trim().length === 0) {
    throw new Error('invalid --out value: (must be a non-empty file path)')
  }
  if (handleArg !== undefined && handleArg.trim().length === 0) {
    throw new Error('invalid --handle value: (must be a non-empty name)')
  }

  return { path, sessionId: sessionArg, out: outArg, handle: handleArg, help: false }
}

/** Parses `rhizomorph replay <record-file> [--port <n>] [--help]`. */
export interface ReplayArgs {
  file: string
  port: number
  help: boolean
}

/** `rhizomorph replay`'s own usage table, distinct from the main command's. */
export function replayHelpText(): string {
  return `rhizomorph replay <record-file> [options]

Verifies a portable session record's hash chain — refusing a tampered file
loudly — then serves it read-only through the same dashboard the live
command uses: a foreign actor's record renders exactly as a local recording
does. Nothing is executed and nothing is written back into the record.

Arguments:
  record-file             Path to a '.rhizorecord.json' file written by 'rhizomorph export-record'

Options:
  --port <n>              Port to listen on (default: ${DEFAULT_PORT})
  --help, -h              Show this help and exit
`
}

export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { file: '', port: DEFAULT_PORT, help: true }
  }

  let portArg: string | undefined
  const specs: FlagSpec[] = [{ flag: '--port', read: (v) => { portArg = v } }]

  const positionals = parseFlags(argv, specs)
  const file = positionals[0]
  if (file === undefined || file.trim().length === 0) {
    throw new Error('missing required argument: <record-file>')
  }

  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg)
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid --port value: "${portArg}" (must be a non-negative integer)`)
  }

  return { file, port, help: false }
}

/**
 * `rhizomorph lab checkpoint <lane> [--path <dir>] [--captured-by <who>]
 * [--help]`. The `lab` namespace is prd12 ruling 1's second hand — kept out
 * of `cli/index.ts`'s flat top-level commands on purpose, so every
 * invocation reads `rhizomorph lab ...` and the second hand stays visible.
 *
 * This module intentionally does NOT import anything from
 * `server/src/lab/` — the namespace law test (`lab/namespace-law.test.ts`)
 * asserts only `cli/index.ts` may. `capturedBy`'s value set is duplicated
 * here rather than imported for exactly that reason.
 */
export interface LabCheckpointArgs {
  lane: string
  /** Worktree to snapshot; undefined defaults to the current directory. */
  path: string | undefined
  capturedBy: 'dispatch' | 'gate' | 'operator'
  help: boolean
}

const LAB_CAPTURED_BY_VALUES = ['dispatch', 'gate', 'operator'] as const
const DEFAULT_CAPTURED_BY: LabCheckpointArgs['capturedBy'] = 'operator'

function isCapturedBy(value: string): value is LabCheckpointArgs['capturedBy'] {
  return (LAB_CAPTURED_BY_VALUES as readonly string[]).includes(value)
}

/** `rhizomorph lab`'s own usage table — the namespace's index. */
export function labHelpText(): string {
  return `rhizomorph lab <subcommand> [options]

The laboratory — prd12 ruling 1's second, explicitly-invoked hand. No
observer code path (collector, server, UI) may reach it; every write it
makes is confined to refs/rhizomorph/ and artifacts outside the watched
repo, and it never runs without this command.

Subcommands:
  checkpoint <lane>       Capture a live workspace + session snapshot

Run 'rhizomorph lab checkpoint --help' for its own options.
`
}

/** `rhizomorph lab checkpoint`'s own usage table. */
export function labCheckpointHelpText(): string {
  return `rhizomorph lab checkpoint <lane> [options]

Captures a live checkpoint: a git workspace snapshot (temp-index recipe —
tracked-modified, staged and untracked files in one commit, working tree
byte-for-byte untouched) bound to the current byte offset and digest of the
lane's Claude Code session file. Emits an additive fork.checkpoint event
through the same recorder a running rhizomorph writes to. Writes only a ref
under refs/rhizomorph/checkpoints/ and the objects it requires — never
pushes, merges, or touches an operator branch.

Arguments:
  lane                    Lane handle this checkpoint is captured for

Options:
  --path <dir>            Worktree to snapshot (default: current directory)
  --captured-by <who>     ${LAB_CAPTURED_BY_VALUES.join(' | ')} (default: ${DEFAULT_CAPTURED_BY})
  --help, -h              Show this help and exit
`
}

export function parseLabCheckpointArgs(argv: readonly string[]): LabCheckpointArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { lane: '', path: undefined, capturedBy: DEFAULT_CAPTURED_BY, help: true }
  }

  let pathArg: string | undefined
  let capturedByArg: string | undefined

  const specs: FlagSpec[] = [
    { flag: '--path', read: (v) => { pathArg = v } },
    { flag: '--captured-by', read: (v) => { capturedByArg = v } },
  ]

  const positionals = parseFlags(argv, specs)
  const lane = positionals[0]
  if (lane === undefined || lane.trim().length === 0) {
    throw new Error('missing required argument: <lane>')
  }

  const capturedBy = capturedByArg === undefined ? DEFAULT_CAPTURED_BY : capturedByArg
  if (!isCapturedBy(capturedBy)) {
    throw new Error(
      `invalid --captured-by value: "${capturedByArg}" (must be one of ${LAB_CAPTURED_BY_VALUES.join(', ')})`,
    )
  }

  return { lane, path: pathArg, capturedBy, help: false }
}
