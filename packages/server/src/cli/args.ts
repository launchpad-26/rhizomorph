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
   * `--resume-window <ms>`'s value, or the `RESUME_WINDOW_MS` default. `0`
   * behaves exactly like `--fresh` — see `decideSessionBoot`.
   */
  resumeWindowMs: number
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

export interface FlagSpec {
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
export function parseFlags(argv: readonly string[], specs: readonly FlagSpec[]): string[] {
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
 * [--resume-window <ms>] [--backfill] [--version] [--help]`.
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
      resumeWindowMs: RESUME_WINDOW_MS,
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
      resumeWindowMs: RESUME_WINDOW_MS,
      backfill: false,
      help: false,
      version: true,
    }
  }

  let portArg: string | undefined
  let flatlineArg: string | undefined
  let pollIntervalArg: string | undefined
  let resumeWindowArg: string | undefined
  let fresh = false
  let backfill = false
  const extraSessionRawValues: Array<string | undefined> = []

  const specs: FlagSpec[] = [
    { flag: '--port', read: (v) => { portArg = v } },
    { flag: '--flatline-minutes', read: (v) => { flatlineArg = v } },
    { flag: '--poll-interval', read: (v) => { pollIntervalArg = v } },
    { flag: '--extra-sessions', read: (v) => { extraSessionRawValues.push(v) } },
    { flag: '--fresh', boolean: true, read: () => { fresh = true } },
    { flag: '--resume-window', read: (v) => { resumeWindowArg = v } },
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

  // 0 is a legitimate value (`--resume-window 0` === `--fresh` — decideSessionBoot's own law).
  const resumeWindowMs = resumeWindowArg === undefined ? RESUME_WINDOW_MS : Number(resumeWindowArg)
  if (!Number.isFinite(resumeWindowMs) || resumeWindowMs < 0) {
    throw new Error(`invalid --resume-window value: "${resumeWindowArg}" (must be a non-negative number of ms)`)
  }

  return {
    path,
    port,
    flatlineMinutes,
    pollIntervalMs,
    extraSessionDirs,
    fresh,
    resumeWindowMs,
    backfill,
    help: false,
    version: false,
  }
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

export interface RotateArgs {
  /** The running Rhizomorph to ask. Rotation is done BY the instrument that owns the log, never behind its back. */
  port: number
  help: boolean
}

export function rotateHelpText(): string {
  return `rhizomorph rotate [options]

Ends the running Rhizomorph's current session and starts a fresh one — the
operator's explicit boundary (prd16 ruling 2). The closed log gets a final
'session.closed' line and is flushed to disk; the new session gets a new id,
and appears in 'rhizomorph sessions' and the replay picker immediately. Nothing
outside this repo's own session directory is touched, and the closed session is
never resumed by a later boot.

This asks the RUNNING server (the same way 'rhizomorph env' reads the instance
id): a session is closed by the instrument that owns its log, never by a second
process reaching into a file another one is writing (#187's lock exists to make
that impossible). Start the server first, or rotate from the dashboard's
"end session · start fresh" button.

Options:
  --port <n>              Rhizomorph server port to target (default: ${DEFAULT_PORT})
  --help, -h              Show this help and exit
`
}

export function parseRotateArgs(argv: readonly string[]): RotateArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { port: DEFAULT_PORT, help: true }
  }

  let portArg: string | undefined
  const specs: FlagSpec[] = [{ flag: '--port', read: (v) => { portArg = v } }]

  const positionals = parseFlags(argv, specs)
  const stray = positionals[0]
  if (stray !== undefined) {
    // A path would be the natural guess ('rhizomorph rotate .') and it would be
    // wrong: the port names the instrument, and the instrument knows its repo.
    throw new Error(
      `unexpected argument: "${stray}" (rotate takes no path — it asks the server on --port, which already knows which repo it watches)`,
    )
  }

  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg)
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid --port value: "${portArg}" (must be a non-negative integer)`)
  }

  return { port, help: false }
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
rhizomorph sessions [path] [options]        List recorded sessions — title, when, duration, lanes, cost, size
rhizomorph label <sessionId> <text> [options]  Set the operator label an auto-title yields to
rhizomorph rotate [options]          End the running session and start a fresh one (prd16)
rhizomorph lab checkpoint <lane> [options]  Capture a live workspace + session snapshot (prd12)
rhizomorph lab fork <lane> [options]        Restore n arms from one of that lane's checkpoints (prd12)
rhizomorph lab compare <fork-id> [options]  Table one fork's arms — runs, never a winner (prd12)

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
  --resume-window <ms>    Override the resume boundary above (default: ${RESUME_WINDOW_MS}, ${RESUME_WINDOW_HOURS}h).
                          "--resume-window 0" behaves exactly like --fresh: always start a
                          new session. The boot line and \`rhizomorph doctor\` both say which
                          way this decided and why.
  --backfill              Read session logs from the beginning instead of starting at
                          end-of-file: ingest history on purpose. Expect a large
                          first tick and old timestamps.
  --version               Print the installed rhizomorph version and exit
  --help, -h              Show this help and exit

Run 'rhizomorph doctor --help', 'rhizomorph env --help', 'rhizomorph export-record --help',
'rhizomorph replay --help', 'rhizomorph sessions --help', 'rhizomorph label --help',
'rhizomorph rotate --help' or 'rhizomorph lab --help' for a subcommand's own options.
`
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

