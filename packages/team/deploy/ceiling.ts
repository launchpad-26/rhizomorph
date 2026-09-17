import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapTeamStorage, createPostgresStorage, openSql, resolveTeamConfig } from '../src/index.js'
import { planRetention } from '../src/fold/worker.js'
import {
  NO_CEILING_SOURCE,
  RETENTION_QUOTA_GAP,
  type RetentionCeiling,
  type TeamStorage,
} from '../src/storage/contract.js'

/**
 * THE ADMIN NAMES A CEILING WITH A HOST COMMAND, NOT A ROUTE (prd-51 ruling B,
 * signed off at grooming 2026-09-16).
 *
 * Ruling 9 says the organisation admin may name ceilings and does not say through
 * what. Ruling B answers it: **a command in the deployment directory, beside
 * `init.sh`** — an admin act on the host, which is also the honest reading of
 * ruling 10's *"made once at ceiling time, never silently"*. The viewer's admin
 * page is deliberately deferred, and whoever unparks it owns that route.
 *
 * ```
 * node ceiling.js name  --project <id> --days <n> (--archive <dir> | --no-archive) [--by <name>]
 * node ceiling.js clear --project <id>
 * node ceiling.js status
 * ```
 *
 * ## THREE THINGS IT REFUSES RATHER THAN GUESSES
 *
 * 1. **The archive choice.** `name` without exactly one of `--archive <dir>` and
 *    `--no-archive` is a refusal. Ruling 10 makes the archive the admin's choice
 *    "made once at ceiling time, never silently" — so there is no default, because
 *    a default would make it silent in one direction or the other on the first
 *    ceiling anyone names.
 * 2. **Who set it.** `--by`, else `USER`/`USERNAME` from the environment, else a
 *    refusal. There is deliberately **no `'unknown'` fallback**: ruling 9 asks
 *    every effective value to name who set it, and an unattributable ceiling is
 *    precisely the value an operator cannot find.
 * 3. **A malformed age.** `0`, a negative, a fraction and `30d` are refusals by
 *    name — never rounded, never coerced.
 *
 * ## WHAT IT PRINTS THAT IT IS NOT ASKED FOR
 *
 * `name` prints the **shared-partition consequence** before it becomes a surprise:
 * `events` is partitioned by time and not by project, so a ceiling named for one
 * project makes whole months eligible for every project on the deployment, and
 * the effective partition age is the most generous ceiling named
 * (`fold/worker.ts`'s `planRetention` carries the argument). `status` prints
 * {@link RETENTION_QUOTA_GAP} in **both** states — with a ceiling named and
 * without one — because a gap that only appears in the empty case is a gap the
 * operator sees exactly once.
 */

/** WHERE a ceiling named through this command was set (ruling 9). A tracked path. */
export const CEILING_SOURCE = 'packages/team/deploy/ceiling.ts'

export const ENV_SET_BY = ['USER', 'USERNAME'] as const

export type ParsedCeilingCommand =
  | { readonly kind: 'name'; readonly projectId: string; readonly maxAgeDays: number; readonly archiveDir: string | null }
  | { readonly kind: 'clear'; readonly projectId: string }
  | { readonly kind: 'status' }

export type ParseResult = ParsedCeilingCommand | { readonly error: string }

const USAGE =
  'usage: ceiling name --project <id> --days <n> (--archive <dir> | --no-archive) [--by <name>] | ' +
  'ceiling clear --project <id> | ceiling status'

/** `--flag value` pairs plus bare flags, with no dependency and no cleverness. */
function readFlags(argv: readonly string[]): { flags: Map<string, string>; bare: Set<string> } {
  const flags = new Map<string, string>()
  const bare = new Set<string>()
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at] as string
    if (!token.startsWith('--')) continue
    const next = argv[at + 1]
    if (next === undefined || next.startsWith('--')) {
      bare.add(token)
    } else {
      flags.set(token, next)
      at += 1
    }
  }
  return { flags, bare }
}

/**
 * A strictly positive integer, spelled in full.
 *
 * `Number('30d')` is `NaN` and `Number('')` is `0`, so a bare `Number(...)`
 * would turn a typo into a refusal with the wrong sentence or, worse, into a
 * zero-day ceiling. The regex is what makes `30.0`, `3e1` and ` 30 ` refusals
 * too: an age is typed by a human and there is exactly one way to type it.
 */
