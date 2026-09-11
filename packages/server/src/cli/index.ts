import path from 'node:path'
// The one importer the lab namespace law (prd12 ruling 1) allows: this is
// the explicit CLI wiring point, never a collector or background loop.
import { captureCheckpoint } from '../lab/checkpoint.js'
import { compareFork, renderComparison } from '../lab/compare.js'
import { dispatchFork } from '../lab/fork.js'
// prd-55 ruling 1's R&D hand, under the SAME exception as the three above, and
// worth restating here rather than leaving to the law: `lab/rd.ts` spawns the
// operator's own paid CLI, so the one file allowed to reach it is the one an
// operator has to type into — never a collector, never a poll, never a
// background loop (ADR-0048). `lab/namespace-law.test.ts`'s `ALLOWED_IMPORTERS`
// is the single-element set naming this file, and `lab/rd.test.ts` narrows that
// further to `runRdHand` by name.
import { runRdHand } from '../lab/rd.js'
// prd-51 ruling 11's one ordered act — and the ONLY route to a prune anywhere
// in this package: `log/archive.ts` is the sole importer of `log/retention.ts`
// (`log/archive.test.ts` holds that set), so "removing the archive step removes
// the prune" is structural rather than a habit.
import { runArchiveCommand } from './archive.js'
// The one importer the fifth hand's law (ADR-0034 clause 3, prd-51 ruling 14)
// allows: `connect-team.ts` is the sole declared importer of `shipper/` and
// the sole site permitted to construct its timer. This is the dispatch entry
// and nothing more.
import { runConnectCommand } from './connect-team.js'
import { runDoctorCommand } from './doctor.js'
import { runEnvCommand } from './env.js'
import { runExportOtlpCommand } from './export-otlp.js'
import { runExportRecordCommand } from './export-record.js'
import { labHelpText } from './lab.js'
import { labCheckpointHelpText, parseLabCheckpointArgs } from './lab-checkpoint.js'
import { labCompareHelpText, parseLabCompareArgs } from './lab-compare.js'
import { labForkHelpText, parseLabForkArgs } from './lab-fork.js'
import { labRdHelpText, parseLabRdArgs } from './lab-rd.js'
import { runLabelCommand } from './label.js'
import { runReplayCommand } from './replay.js'
import { runRotateCommand } from './rotate.js'
import { runServerCommand } from './run.js'
import { runSessionsCommand } from './sessions.js'
import type { CliHandle, RunCliOptions } from './types.js'

export type { CliHandle, RunCliOptions } from './types.js'

/**
 * The CLI's one entry point: dispatches on `argv[0]` to each subcommand's own
 * module, falling through to `runServerCommand` (the bare `rhizomorph [path]`
 * form) when nothing matches. Each subcommand owns its own parsing, help text
 * and clean-usage-error contract — a bad argv prints to stderr and exits 1,
 * `--help` prints to stdout and exits 0, no stack trace either way (#30/#32
 * conventions) — this function only routes.
 */
export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<CliHandle> {
  const log = options.log ?? console
  const exit: (code: number) => never = options.exit ?? ((code) => process.exit(code))

  if (argv[0] === 'env') {
    return runEnvCommand(argv.slice(1), log, exit)
  }

  if (argv[0] === 'connect') {
    return runConnectCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'doctor') {
    return runDoctorCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'export-record') {
    return runExportRecordCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'export-otlp') {
    return runExportOtlpCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'archive') {
    return runArchiveCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'replay') {
    return runReplayCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'sessions') {
    return runSessionsCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'label') {
    return runLabelCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'rotate') {
    return runRotateCommand(argv.slice(1), log, exit)
  }

  if (argv[0] === 'lab') {
    return runLabCommand(argv.slice(1), log, exit, options)
  }

  return runServerCommand(argv, options, log, exit)
}

/**
 * `rhizomorph lab <subcommand>` — the laboratory's namespace (prd12 ruling
 * 1): `checkpoint` (capture, #148), `fork` (restore + dispatch), `compare`
 * (the table) and `rd` (prd-55 ruling 1's R&D hand). An unknown subcommand, or
 * a bare `rhizomorph lab`, prints the namespace's own usage table.
 *
 * This function is the ONLY way into `server/src/lab/` — the namespace law
 * test asserts no other source file in the package imports it, so there is no
 * background caller and nothing runs without the operator typing it. `rd` is
 * the branch that makes that sentence cost money if it were ever untrue: it
 * spawns the operator's own paid CLI (ADR-0048), which is why the law is
 * structural rather than a convention.
 */
async function runLabCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  if (rest[0] === 'checkpoint') {
    return runLabCheckpointCommand(rest.slice(1), log, exit, options)
  }

  if (rest[0] === 'fork') {
    return runLabForkCommand(rest.slice(1), log, exit, options)
  }

  if (rest[0] === 'compare') {
    return runLabCompareCommand(rest.slice(1), log, exit, options)
  }

  if (rest[0] === 'rd') {
    return runLabRdCommand(rest.slice(1), log, exit, options)
  }

  if (rest.length === 0 || rest.includes('--help') || rest.includes('-h')) {
    log.log(labHelpText())
    exit(0)
  }

  process.stderr.write(`unknown lab subcommand: "${rest[0]}"\n\n${labHelpText()}`)
  exit(1)
}