/** Parses `rhizomorph sessions [path] [--help]`. */
export interface SessionsArgs {
  path: string | undefined
  help: boolean
}

/** `rhizomorph sessions`'s own usage table, distinct from the main command's. */
export function sessionsHelpText(): string {
  return `rhizomorph sessions [path] [options]

Lists every session recorded for a repo, newest first: id, title (an
operator label if one was set with 'rhizomorph label', else an auto-title
derived from the session's own events — lanes dispatched, how many landed,
issue numbers), when it started, how long it ran, lanes, landings, output
tokens, cost (flagged "(est.)" when no authoritative telemetry arrived), and
the log's file size. This is how a stranger finds "the one where the scene
landed" without opening any of them.

Arguments:
  path                    Repo whose recorded sessions to list (default: current directory)

Options:
  --help, -h              Show this help and exit
`
}

export function parseSessionsArgs(argv: readonly string[]): SessionsArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { path: undefined, help: true }
  }

  const positionals = parseFlags(argv, [])
  return { path: positionals[0], help: false }
}

/** Parses `rhizomorph label <sessionId> <text> [--path <dir>] [--help]`. */
export interface LabelArgs {
  sessionId: string
  /** The label text — later positionals are joined with a space, so an unquoted multi-word label still works. */
  label: string
  path: string | undefined
  help: boolean
}

/** `rhizomorph label`'s own usage table, distinct from the main command's. */
export function labelHelpText(): string {
  return `rhizomorph label <sessionId> <text> [options]

Sets the operator label for one recorded session — a sidecar file written
beside its log ('session-<id>.label.json'), never a mutation of the
append-only log itself. A labelled session shows the label everywhere an
auto-title would otherwise appear ('rhizomorph sessions', the replay
picker); running this again for the same session overwrites the previous
label.

Arguments:
  sessionId               Session id, as listed by 'rhizomorph sessions'
  text                     The label (quote it if it has spaces; unquoted
                          words after sessionId are also joined with spaces)

Options:
  --path <dir>            Repo whose recorded sessions to label (default: current directory)
  --help, -h              Show this help and exit
`
}