function parseDays(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null
  const days = Number(raw)
  return Number.isSafeInteger(days) ? days : null
}

export function parseCeilingArgs(argv: readonly string[]): ParseResult {
  const verb = argv[0]
  if (verb === undefined) return { error: `no command given. ${USAGE}` }

  const { flags, bare } = readFlags(argv.slice(1))

  if (verb === 'status') return { kind: 'status' }

  if (verb === 'clear') {
    const projectId = (flags.get('--project') ?? '').trim()
    if (projectId === '') return { error: `clear needs --project <id>. ${USAGE}` }
    return { kind: 'clear', projectId }
  }

  if (verb !== 'name') return { error: `unknown command ${JSON.stringify(verb)}. ${USAGE}` }

  const projectId = (flags.get('--project') ?? '').trim()
  if (projectId === '') return { error: `name needs --project <id>. ${USAGE}` }

  const rawDays = flags.get('--days')
  if (rawDays === undefined) return { error: `name needs --days <n>. ${USAGE}` }
  const maxAgeDays = parseDays(rawDays)
  if (maxAgeDays === null) {
    return {
      error: `--days must be a whole number of days greater than zero, received ${JSON.stringify(rawDays)}. A ceiling is never rounded or coerced: prd-51 ruling 10 says the server never invents an age`,
    }
  }

  const archiveDir = flags.get('--archive') ?? null
  const noArchive = bare.has('--no-archive')
  if (archiveDir === null && !noArchive) {
    return {
      error:
        'name needs an archive choice: --archive <dir> or --no-archive. prd-51 ruling 10 makes an archive before the drop "the admin\'s choice, made once at ceiling time, never silently", so there is no default — a default would make it silent in one direction on the first ceiling anyone names',
    }
  }
  if (archiveDir !== null && noArchive) {
    return { error: '--archive and --no-archive are the same choice made twice, in opposite directions. Pass one' }
  }
  if (archiveDir !== null && archiveDir.trim() === '') {
    return { error: '--archive needs a directory to archive to' }
  }

  return { kind: 'name', projectId, maxAgeDays, archiveDir: archiveDir === null ? null : archiveDir.trim() }
}

/** WHO is naming this ceiling (ruling 9). `null` when nothing can answer, which is a refusal. */
export function resolveSetBy(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const { flags } = readFlags(argv)
  const explicit = (flags.get('--by') ?? '').trim()
  if (explicit !== '') return explicit
  for (const name of ENV_SET_BY) {
    const value = (env[name] ?? '').trim()
    if (value !== '') return value
  }
  return null
}

/**
 * The consequence of naming ANY ceiling on this deployment, printed at the one
 * moment the admin can act on it.
 */
export function formatSharedPartitionConsequence(projectId: string): string {
  return (
    `note: partitions on this deployment are shared. events is partitioned by ts and not by project ` +
    `(migrations/0001_events.sql), so a ceiling named for ${projectId} makes whole months eligible for ` +
    'EVERY project on this server. The effective age for a partition is the MOST GENEROUS ceiling named — ' +
    'the alternative would discard a more generous project\'s rows at a stricter project\'s ceiling, which ' +
    'nobody named. A project with no ceiling of its own can still lose rows this way.'
  )
}

export interface CeilingStatusInput {
  readonly ceilings: readonly RetentionCeiling[]
  readonly partitions: readonly string[]
  readonly nowMs: number
}

/**
 * Every effective value, and what the next sweep will do — the report ruling 9
 * asks for, at the grain a drop actually happens at.
 */
export function formatCeilingStatus(input: CeilingStatusInput): string {
  const lines: string[] = []

  if (input.ceilings.length === 0) {
    lines.push('ceilings: none named, so nothing is ever dropped (prd-51 ruling 10).')
    lines.push(`  retentionCeilingDays = none (set by default, ${NO_CEILING_SOURCE})`)
  } else {
    lines.push(`ceilings: ${input.ceilings.length} named`)
    for (const ceiling of input.ceilings) {
      const archive = ceiling.archiveBeforeDrop ? `archive first -> ${ceiling.archiveDir ?? '(none)'}` : 'no archive'
      lines.push(
        `  ${ceiling.projectId} = ${ceiling.maxAgeDays} day(s), ${archive} (set by ${ceiling.setBy}, ${ceiling.source})`,
      )
    }
  }

  lines.push(`partitions: ${input.partitions.length}`)
  for (const verdict of planRetention({ partitions: input.partitions, ceilings: input.ceilings, nowMs: input.nowMs })) {
    lines.push(`  ${verdict.partition}: ${verdict.drop ? 'DROP' : 'keep'} — ${verdict.reason}`)
  }

  lines.push(RETENTION_QUOTA_GAP)
  return lines.join('\n')
}

