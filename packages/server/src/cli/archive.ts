import path from 'node:path'
import { runArchive, type ArchiveRunResult, type CandidateOutcome } from '../log/archive.js'
import { parseFlags, type FlagSpec } from './args.js'
import type { RunCliOptions } from './types.js'

/**
 * `rhizomorph archive` — prd-51 ruling 11's one command: seal → archive →
 * verify → tombstone → prune, in that order, or it does not run. All of the
 * logic is in `log/archive.ts`; this file is argument parsing, the operator's
 * report, and the exit code.
 *
 * **There is no default age.** `--older-than` is required, and that is
 * `log/retention.ts`'s ruling (prd-44 wave 0) rather than an omission here: a
 * default age is a policy that reaps a lane nobody thought about.
 *
 * **`--dry-run` stops before any write**, and there is deliberately no
 * `--prune`: a second flag that pruned without archiving would be exactly the
 * reachable prune-without-archive route ruling 11 forbids.
 */

/** Parses `rhizomorph archive [path] --older-than <duration> [--out-dir <dir>] [--handle <name>] [--dry-run] [--help]`. */
export interface ArchiveArgs {
  path: string | undefined
  /** Milliseconds. Required — there is no default age, and that is `retention.ts`'s ruling, not an omission. */
  olderThanMs: number | undefined
  outDir: string | undefined
  handle: string | undefined
  dryRun: boolean
  help: boolean
}

/** `rhizomorph archive`'s own usage table, distinct from the main command's. */
export function archiveHelpText(): string {
  return `rhizomorph archive [path] --older-than <duration> [options]

Seals every recording older than the age you name, in ONE ordered act
(prd-51 ruling 11): build the portable record, gzip it, verify the archive
read back off disk, write the tombstone manifest beside the log WHILE THE LOG
STILL EXISTS, and only then prune that log. Any step that refuses leaves the
log exactly where it was — there is no path here that prunes without archiving.

Archives land as "<repo-slug>-<session-id>.rhizorecord.json.gz", by default
beside the session logs and never inside the watched repo. Gunzip one before
handing it to 'rhizomorph replay'.

Arguments:
  path                    Repo whose recorded sessions to archive (default: current directory)

Options:
  --older-than <dur>      REQUIRED. How old a recording must be, as <number><unit>
                          with unit ms, s, m, h or d (e.g. 30d, 90m, 0d). There is
                          no default: naming an age for you would be a retention
                          policy, and that answer is the operator's every time.
  --out-dir <dir>         Where the .gz archives land (default: beside the session logs).
                          Refused if it resolves inside the watched repo.
  --handle <name>         Human-declared actor name (default: the OS username, marked undeclared)
  --dry-run               Say what would go, and stop. Writes nothing, prunes nothing.
  --help, -h              Show this help and exit
`
}

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * `<number><unit>` → milliseconds. A **bare number is refused**, deliberately:
 * a silent unit is a policy, and the difference between 30 milliseconds and 30
 * days is the difference between a no-op and deleting a month. `0d` is legal —
 * `retention.ts` allows `maxAgeMs >= 0`, and "everything not being written to"
 * is a coherent thing to ask for.
 */
export function parseOlderThan(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value)
  const unit = match === null ? undefined : UNIT_MS[match[2]!]
  if (match === null || unit === undefined) {
    throw new Error(
      `invalid --older-than value: "${value}" (must be <number><unit>, unit one of ms, s, m, h, d ` +
        '— e.g. 30d; a bare number is refused because a silent unit is a policy)',
    )
  }
  return Number(match[1]) * unit
}

export function parseArchiveArgs(argv: readonly string[]): ArchiveArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { path: undefined, olderThanMs: undefined, outDir: undefined, handle: undefined, dryRun: false, help: true }
  }

  let olderThanArg: string | undefined
  let outDirArg: string | undefined
  let handleArg: string | undefined
  let dryRun = false

  const specs: FlagSpec[] = [
    { flag: '--older-than', read: (v) => { olderThanArg = v } },
    { flag: '--out-dir', read: (v) => { outDirArg = v } },
    { flag: '--handle', read: (v) => { handleArg = v } },
    { flag: '--dry-run', boolean: true, read: () => { dryRun = true } },
  ]

  const positionals = parseFlags(argv, specs)
  const repoPath = positionals[0]

  if (olderThanArg === undefined) {
    throw new Error(
      '--older-than is required: there is no default retention age, and naming one for you would be ' +
        'a policy that reaps a lane nobody thought about (retention.ts, wave 0 of prd-44)',
    )
  }
  if (outDirArg !== undefined && outDirArg.trim().length === 0) {
    throw new Error('invalid --out-dir value: (must be a non-empty directory path)')
  }
  if (handleArg !== undefined && handleArg.trim().length === 0) {
    throw new Error('invalid --handle value: (must be a non-empty name)')
  }

  return {
    path: repoPath,
    olderThanMs: parseOlderThan(olderThanArg),
    outDir: outDirArg,
    handle: handleArg,
    dryRun,
    help: false,
  }
}

