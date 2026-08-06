import path from 'node:path'
// The one importer the lab namespace law (prd12 ruling 1) allows: this is
// the explicit CLI wiring point, never a collector or background loop.
import { captureCheckpoint } from '../lab/checkpoint.js'
import { compareFork, renderComparison } from '../lab/compare.js'
import { dispatchFork } from '../lab/fork.js'
import { runDoctorCommand } from './doctor.js'
import { runEnvCommand } from './env.js'
import { runExportRecordCommand } from './export-record.js'
import { runLabelCommand } from './label.js'
import { labCompareHelpText, parseLabCompareArgs } from './lab-compare.js'
import { labCheckpointHelpText, parseLabCheckpointArgs } from './lab-checkpoint.js'
import { labForkHelpText, parseLabForkArgs } from './lab-fork.js'
import { labHelpText } from './lab.js'
import { runReplayCommand } from './replay.js'
import { runRotateCommand } from './rotate.js'
import { runServerCommand } from './run.js'
import { runSessionsCommand } from './sessions.js'
import type { CliHandle, RunCliOptions } from './types.js'

export type { RunCliOptions, CliHandle } from './types.js'

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

  if (argv[0] === 'doctor') {
    return runDoctorCommand(argv.slice(1), log, exit, options)
  }

  if (argv[0] === 'export-record') {
    return runExportRecordCommand(argv.slice(1), log, exit, options)
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
 * 1): `checkpoint` (capture, #148), `fork` (restore + dispatch) and `compare`
 * (the table). An unknown subcommand, or a bare `rhizomorph lab`, prints the
 * namespace's own usage table.
 *
 * This function is the ONLY way into `server/src/lab/` — the namespace law
 * test asserts no other source file in the package imports it, so there is no
 * background caller and nothing runs without the operator typing it.
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
      model: args.model,
      promptFile: args.promptFile,
      launch: args.launch,
      exec: options.exec,
      now: options.now,
      dataRoot: options.dataRoot,
      claudeProjectsRoot: options.claudeProjectsRoot,
    })

    log.log(
      `fork ${result.forkId} — ${result.arms.length} arm(s) of lane "${result.parentLane}" ` +
        `restored from checkpoint ${result.checkpointId}`,
    )
    for (const arm of result.arms) {
      log.log(
        `  arm ${arm.arm}  ${arm.laneHandle}\n` +
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
    log.log(renderComparison(comparison))
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}
