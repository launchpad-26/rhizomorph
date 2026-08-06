import { AGENT_ROLES, type AgentRole } from '@rhizomorph/core'
import { DEFAULT_PORT, parseFlags, type FlagSpec } from './args.js'
import { ENV_SHELLS, fetchInstanceId, renderTelemetryEnv, type EnvShell } from './telemetry-env.js'

const DEFAULT_ROLE: AgentRole = 'worker'
const DEFAULT_SHELL: EnvShell = 'sh'

function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value)
}

function isEnvShell(value: string): value is EnvShell {
  return (ENV_SHELLS as readonly string[]).includes(value)
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

  let instance: string
  try {
    instance = await fetchInstanceId(envArgs.port)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  log.log(renderTelemetryEnv({ ...envArgs, instance }))
  exit(0)
}
