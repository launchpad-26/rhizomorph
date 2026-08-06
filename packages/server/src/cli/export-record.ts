import { mkdir, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import { buildRecord, type Actor, type SessionRecord } from '@rhizomorph/core/src/record/index.js'
import { defaultDataRoot, repoSlug, sessionDirFor } from '../log/paths.js'
import { listSessions, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import { parseFlags, type FlagSpec } from './args.js'
import type { RunCliOptions } from './types.js'

export interface ExportRecordOptions {
  repoPath: string
  /** Overrides `~/.local/share/rhizomorph`; tests point this at a temp dir. */
  dataRoot?: string
  /** Which recorded session to export; defaults to the most recently recorded one. */
  sessionId?: string
  /** Output file path; defaults to alongside the session logs. */
  out?: string
  /** Human-declared actor name; defaults to the OS username, marked `declared: false`. */
  handle?: string
}

export interface ExportRecordResult {
  outPath: string
  record: SessionRecord
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

/** `os.userInfo()` can throw when the process has no passwd entry (some minimal containers) — an honest fallback, not a crash. */
function osUsername(): string {
  try {
    return userInfo().username
  } catch {
    return 'unknown'
  }
}

function resolveActor(handle: string | undefined): Actor {
  return handle === undefined
    ? { instance: '', handle: osUsername(), declared: false }
    : { instance: '', handle, declared: true }
}

/**
 * Reads a recorded session off disk and writes it out as a portable session
 * record (prd11 ruling 3) — outside the watched repo, same law the session
 * logs themselves already keep. `sessionId` defaults to the most recently
 * recorded session for this repo; `--out` may point anywhere except inside
 * `repoPath`, which would break the "export never touches the watched repo"
 * law, so that case is refused rather than silently allowed.
 */
export async function runExportRecord(options: ExportRecordOptions): Promise<ExportRecordResult> {
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const sessionDir = sessionDirFor(options.repoPath, dataRoot)
  const slug = repoSlug(options.repoPath)

  let sessionId = options.sessionId
  if (sessionId === undefined) {
    const sessions = await listSessions(sessionDir)
    const latest = sessions[sessions.length - 1]
    if (!latest) {
      throw new Error(`no recorded sessions for ${options.repoPath} (looked in ${sessionDir})`)
    }
    sessionId = latest.id
  } else {
    const sessions = await listSessions(sessionDir)
    if (!sessions.some((s) => s.id === sessionId)) {
      throw new Error(`no session with id "${sessionId}" for ${options.repoPath} (looked in ${sessionDir})`)
    }
  }

  const events = await readSessionEvents(sessionFilePath(sessionDir, sessionId))

  const actor: Actor = { ...resolveActor(options.handle), instance: sessionId }
  const record = buildRecord(events, { repoSlug: slug, actor })

  const outPath = path.resolve(
    options.out ?? path.join(sessionDir, `${slug}-${sessionId}.rhizorecord.json`),
  )

  const repoPathResolved = path.resolve(options.repoPath)
  const relativeToRepo = path.relative(repoPathResolved, outPath)
  const isInsideRepo = relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !path.isAbsolute(relativeToRepo))
  if (isInsideRepo) {
    throw new Error(
      `refusing to write the record inside the watched repo (${outPath}) — pass --out with a path outside ${repoPathResolved}`,
    )
  }

  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

  return { outPath, record }
}

/**
 * `rhizomorph export-record [path]` — a standalone, one-shot subcommand, no
 * server boot: reads a recorded session off disk and writes it out as a
 * portable session record (prd11 ruling 3). Same clean-usage-error contract
 * as every other subcommand here.
 */
export async function runExportRecordCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseExportRecordArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${exportRecordHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(exportRecordHelpText())
    exit(0)
  }

  const repoPath = path.resolve(args.path ?? process.cwd())

  try {
    const { outPath, record } = await runExportRecord({
      repoPath,
      dataRoot: options.dataRoot,
      sessionId: args.sessionId,
      out: args.out,
      handle: args.handle,
    })
    const declared = record.manifest.actor.declared ? '' : ' (undeclared)'
    log.log(
      `wrote ${outPath} — ${record.manifest.eventCount} events, ` +
        `actor ${record.manifest.actor.handle}${declared}@${record.manifest.actor.instance}`,
    )
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}
