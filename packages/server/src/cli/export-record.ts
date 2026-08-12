import { lstat, mkdir, readlink, realpath, stat, writeFile } from 'node:fs/promises'
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
  /** Overwrite `outPath` if it already exists; default is to refuse. */
  force?: boolean
}

export interface ExportRecordResult {
  outPath: string
  record: SessionRecord
}

/** Parses `rhizomorph export-record [path] [--session <id>] [--out <file>] [--handle <name>] [--force] [--help]`. */
export interface ExportRecordArgs {
  path: string | undefined
  /** Session id to export; defaults to the most recently recorded one. */
  sessionId: string | undefined
  /** Output file path; defaults to alongside the session logs (see `export-record.ts`). */
  out: string | undefined
  /** Human-declared actor name; defaults to the OS username, marked `declared: false`. */
  handle: string | undefined
  /** Overwrite an existing `--out` file instead of refusing. */
  force: boolean
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
  --force                 Overwrite --out if it already exists (default: refuse)
  --help, -h              Show this help and exit
`
}

export function parseExportRecordArgs(argv: readonly string[]): ExportRecordArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { path: undefined, sessionId: undefined, out: undefined, handle: undefined, force: false, help: true }
  }

  let sessionArg: string | undefined
  let outArg: string | undefined
  let handleArg: string | undefined
  let force = false

  const specs: FlagSpec[] = [
    { flag: '--session', read: (v) => { sessionArg = v } },
    { flag: '--out', read: (v) => { outArg = v } },
    { flag: '--handle', read: (v) => { handleArg = v } },
    { flag: '--force', boolean: true, read: () => { force = true } },
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

  return { path, sessionId: sessionArg, out: outArg, handle: handleArg, force, help: false }
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
 * `fs.realpath` throws ENOENT the moment any component of `target` — including
 * a symlink's ultimate target — doesn't exist, so it can't canonicalise a
 * path that is about to be created. This resolves as far as the filesystem
 * actually allows: it chases a symlink's `readlink` target even when that
 * target is itself missing (the dangling-symlink case, e.g. `--out` pointing
 * at a not-yet-written file inside the watched repo), and otherwise walks up
 * to the nearest ancestor that does exist, canonicalises that, and rejoins
 * the remainder. Ordinary non-symlink, non-existent paths (the common case —
 * the record hasn't been written yet) resolve the same way, via the ancestor
 * walk with no symlink involved.
 */
async function canonicalizeExistingAncestor(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const linkTarget = await lstat(target).then(
    (s) => (s.isSymbolicLink() ? readlink(target) : undefined),
    () => undefined,
  )
  if (linkTarget !== undefined) {
    return canonicalizeExistingAncestor(path.resolve(path.dirname(target), linkTarget))
  }

  const parent = path.dirname(target)
  if (parent === target) {
    return target
  }
  return path.join(await canonicalizeExistingAncestor(parent), path.basename(target))
}

/**
 * Reads a recorded session off disk and writes it out as a portable session
 * record (prd11 ruling 3) — outside the watched repo, same law the session
 * logs themselves already keep. `sessionId` defaults to the most recently
 * recorded session for this repo; `--out` may point anywhere except inside
 * `repoPath`, which would break the "export never touches the watched repo"
 * law, so that case is refused rather than silently allowed. Separately, an
 * *explicit* `--out` that already exists is refused unless `force` is set —
 * this is a one-shot, non-interactive command, so refuse-by-default stands in
 * for a confirmation prompt rather than silently overwriting a file the
 * caller named. A directory at the out path is refused regardless of `force`,
 * since overwriting it is never what was meant. The guard does not apply to the default path (derived from
 * repo slug + session id, inside rhizomorph's own data dir): that artefact is
 * regenerable and re-running export-record without `--out` is meant to
 * refresh it, not fail on the second run.
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
  // Canonicalise both sides before comparing: `path.resolve` alone leaves a
  // symlinked --out looking like it's outside the repo when it textually is,
  // even though writeFile follows the link back inside it.
  const canonicalOutPath = await canonicalizeExistingAncestor(outPath)
  const canonicalRepoPath = await canonicalizeExistingAncestor(repoPathResolved)
  const relativeToRepo = path.relative(canonicalRepoPath, canonicalOutPath)
  const isInsideRepo = relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !path.isAbsolute(relativeToRepo))
  if (isInsideRepo) {
    throw new Error(
      `refusing to write the record inside the watched repo (${canonicalOutPath}) — pass --out with a path outside ${canonicalRepoPath}`,
    )
  }

  await mkdir(path.dirname(outPath), { recursive: true })

  // `wx` refuses (EEXIST) instead of truncating, closing the stat-then-write
  // TOCTOU window and also refusing through a dangling symlink — only when
  // the caller named the path explicitly; the default path always refreshes.
  const refuseExisting = options.out !== undefined && options.force !== true
  try {
    await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: refuseExisting ? 'wx' : 'w',
    })
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    // A directory at outPath surfaces as EEXIST under 'wx' and EISDIR under
    // 'w' — either way --force cannot help, so don't advise it.
    if (code === 'EEXIST' || code === 'EISDIR') {
      const existing = await stat(outPath).catch(() => undefined)
      if (existing?.isDirectory()) {
        throw new Error(
          options.out !== undefined
            ? `--out names an existing directory (${outPath}) — pass a file path instead`
            : `the default record path is an existing directory (${outPath}) — remove it, or pass --out with a file path`,
        )
      }
    }
    if (refuseExisting && code === 'EEXIST') {
      throw new Error(`refusing to overwrite existing file (${outPath}) — pass --force to overwrite`)
    }
    throw err
  }

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

  // Not an error — the export still does what was asked — but the flag buys
  // nothing here (the default path always refreshes), and a silent no-op
  // teaches callers the wrong contract.
  if (args.force && args.out === undefined) {
    log.warn('--force has no effect without --out — the default record path is always refreshed')
  }

  try {
    const { outPath, record } = await runExportRecord({
      repoPath,
      dataRoot: options.dataRoot,
      sessionId: args.sessionId,
      out: args.out,
      handle: args.handle,
      force: args.force,
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
