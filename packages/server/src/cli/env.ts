import path from 'node:path'
import { AGENT_ROLES, BEACON_LINE_VERSION, type AgentRole, type BeaconAttentionKind } from '@rhizomorph/core'
import { DEFAULT_PORT, parseFlags, type FlagSpec } from './args.js'
import { BEACON_FILE_SUFFIX, beaconDirFor } from '../collectors/beacon/paths.js'
import { capabilityAwareFetch } from './rotate.js'
import { ENV_SHELLS, fetchInstanceMeta, renderTelemetryEnv, type EnvShell } from './telemetry-env.js'

const DEFAULT_ROLE: AgentRole = 'worker'
const DEFAULT_SHELL: EnvShell = 'sh'

/** The CLIs `--hooks` can emit for. One today; a second is a new row here and a new render function, not a new flag. */
export const HOOK_CLIS = ['claude'] as const
export type HookCli = (typeof HOOK_CLIS)[number]

/** The `writer` every hook this emitter prints signs with — and therefore the beacon file's basename (ADR-0036: one file per writer). */
export const CLAUDE_HOOK_WRITER = 'claude-hook'

/**
 * Which Claude Code hook event declares which attention kind (prd-27 ruling 4 vocabulary, #282).
 * Order is the order the JSON is printed in.
 */
export const CLAUDE_HOOK_EVENTS = [
  ['Notification', 'waiting'],
  ['Stop', 'stopped'],
  ['UserPromptSubmit', 'working'],
  ['PostToolUse', 'working'],
] as const satisfies readonly (readonly [string, BeaconAttentionKind])[]

function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value)
}

function isEnvShell(value: string): value is EnvShell {
  return (ENV_SHELLS as readonly string[]).includes(value)
}

function isHookCli(value: string): value is HookCli {
  return (HOOK_CLIS as readonly string[]).includes(value)
}

/** POSIX single-quoting: the only escape is closing, backslash-quoting, reopening. */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export interface BeaconHookCommandOptions {
  beaconDir: string
  lane: string
  kind: BeaconAttentionKind
  hookEvent: string
}

/**
 * One shell command, safe from any cwd: absolute paths, `mkdir -p` before the
 * append, `>>` never `>`. The JSON line is emitted in two single-quoted halves
 * around the shell's own clock so the writer's `at` is the moment the hook
 * fired, not the moment the config was printed. `JSON.stringify` does the JSON
 * escaping (a lane with a `"` in it is still a valid line), `shellSingleQuote`
 * does the shell escaping (a lane or path with a `'` in it is still one word).
 */
export function renderBeaconHookCommand({ beaconDir, lane, kind, hookEvent }: BeaconHookCommandOptions): string {
  const file = path.join(beaconDir, `${CLAUDE_HOOK_WRITER}${BEACON_FILE_SUFFIX}`)
  const head = `{"v":${BEACON_LINE_VERSION},"at":`
  const tail =
    `,"writer":${JSON.stringify(CLAUDE_HOOK_WRITER)},"kind":${JSON.stringify(kind)}` +
    `,"lane":${JSON.stringify(lane)},"detail":${JSON.stringify(`hook: ${hookEvent}`)}}`
  return (
    `mkdir -p ${shellSingleQuote(beaconDir)} && ` +
    `printf '%s\\n' ${shellSingleQuote(head)}"$(($(date +%s)*1000))"${shellSingleQuote(tail)} >> ${shellSingleQuote(file)}`
  )
}

export interface ClaudeHooksOptions {
  lane: string
  beaconDir: string
}

/** The exact `settings.json` fragment: `{ "hooks": { <Event>: [ { hooks: [ { type: "command", command } ] } ] } }`, two-space indented, newline-terminated. */
export function renderClaudeHooks({ lane, beaconDir }: ClaudeHooksOptions): string {
  const hooks: Record<string, unknown[]> = {}
  for (const [hookEvent, kind] of CLAUDE_HOOK_EVENTS) {
    hooks[hookEvent] = [
      { hooks: [{ type: 'command', command: renderBeaconHookCommand({ beaconDir, lane, kind, hookEvent }) }] },
    ]
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

/** Parses `rhizomorph env <lane> [--role <role>] [--port <n>] [--shell <shell>] [--hooks <cli>] [--help]`. */
export interface EnvArgs {
  lane: string
  role: AgentRole
  port: number
  shell: EnvShell
  hooks: HookCli | null
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
  --hooks <cli>           claude — print, instead of the env block, the Claude Code
                          settings.json "hooks" fragment whose commands append an
                          attention beacon (ADR-0036) for this lane to the running
                          instance's beacon directory. --role and --shell are ignored.
  --help, -h              Show this help and exit
`
}

export function parseEnvArgs(argv: readonly string[]): EnvArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { lane: '', role: DEFAULT_ROLE, port: DEFAULT_PORT, shell: DEFAULT_SHELL, hooks: null, help: true }
  }

  let roleArg: string | undefined
  let portArg: string | undefined
  let shellArg: string | undefined
  let hooksArg: string | undefined

  const specs: FlagSpec[] = [
    { flag: '--role', read: (v) => { roleArg = v } },
    { flag: '--port', read: (v) => { portArg = v } },
    { flag: '--shell', read: (v) => { shellArg = v } },
    { flag: '--hooks', read: (v) => { hooksArg = v } },
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

  const hooks = hooksArg === undefined ? null : hooksArg
  if (hooks !== null && !isHookCli(hooks)) {
    throw new Error(`invalid --hooks value: "${hooksArg}" (must be one of ${HOOK_CLIS.join(', ')})`)
  }

  return { lane, role, port, shell, hooks, help: false }
}

/**
 * `rhizomorph env <lane>` — a standalone subcommand, no server boot of its
 * own, but it does read the instance id off the server on `--port` (#60: the
 * block must declare which run this telemetry belongs to, and only the running
 * Rhizomorph knows). Same clean-usage-error contract as the main command: a
 * bad argv — or an unreachable server — prints to stderr and exits 1, `--help`
 * prints to stdout and exits 0, no stack trace either way (#30/#32
 * conventions). `exit` always terminates in real usage; the `Promise<never>`
 * return type is honest about that and lets this slot into `runCli`'s
 * `Promise<CliHandle>` return without a dummy value.
 *
 * `/api/meta` is a `gated-read` (prd-29 ruling 7, #59), so the instance-id
 * read goes through {@link capabilityAwareFetch} rather than a bare `fetch` —
 * the same in-band scrape `rhizomorph rotate` already does, one shared helper
 * instead of a third copy. `--hooks` reads `repoPath` off that same scrape —
 * only the running Rhizomorph knows which repo's beacon directory a hook
 * should write to.
 */
export async function runEnvCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
): Promise<never> {
  let envArgs
  try {
    envArgs = parseEnvArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${envHelpText()}`)
    exit(1)
  }

  if (envArgs.help) {
    log.log(envHelpText())
    exit(0)
  }

  let meta: { sessionId: string; repoPath: string }
  try {
    meta = await fetchInstanceMeta(envArgs.port, { fetch: capabilityAwareFetch(envArgs.port) })
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  if (envArgs.hooks !== null) {
    log.log(renderClaudeHooks({ lane: envArgs.lane, beaconDir: beaconDirFor(meta.repoPath) }))
    exit(0)
  }
  log.log(renderTelemetryEnv({ ...envArgs, instance: meta.sessionId }))
  exit(0)
}