export function parseLabelArgs(argv: readonly string[]): LabelArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { sessionId: '', label: '', path: undefined, help: true }
  }

  let pathArg: string | undefined
  const specs: FlagSpec[] = [{ flag: '--path', read: (v) => { pathArg = v } }]

  const positionals = parseFlags(argv, specs)
  const sessionId = positionals[0]
  if (sessionId === undefined || sessionId.trim().length === 0) {
    throw new Error('missing required argument: <sessionId>')
  }

  const label = positionals.slice(1).join(' ').trim()
  if (label.length === 0) {
    throw new Error('missing required argument: <text> (the label — quote it if it has spaces)')
  }

  return { sessionId, label, path: pathArg, help: false }
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
  fork <lane>             Restore n arms from one of that lane's checkpoints
  compare <fork-id>       Table of a fork's arms: treatment, gate, cost, duration, commits

Run 'rhizomorph lab checkpoint --help', 'rhizomorph lab fork --help' or
'rhizomorph lab compare --help' for a subcommand's own options.
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

/**
 * `rhizomorph lab fork <lane> [--at <checkpointId>] [--model <m>]
 * [--prompt-file <f>] [--arms <n>] [--path <dir>] [--launch] [--help]`.
 *
 * Same rule as `parseLabCheckpointArgs`: nothing here imports from
 * `server/src/lab/`, so the namespace law's one allowed importer stays one.
 * `DEFAULT_ARMS` is therefore restated rather than imported — and the
 * duplication is load-bearing, not laziness.
 */
export interface LabForkArgs {
  lane: string
  /** Checkpoint to fork from; undefined takes the lane's most recent. */
  at: string | undefined
  model: string | undefined
  promptFile: string | undefined
  arms: number
  /** The parent lane's worktree; undefined defaults to the current directory. */
  path: string | undefined
  /** Run the workmux launcher too. Off by default — see `lab/fork.ts`'s module doc. */
  launch: boolean
  help: boolean
}

/** prd12 ruling 4's floor, restated here for the reason given on {@link LabForkArgs}. */
const DEFAULT_FORK_ARMS = 3

/** `rhizomorph lab fork`'s own usage table. */
export function labForkHelpText(): string {
  return `rhizomorph lab fork <lane> [options]

Restores n independent realities from one of a lane's checkpoints. Each arm
gets its own detached worktree under the lab's data dir, restored at the
checkpoint's snapshot (the parent's uncommitted work included), and its own
Claude Code session: the parent's conversation cut at the checkpoint, digest-
verified, with every absolute path into the parent worktree rewritten to the
arm's own tree (prd12 ruling 5 — an agent acting on its parent's files is the
one corruption this design makes impossible). Each arm is recorded as a
fork.dispatched event, which is what marks its lane synthetic everywhere.

Arguments:
  lane                    Lane to fork — the one whose checkpoints are read

Options:
  --at <checkpointId>     Checkpoint to fork from (default: that lane's most recent)
  --model <m>             Model each arm's agent runs (default: the fleet default)
  --prompt-file <f>       Prompt file handed to each arm; its sha256 is the treatment's identity
  --arms <n>              How many arms (default: ${DEFAULT_FORK_ARMS} — prd12 ruling 4's floor for comparison)
  --path <dir>            The lane's worktree (default: current directory)
  --launch                Also run 'workmux add' for each arm. OFF by default: that
                          creates a refs/heads/ branch and a worktree of workmux's
                          own, neither of which is a namespace prd12 ruling 1 lets
                          the laboratory write to on its own authority. Without it
                          the arms are fully restored and the exact command line for
                          each is printed for you to run.
  --help, -h              Show this help and exit
`
}

