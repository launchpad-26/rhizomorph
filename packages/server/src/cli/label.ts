import path from 'node:path'
import { writeSessionLabel } from '../log/label.js'
import { defaultDataRoot, sessionDirFor } from '../log/paths.js'
import { listSessions } from '../log/session-log.js'
import { parseFlags, type FlagSpec } from './args.js'
import type { RunCliOptions } from './types.js'

export interface RunLabelOptions {
  repoPath: string
  sessionId: string
  label: string
  /** Overrides `~/.local/share/rhizomorph`; tests point this at a temp dir. */
  dataRoot?: string
  /** Injectable clock, so tests get a deterministic `labelledAt`. */
  now?: () => number
}

export interface RunLabelResult {
  sessionDir: string
  sessionId: string
  label: string
}

/**
 * Writes an operator label for one recorded session — a sidecar file beside
 * its log (`<log>.label.json`), never a mutation of the append-only log
 * itself (the law: see `log/label.ts`). Refuses a session id nothing on
 * disk recognises, the same loud, exact refusal `export-record` already
 * gives for the identical mistake, rather than silently creating a sidecar
 * for a session that was never recorded.
 */
export async function runLabel(options: RunLabelOptions): Promise<RunLabelResult> {
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const sessionDir = sessionDirFor(options.repoPath, dataRoot)

  const sessions = await listSessions(sessionDir)
  if (!sessions.some((session) => session.id === options.sessionId)) {
    throw new Error(
      `no session with id "${options.sessionId}" for ${options.repoPath} (looked in ${sessionDir}) — ` +
        'run `rhizomorph sessions` to list recorded session ids',
    )
  }

  const now = options.now ?? Date.now
  const label = options.label.trim()
  await writeSessionLabel(sessionDir, options.sessionId, label, now())

  return { sessionDir, sessionId: options.sessionId, label }
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
 * `rhizomorph label <sessionId> <text>` — a standalone, one-shot subcommand,
 * no server boot: writes an operator label sidecar for one recorded
 * session, never touching the session's own append-only log. Same
 * clean-usage-error contract as every other subcommand here.
 */
export async function runLabelCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseLabelArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${labelHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(labelHelpText())
    exit(0)
  }

  const repoPath = path.resolve(args.path ?? process.cwd())

  try {
    const result = await runLabel({
      repoPath,
      sessionId: args.sessionId,
      label: args.label,
      dataRoot: options.dataRoot,
      now: options.now,
    })
    log.log(`labelled session ${result.sessionId}: "${result.label}"`)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}