/** The per-candidate lines. Exported for the CLI test, which asserts the exact shapes rather than a substring of a blob. */
export function voiceOutcome(outcome: CandidateOutcome, fileNameOf: (sessionId: string) => string): string[] {
  if (outcome.kind === 'refused') return [`REFUSED ${outcome.sessionId} — ${outcome.reason}`]

  const { tombstone } = outcome
  const named = [...tombstone.attributedLanes, ...tombstone.gitOnlyLanes]
  const lines = [
    `archived ${outcome.sessionId} — ${outcome.eventCount} events → ${outcome.archivePath} ` +
      `(${outcome.archiveBytes} bytes, chain ${outcome.chainDigest.slice(0, 12)}), verified`,
  ]

  if (tombstone.written) {
    lines.push(
      `  tombstone ${tombstone.manifestPath} — ${named.length} lane(s): ${named.join(', ')} ` +
        `(${tombstone.attributedLanes.length} from telemetry, ${tombstone.gitOnlyLanes.length} from git alone)`,
    )
  } else {
    lines.push(
      `  tombstone not needed — the capture manifest at ${tombstone.manifestPath} already names every lane the log does`,
    )
  }

  // prd-51 ruling 11 offers two answers for a lane git alone knows about:
  // widen the writer, or say out loud that it cannot be named. #432 took the
  // widening — and says it out loud anyway, so the widening is observable in
  // stdout and not only inside a manifest a reader would have to go and open.
  if (tombstone.gitOnlyLanes.length > 0) {
    lines.push(
      `  ${tombstone.gitOnlyLanes.length} lane(s) named by git alone and never instrumented ` +
        `(${tombstone.gitOnlyLanes.join(', ')}) — no transcript ever existed for them; the tombstone ` +
        'names them so they still read as pruned',
    )
  }

  lines.push(`  pruned ${fileNameOf(outcome.sessionId)} — ${outcome.bytesFreed} bytes freed`)
  return lines
}

/** The whole report: the retention plan in its own voice, then one block per candidate, then the census. */
export function voiceArchiveRun(result: ArchiveRunResult): string[] {
  const fileNameOf = (sessionId: string): string =>
    result.plan.candidates.find((candidate) => candidate.sessionId === sessionId)?.fileName ?? sessionId

  const lines = [...result.voice]
  for (const outcome of result.outcomes) lines.push(...voiceOutcome(outcome, fileNameOf))

  const archived = result.outcomes.filter((outcome) => outcome.kind === 'archived')
  const refused = result.outcomes.length - archived.length
  const freed = archived.reduce((sum, outcome) => sum + (outcome.kind === 'archived' ? outcome.bytesFreed : 0), 0)
  lines.push('', `${archived.length} archived, ${refused} refused, ${freed} bytes freed`)
  return lines
}

/**
 * `rhizomorph archive [path]` — a standalone, one-shot subcommand, no server
 * boot. Same clean-usage-error contract as every other subcommand here.
 *
 * **Exit 1 when any candidate was refused**, 0 otherwise (including zero
 * candidates and `--dry-run`). A refusal is a real failure to do what was
 * asked: the log the operator asked to reclaim is still on disk, and a green
 * exit would say otherwise.
 */
export async function runArchiveCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseArchiveArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${archiveHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(archiveHelpText())
    exit(0)
  }

  const repoPath = path.resolve(args.path ?? process.cwd())
  let refusedCount = 0

  try {
    const result = await runArchive(
      {
        repoPath,
        dataRoot: options.dataRoot,
        answer: { maxAgeMs: args.olderThanMs as number },
        nowMs: options.now?.() ?? Date.now(),
        handle: args.handle,
        outDir: args.outDir,
        dryRun: args.dryRun,
      },
    )
    for (const line of voiceArchiveRun(result)) log.log(line)
    refusedCount = result.outcomes.filter((outcome) => outcome.kind === 'refused').length
    // NO `exit()` inside this `try` — an injected `exit` that throws (the shape
    // `api/lab.ts` uses) would be caught by the `catch` below and a green run
    // reported as a failure. Every sibling command here exits after its
    // try/catch; this one does too, and this comment is why (`cli/index.ts`).
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(refusedCount > 0 ? 1 : 0)
}