export interface CeilingCommandDeps {
  readonly storage: TeamStorage
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly nowMs: number
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

/**
 * Runs one command and returns its exit code. Never calls `process.exit`, never
 * writes to a real stream, and never reads a real clock — which is what makes
 * every branch above testable against `FakeTeamStorage` with no database.
 */
export async function runCeilingCommand(deps: CeilingCommandDeps): Promise<number> {
  const parsed = parseCeilingArgs(deps.argv)
  if ('error' in parsed) {
    deps.err(parsed.error)
    return 1
  }

  if (parsed.kind === 'status') {
    deps.out(
      formatCeilingStatus({
        ceilings: await deps.storage.readCeilings(),
        partitions: await deps.storage.listEventPartitions(),
        nowMs: deps.nowMs,
      }),
    )
    return 0
  }

  if (parsed.kind === 'clear') {
    const had = await deps.storage.clearCeiling(parsed.projectId)
    deps.out(
      had
        ? `ceiling cleared for ${parsed.projectId}. With no ceiling named for it, nothing it holds is ever dropped (ruling 10).`
        : `no ceiling was named for ${parsed.projectId}, so nothing changed. Its rows were never being dropped.`,
    )
    return 0
  }

  const setBy = resolveSetBy(deps.argv, deps.env)
  if (setBy === null) {
    deps.err(
      `cannot name who is setting this ceiling: pass --by <name>, or set ${ENV_SET_BY.join(' or ')} in the environment. ` +
        'prd-51 ruling 9 asks every effective value to name who set it and where, and a ceiling nobody is named for is the value an operator cannot find.',
    )
    return 1
  }

  const ceiling: RetentionCeiling = {
    projectId: parsed.projectId,
    maxAgeDays: parsed.maxAgeDays,
    archiveBeforeDrop: parsed.archiveDir !== null,
    archiveDir: parsed.archiveDir,
    setBy,
    source: CEILING_SOURCE,
    setAtMs: deps.nowMs,
  }
  await deps.storage.nameCeiling(ceiling)

  deps.out(
    `ceiling named: ${ceiling.projectId} = ${ceiling.maxAgeDays} day(s), ` +
      `${ceiling.archiveBeforeDrop ? `archive first -> ${ceiling.archiveDir ?? '(none)'}` : 'no archive'} ` +
      `(set by ${ceiling.setBy}, ${ceiling.source}).`,
  )
  if (ceiling.archiveBeforeDrop) {
    deps.out(
      'because you chose to archive first, NO partition will be dropped: this server does not archive ' +
        "(prd-51 ruling 11's lifecycle is an act on another machine). Run `ceiling status` to see which " +
        'partitions are waiting on your archive, then re-name the ceiling with --no-archive to release them.',
    )
  }
  deps.out(formatSharedPartitionConsequence(ceiling.projectId))
  return 0
}

async function main(): Promise<void> {
  const config = resolveTeamConfig(process.env)
  const sql = openSql(config.databaseUrl.value)
  const storage = createPostgresStorage(sql)
  try {
    // The ceiling table arrives with a migration, so a host that has never booted
    // the app still gets a table to write to rather than a relation-does-not-exist.
    const bootstrapped = await bootstrapTeamStorage(storage, config)
    if (!bootstrapped.ok) {
      console.error(bootstrapped.error)
      process.exitCode = 1
      return
    }
    process.exitCode = await runCeilingCommand({
      storage,
      argv: process.argv.slice(2),
      env: process.env,
      nowMs: Date.now(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
  } finally {
    await sql.end()
  }
}

/**
 * RUN ONLY WHEN INVOKED DIRECTLY.
 *
 * `deploy/serve.ts` calls its `main()` at module scope, which is right for a
 * server entrypoint and wrong here: this module's functions are imported by
 * `deploy/ceiling.test.ts`, and an unguarded `main()` would open a real
 * connection the moment the suite loaded the file.
 */
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