/**
 * `rhizomorph lab checkpoint <lane>` — the explicit hand prd12 ruling 1
 * requires: a one-shot, standalone subcommand (no server boot) that captures
 * a live workspace + session snapshot and emits it as a `fork.checkpoint`
 * event. Same clean-usage-error contract as every other subcommand here.
 */
async function runLabCheckpointCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseLabCheckpointArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${labCheckpointHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(labCheckpointHelpText())
    exit(0)
  }

  const worktreePath = path.resolve(args.path ?? process.cwd())

  try {
    const { event } = await captureCheckpoint({
      lane: args.lane,
      worktreePath,
      capturedBy: args.capturedBy,
      exec: options.exec,
      now: options.now,
      dataRoot: options.dataRoot,
      claudeProjectsRoot: options.claudeProjectsRoot,
    })
    log.log(
      `checkpoint ${event.payload.checkpointId} captured for lane "${event.payload.lane}" — ` +
        `${event.payload.snapshotRef} @ ${event.payload.snapshotSha.slice(0, 12)}, ` +
        `session cut at byte ${event.payload.sessionCutByte}`,
    )
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}

/**
 * `rhizomorph lab fork <lane>` — restores n arms of one checkpoint and records
 * each as a `fork.dispatched`. Prints, per arm, the worktree it lives in, the
 * session synthesized for it, and the launcher command line — run for you only
 * when `--launch` says so (see `lab/fork.ts`'s module doc for why that write is
 * the operator's to authorise).
 */
async function runLabForkCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseLabForkArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${labForkHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(labForkHelpText())
    exit(0)
  }

  const parentWorktreePath = path.resolve(args.path ?? process.cwd())

  try {
    const result = await dispatchFork({
      parentLane: args.lane,
      parentWorktreePath,
      checkpointId: args.at,
      arms: args.arms,
      runs: args.runs,
      forkId: args.forkId,
      armNumber: args.armNumber,
      ceilingOverride: args.ceilingOverride,
      proposalId: args.proposal,
      model: args.model,
      promptFile: args.promptFile,
      launch: args.launch,
      exec: options.exec,
      now: options.now,
      dataRoot: options.dataRoot,
      claudeProjectsRoot: options.claudeProjectsRoot,
    })

    // `api/lab.ts`'s `parseForkStdout` reads exactly these lines back; a run
    // number appears only from the second run of an arm, so a single-run
    // dispatch prints what it always printed.
    const armCount = result.arms.length / result.runs
    log.log(
      `fork ${result.forkId} — ${armCount} arm(s)${result.runs > 1 ? ` × ${result.runs} run(s)` : ''} of lane "${result.parentLane}" ` +
        `restored from checkpoint ${result.checkpointId}`,
    )
    for (const arm of result.arms) {
      log.log(
        `  arm ${arm.arm}${arm.run > 1 ? ` run ${arm.run}` : ''}  ${arm.laneHandle}\n` +
          `    worktree  ${arm.worktreePath}\n` +
          `    session   ${arm.session.filePath} (${arm.session.linesCopied} lines, ` +
          `${arm.session.rewrites[0]?.count ?? 0} paths rewritten to this tree)` +
          (arm.launcherSession === null
            ? ''
            : `\n    session   ${arm.launcherSession.filePath} (the launcher's own tree)`) +
          `\n    launch    ${arm.launched ? 'ran: ' : 'not run — run it yourself: '}${arm.launcherArgv.join(' ')}`,
      )
    }
    if (!args.launch) {
      log.log(
        '\nNo tmux window was opened and no branch was created: prd12 ruling 1 confines the\n' +
          "laboratory's writes to refs/rhizomorph/, its own worktrees and its data dir, and\n" +
          "'workmux add' writes outside all three. Pass --launch to authorise that yourself.",
      )
    }
    log.log(`\nCompare them with: rhizomorph lab compare ${result.forkId} --path ${parentWorktreePath}`)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}

/**
 * `rhizomorph lab compare <fork-id>` — prd12 ruling 6's table, and ruling 4's
 * refusal to rank below three arms. Exits 0 whether or not the arms passed
 * their gate: the command's job is to report, and a failing arm is a result,
 * not a CLI error.
 */