export function parseLabForkArgs(argv: readonly string[]): LabForkArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      lane: '',
      at: undefined,
      model: undefined,
      promptFile: undefined,
      arms: DEFAULT_FORK_ARMS,
      path: undefined,
      launch: false,
      help: true,
    }
  }

  let atArg: string | undefined
  let modelArg: string | undefined
  let promptFileArg: string | undefined
  let armsArg: string | undefined
  let pathArg: string | undefined
  let launch = false

  const specs: FlagSpec[] = [
    { flag: '--at', read: (v) => { atArg = v } },
    { flag: '--model', read: (v) => { modelArg = v } },
    { flag: '--prompt-file', read: (v) => { promptFileArg = v } },
    { flag: '--arms', read: (v) => { armsArg = v } },
    { flag: '--path', read: (v) => { pathArg = v } },
    { flag: '--launch', boolean: true, read: () => { launch = true } },
  ]

  const positionals = parseFlags(argv, specs)
  const lane = positionals[0]
  if (lane === undefined || lane.trim().length === 0) {
    throw new Error('missing required argument: <lane>')
  }

  if (atArg !== undefined && atArg.trim().length === 0) {
    throw new Error('invalid --at value: (must be a non-empty checkpoint id)')
  }
  if (modelArg !== undefined && modelArg.trim().length === 0) {
    throw new Error('invalid --model value: (must be a non-empty model name)')
  }
  if (promptFileArg !== undefined && promptFileArg.trim().length === 0) {
    throw new Error('invalid --prompt-file value: (must be a non-empty file path)')
  }

  const arms = armsArg === undefined ? DEFAULT_FORK_ARMS : Number(armsArg)
  if (!Number.isInteger(arms) || arms < 1) {
    throw new Error(`invalid --arms value: "${armsArg}" (must be a positive integer)`)
  }

  return { lane, at: atArg, model: modelArg, promptFile: promptFileArg, arms, path: pathArg, launch, help: false }
}

/** `rhizomorph lab compare <fork-id> [--verify <cmd>] [--no-verify] [--path <dir>] [--help]`. */
export interface LabCompareArgs {
  forkId: string
  /** Gate command each arm is judged by. */
  verify: string
  /** True when `--no-verify` was passed: report the runs without running anything. */
  skipVerify: boolean
  path: string | undefined
  help: boolean
}

/** Restated here rather than imported, for the reason given on {@link LabForkArgs}. */
const DEFAULT_VERIFY = 'npm test'

/** `rhizomorph lab compare`'s own usage table. */
export function labCompareHelpText(): string {
  return `rhizomorph lab compare <fork-id> [options]

Prints a table of one fork's arms — arm, treatment, verified outcome, cost,
duration, commits — and nothing else. prd12 ruling 6: a table, not a
visualization. prd12 ruling 4: distributions, never a winner, and below three
arms not even that — the table shows the runs and says plainly that it will
not rank them.

Arguments:
  fork-id                 The forkId printed by 'rhizomorph lab fork'

Options:
  --verify <cmd>          Gate command run in each arm's worktree (default: "${DEFAULT_VERIFY}")
  --no-verify             Do not run any gate; every arm reports "not-run"
  --path <dir>            The parent lane's worktree, whose log holds the fork (default: current directory)
  --help, -h              Show this help and exit
`
}

export function parseLabCompareArgs(argv: readonly string[]): LabCompareArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { forkId: '', verify: DEFAULT_VERIFY, skipVerify: false, path: undefined, help: true }
  }

  let verifyArg: string | undefined
  let pathArg: string | undefined
  let skipVerify = false

  const specs: FlagSpec[] = [
    { flag: '--verify', read: (v) => { verifyArg = v } },
    { flag: '--no-verify', boolean: true, read: () => { skipVerify = true } },
    { flag: '--path', read: (v) => { pathArg = v } },
  ]

  const positionals = parseFlags(argv, specs)
  const forkId = positionals[0]
  if (forkId === undefined || forkId.trim().length === 0) {
    throw new Error('missing required argument: <fork-id>')
  }

  if (verifyArg !== undefined && verifyArg.trim().length === 0) {
    throw new Error('invalid --verify value: (must be a non-empty command)')
  }
  if (verifyArg !== undefined && skipVerify) {
    throw new Error('--verify and --no-verify contradict each other: pass one or the other')
  }

  return { forkId, verify: verifyArg ?? DEFAULT_VERIFY, skipVerify, path: pathArg, help: false }
}