async function runLabCompareCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseLabCompareArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${labCompareHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(labCompareHelpText())
    exit(0)
  }

  const parentWorktreePath = path.resolve(args.path ?? process.cwd())

  try {
    const comparison = await compareFork({
      forkId: args.forkId,
      parentWorktreePath,
      verifyCommand: args.verify,
      skipVerify: args.skipVerify,
      exec: options.exec,
      dataRoot: options.dataRoot,
    })
    // `--json` is the document `api/lab.ts`'s measure route reads back through
    // `runCli` (prd53 ruling 3) — the whole `ForkComparison`, nothing summarised
    // away. The table stays the human's.
    log.log(args.json ? JSON.stringify(comparison) : renderComparison(comparison))
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}

/**
 * `rhizomorph lab rd <lane> --model <m>` — prd-55 ruling 1's R&D hand, from
 * the operator's own command line. Reads the corpus the record already holds,
 * spawns the operator's OWN CLI with no tools granted, validates the answer
 * against core's schema and records what it grouped and proposed.
 *
 * Exits 0 when the hand is not on this machine's PATH, and that is deliberate
 * rather than lenient: "there is no claude here" is an ANSWER (ruling 9 draws
 * it as a state of the control), not a command that failed. The sentence is
 * printed, `--json`'s document carries `available: false` beside it, and
 * nothing was spawned. The same reasoning `lab compare` gives for exiting 0 on
 * a failing arm — the command's job is to report.
 */
async function runLabRdCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseLabRdArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${labRdHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(labRdHelpText())
    exit(0)
  }

  const repoPath = path.resolve(args.path ?? process.cwd())

  try {
    const result = await runRdHand({
      lane: args.lane,
      repoPath,
      model: args.model,
      corpus: args.corpus,
      maxTurns: args.maxTurns,
      agentCommand: args.agentCommand,
      exec: options.exec,
      now: options.now,
      dataRoot: options.dataRoot,
    })

    if (args.json) {
      // The document `api/lab.ts`'s R&D route reads back through `runCli` —
      // `runCli` is the only door the namespace law leaves a route, and a typed
      // document is a thing a route can trust where prose is a thing it would
      // have to guess at. `events` is carried as ids rather than whole
      // envelopes: the route's caller reads the fold, not a second copy of it.
      log.log(
        JSON.stringify({
          lane: result.lane,
          available: result.available,
          reason: result.reason,
          corpus: {
            choice: result.corpus.choice,
            digest: result.corpus.digest,
            itemCount: result.corpus.items.length,
            trackerRefusal: result.corpus.trackerRefusal,
          },
          patterns: result.patterns,
          proposals: result.proposals,
          refusals: result.refusals,
          provenance: result.provenance,
          turns: result.turns,
          recordedTo: result.recordedTo,
          eventIds: result.events.map((event) => event.id),
        }),
      )
    } else if (!result.available) {
      log.log(result.reason ?? '')
    } else {
      renderRdReport(log, result)
    }
    // NO `exit()` inside this `try`. The injected `exit` (`api/lab.ts`'s
    // `runLabCliOnce`) THROWS to unwind without touching the real process, so
    // an `exit(0)` on the success path is caught by the `catch` below, written
    // to stderr as `[object Object]`, and turned into exit 1 — a green run
    // reported as a failure. Every sibling command here already exits after
    // its try/catch; this one now does too, and this comment is why.
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}

/** `rhizomorph lab rd`'s human report — the provenance line prd-55 S5 names, then patterns, proposals and refusals. */
function renderRdReport(log: Pick<Console, 'log' | 'warn'>, result: Awaited<ReturnType<typeof runRdHand>>): void {
  const { provenance } = result
  log.log(
    `R&D run for lane "${result.lane}" — corpus ${result.corpus.choice} ` +
      `(${result.corpus.items.length} item(s), digest ${result.corpus.digest.slice(0, 12)})`,
  )
  if (provenance !== null) {
    log.log(
      `  ${provenance.model} · ${provenance.claudeVersion} · $${provenance.total_cost_usd.toFixed(4)} · ` +
        `${provenance.duration_ms}ms · ${result.turns} turn(s)`,
    )
  }
  if (result.corpus.trackerRefusal !== null) log.log(`  ${result.corpus.trackerRefusal}`)

  log.log(`\npatterns (${result.patterns.length})`)
  for (const pattern of result.patterns) {
    log.log(`  ${pattern.patternId}  ${pattern.shape}\n    ${pattern.count} item(s)${pattern.heldBack ? ' — held back' : ''}`)
  }

  log.log(`\nproposals (${result.proposals.length})`)
  for (const proposal of result.proposals) {
    log.log(
      `  ${proposal.proposalId}  varies ${proposal.varies}, ${proposal.arms.length} arm(s), ` +
        `from checkpoint ${proposal.checkpointPick.chosenCheckpointId}`,
    )
  }

  // Printed whether or not there are any, because "nothing was refused" is
  // itself a fact about the run and an absent section reads as an omission.
  log.log(`\nrefused (${result.refusals.length})`)
  for (const refusal of result.refusals) {
    log.log(`  ${refusal.patternId}  ${refusal.reason}`)
  }

  if (result.recordedTo !== null) log.log(`\nrecorded to ${result.recordedTo}`)
}
