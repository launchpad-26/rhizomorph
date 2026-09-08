import path from 'node:path'
import type { Exec, ForkDispatchRecord, RhizomorphEvent } from '@rhizomorph/core'
import {
  COUNTERFACTUAL_CLAUSE,
  canRankArms,
  canSummariseArm,
  confoundVoice,
  dimensionsOf,
  isCompletedVerdict,
  MIN_ARMS_TO_RANK,
  MIN_COMPLETED_RUNS_TO_SUMMARISE,
  reduceAll,
} from '@rhizomorph/core'
import { defaultDataRoot, sessionDirFor } from '../log/paths.js'
import { listSessions, readSessionEvents } from '../log/session-log.js'
import { describeExecFailure, exec as realExec, withTimeout } from '../server/exec.js'
import { runGit } from './git.js'

/**
 * prd12 ruling 6's comparison surface: a TABLE, not a visualization, and
 * ruling 4's Goodhart guard on top of it — n≥3 arms before any surface may
 * rank, and even then a DISTRIBUTION, never a "winner" line.
 *
 * The two rulings pull in the same direction and this module obeys both
 * literally:
 *
 * - Below three arms, {@link renderComparison} prints the runs and a refusal.
 *   No ordering, no best-of, no arrow. Two arms is an anecdote.
 * - At three or more, it prints the runs AND a distribution — how many
 *   verified, the spread of cost and duration. Still no winner: a table that
 *   names one is a table that has decided for you, which is the thing ruling 4
 *   exists to prevent.
 *
 * Verification is a real command really run (`--verify`, default `npm test`)
 * in the arm's own worktree, and its outcome is reported as pass, fail, or
 * "not run" — never inferred from an exit code nobody produced.
 */

export const DEFAULT_VERIFY_COMMAND = 'npm test'

/**
 * prd12 ruling 4's floor — re-exported, not restated (prd53 ruling 2). The
 * number lives once, in `@rhizomorph/core`'s lab laws, where the console's
 * summariser reads it too; `compare.test.ts`'s grep law fails the build if a
 * local copy ever comes back here. Below it the surface shows runs, never
 * conclusions.
 */
export { MIN_ARMS_TO_RANK } from '@rhizomorph/core'

/** Per-exec ceiling for the git plumbing this module runs (`countCommits`) — same value as `ROUTE_EXEC_TIMEOUT_MS` / `RETARGET_EXEC_TIMEOUT_MS`. A hung git call must not hang `compareFork` itself. NOT used for the verify command — see {@link COMPARE_VERIFY_TIMEOUT_MS}, which is the sibling of `RESTORE_EXEC_TIMEOUT_MS`, not of this one: a gate command is a wider thing to wait on than git plumbing, same as a dependency install is (`docs/design-notes/lab-launch-ceilings.md`). */
export const COMPARE_EXEC_TIMEOUT_MS = 5000

/**
 * Per-exec ceiling for the verify command (`verifyArm`), whose default is
 * `npm test` — a real test suite, not git plumbing. This repo's own suite runs
 * ~39s wall on an idle box (~186s of summed worker time, which is the figure
 * the review quoted); `COMPARE_EXEC_TIMEOUT_MS`'s 5s killed every real arm
 * before it could finish either way (prd41 PR #123 review, Blocking 2). 10
 * minutes is a ceiling on
 * operator patience for a gate run, not a performance budget, in the same
 * spirit as `RESTORE_EXEC_TIMEOUT_MS`: past ten minutes a verify command is
 * wedged, not slow. See `docs/design-notes/lab-launch-ceilings.md`.
 */
export const COMPARE_VERIFY_TIMEOUT_MS = 600_000

export type VerifiedOutcome = 'pass' | 'fail' | 'not-run'

export interface ArmComparison {
  arm: number
  /** 1-based run within the arm (prd53 ruling 1) — one row per run, so an arm with three runs is three rows. */
  run: number
  laneHandle: string
  worktreePath: string
  /** Model varied for this arm, or null when it ran the fleet default. */
  model: string | null
  /** Short prefix of the arm's prompt digest, or null when it ran without a prompt file. */
  promptDigest: string | null
  verified: VerifiedOutcome
  /** Why an outcome is what it is — the failing command's first stderr line, or the reason it was not run. */
  verifiedDetail: string | null
  /** Dollars booked to this arm's lane in the event log. Null when nothing has been recorded yet. */
  costUsd: number | null
  /** Dispatch → newest recorded event for the lane, in ms. Null when nothing has been recorded since. */
  durationMs: number | null
  /** Commits the arm made on top of its restored snapshot. Null when the worktree could not be read. */
  commits: number | null
}

export interface ForkComparison {
  forkId: string
  parentLane: string
  checkpointId: string
  /** One row per RUN, arm-major then run order. `arms.length` is the run count, not the arm count. */
  arms: ArmComparison[]
  /** Distinct arms — the denominator a cross-arm claim is gated on (prd53 ruling 2), never the row count. */
  armCount: number
  /** True when there are enough ARMS for the table to say anything comparative — `canRankArms(armCount)`. */
  rankable: boolean
  verifyCommand: string
}

export interface CompareForkOptions {
  forkId: string
  /** The parent lane's worktree — its data dir holds the log the fork was recorded in. */
  parentWorktreePath: string
  /** Gate command each arm is judged by. Default `npm test`. */
  verifyCommand?: string
  /** Skip running the gate; every arm reports `not-run`. */
  skipVerify?: boolean
  exec?: Exec
  dataRoot?: string
}

export async function compareFork(options: CompareForkOptions): Promise<ForkComparison> {
  const exec = withTimeout(options.exec ?? realExec, COMPARE_EXEC_TIMEOUT_MS)
  const verifyExec = withTimeout(options.exec ?? realExec, COMPARE_VERIFY_TIMEOUT_MS)
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const verifyCommand = options.verifyCommand ?? DEFAULT_VERIFY_COMMAND

  const events = await readAllEvents(sessionDirFor(options.parentWorktreePath, dataRoot))
  const state = reduceAll(events)

  const positions = state.forks.byFork[options.forkId]
  if (positions === undefined || positions.length === 0) {
    throw new Error(
      `no fork "${options.forkId}" recorded for ${options.parentWorktreePath} — ` +
        'run \'rhizomorph lab fork <lane>\' first, or check the fork id',
    )
  }

  const dispatches = positions
    .map((at) => state.forks.dispatches[at])
    .filter((record): record is ForkDispatchRecord => record !== undefined)
    .sort((a, b) => a.arm - b.arm || a.run - b.run)

  const first = dispatches[0]
  if (!first) throw new Error(`fork "${options.forkId}" has no readable arms`)

  const arms: ArmComparison[] = []
  for (const dispatch of dispatches) {
    const verification = options.skipVerify === true
      ? { outcome: 'not-run' as const, detail: '--no-verify' }
      : await verifyArm(verifyExec, dispatch.worktreePath, verifyCommand)

    arms.push({
      arm: dispatch.arm,
      run: dispatch.run,
      laneHandle: dispatch.laneHandle,
      worktreePath: dispatch.worktreePath,
      model: dispatch.model,
      promptDigest: dispatch.promptDigest,
      verified: verification.outcome,
      verifiedDetail: verification.detail,
      costUsd: laneCost(state, dispatch.laneHandle),
      durationMs: laneDuration(events, dispatch),
      commits: await countCommits(exec, dispatch.worktreePath, dispatch.checkpointId),
    })
  }

  // Arms, not rows: since prd53 ruling 1 an arm holds r runs and each run is a
  // row, so `arms.length` stopped meaning "arms" the moment runs became real.
  // Three runs of one arm are three observations of one treatment — nothing
  // to compare across (prd53 ruling 2).
  const armCount = new Set(dispatches.map((dispatch) => dispatch.arm)).size

  return {
    forkId: options.forkId,
    parentLane: first.parentLane,
    checkpointId: first.checkpointId,
    arms,
    armCount,
    rankable: canRankArms(armCount),
    verifyCommand,
  }
}

// --- the measurements --------------------------------------------------------------

async function verifyArm(
  exec: Exec,
  worktreePath: string,
  command: string,
): Promise<{ outcome: VerifiedOutcome; detail: string | null }> {
  // argv form, never a shell string — the same rule every collector follows.
  const parts = command.split(/\s+/).filter((part) => part.length > 0)
  const binary = parts[0]
  if (binary === undefined) return { outcome: 'not-run', detail: 'empty verify command' }

  const result = await exec(binary, parts.slice(1), { cwd: worktreePath })
  if (result.errorMessage !== undefined) {
    // The binary could not be run at all. That is not a failing gate; saying
    // "fail" here would book a tooling gap against the arm's treatment.
    return { outcome: 'not-run', detail: result.errorMessage }
  }
  if (result.failed) {
    // `describeExecFailure`, not a fourth hand-rolled copy of it (#306's git
    // collector, #425's three judge readers, `restore.ts`'s npm install were
    // the first three). A verify command killed on `COMPARE_VERIFY_TIMEOUT_MS`
    // reports `code: null` with no stderr — the exact shape a two-arm
    // `stderr || stdout` spelling renders as the useless `exit null`, same as
    // the three before it. The first line of stdout is kept as a fallback
    // ABOVE that: a failing test command more often explains itself there
    // than on stderr, and `describeExecFailure` only reads the latter.
    const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''
    const stderrLine = firstLine(result.stderr)
    const stdoutLine = firstLine(result.stdout)
    const detail = stderrLine.length > 0 ? stderrLine : stdoutLine.length > 0 ? stdoutLine : describeExecFailure(result)
    return { outcome: 'fail', detail }
  }
  return { outcome: 'pass', detail: null }
}

/**
 * Commits the arm added ON TOP of the reality it was restored into — HEAD's
 * distance from the checkpoint's own snapshot commit, which the arm's worktree
 * can resolve because it shares the parent repo's object store.
 *
 * Null, not zero, when it cannot be measured: an arm whose worktree has been
 * removed has an unknown commit count, and reporting that as `0` would be a
 * quiet lie in a table whose whole job is to be trusted.
 */
async function countCommits(exec: Exec, worktreePath: string, checkpointId: string): Promise<number | null> {
  const snapshotRef = `refs/rhizomorph/checkpoints/${checkpointId}`
  try {
    const count = (
      await runGit(exec, worktreePath, ['rev-list', '--count', `${snapshotRef}..HEAD`])
    ).trim()
    const parsed = Number(count)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
  } catch {
    return null
  }
}

function laneCost(state: ReturnType<typeof reduceAll>, laneHandle: string): number | null {
  const booked = state.telemetry.costs.filter((cost) => cost.lane === laneHandle)
  if (booked.length === 0) return null
  return booked.reduce((sum, cost) => sum + cost.costUsd, 0)
}

/** Dispatch → the newest event recorded for the arm's lane. Null while nothing has come back yet. */
function laneDuration(events: readonly RhizomorphEvent[], dispatch: ForkDispatchRecord): number | null {
  let newest: number | null = null
  for (const event of events) {
    if (event.ts <= dispatch.ts) continue
    if (!mentionsLane(event, dispatch.laneHandle)) continue
    newest = newest === null ? event.ts : Math.max(newest, event.ts)
  }
  return newest === null ? null : newest - dispatch.ts
}

function mentionsLane(event: RhizomorphEvent, laneHandle: string): boolean {
  const payload = event.payload as Record<string, unknown>
  return payload['lane'] === laneHandle || payload['handle'] === laneHandle
}

async function readAllEvents(sessionDir: string): Promise<RhizomorphEvent[]> {
  const sessions = await listSessions(sessionDir)
  const events: RhizomorphEvent[] = []
  for (const session of sessions) {
    events.push(...(await readSessionEvents(path.join(sessionDir, session.fileName))))
  }
  return events
}

// --- the table ------------------------------------------------------------------

const COLUMNS = ['arm', 'run', 'lane', 'treatment', 'verified', 'cost', 'duration', 'commits'] as const

/**
 * The table, and nothing that resembles a verdict. Rows are always in arm
 * order — NOT sorted by any measurement, because a sorted table is a ranking
 * whether or not it says so.
 *
 * Three sentences core owns are printed here verbatim or not at all (prd53
 * ruling 2): the confound voice when arms differ in both model and brief, the
 * counterfactual clause below the floor, and the per-arm summary verdict once
 * an arm holds more than one run — the same functions the console reads.
 */
export function renderComparison(comparison: ForkComparison): string {
  const rows = comparison.arms.map((arm) => [
    String(arm.arm),
    String(arm.run),
    arm.laneHandle,
    formatTreatment(arm),
    formatVerified(arm),
    arm.costUsd === null ? '—' : `$${arm.costUsd.toFixed(4)}`,
    arm.durationMs === null ? '—' : formatDuration(arm.durationMs),
    arm.commits === null ? '—' : String(arm.commits),
  ])

  const widths = COLUMNS.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => (row[column] ?? '').length)),
  )
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()

  const runs = comparison.arms.length
  const runsNote = runs === comparison.armCount ? '' : `, ${runs} run(s)`
  const out: string[] = [
    `fork ${comparison.forkId} — ${comparison.armCount} arm(s)${runsNote} of lane "${comparison.parentLane}" ` +
      `at checkpoint ${comparison.checkpointId}`,
    `verified by: ${comparison.verifyCommand}`,
    '',
    line([...COLUMNS]),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
    '',
  ]

  out.push(...distributionLines(comparison))
  out.push(...armSummaryLines(comparison))

  // The confound clause, whatever the arm count: two arms that differ in both
  // dimensions are not an anecdote about a treatment, they are an anecdote
  // about two. Printed in core's words, so the console says the same thing.
  const voice = confoundVoice(dimensionsOf(comparison.arms))
  if (voice !== null) out.push(voice)

  return out.join('\n')
}

/**
 * prd12 ruling 4, both halves. Under three arms this is a refusal; at three or
 * more it is a spread. Neither is a winner. The denominator is ARMS (prd53
 * ruling 2): the spread is still taken over every run, and says so.
 */
function distributionLines(comparison: ForkComparison): string[] {
  const n = comparison.arms.length
  const arms = comparison.armCount
  if (!comparison.rankable) {
    return [
      `${arms} arm(s) — runs only. Ranking needs n >= ${MIN_ARMS_TO_RANK} (prd12 ruling 4:`,
      'a comparison below three arms reports what happened, never which arm was better).',
      `${COUNTERFACTUAL_CLAUSE}.`,
    ]
  }

  const passed = comparison.arms.filter((arm) => arm.verified === 'pass').length
  const judged = comparison.arms.filter((arm) => isCompletedVerdict(arm.verified)).length
  const costs = comparison.arms.map((arm) => arm.costUsd).filter((cost): cost is number => cost !== null)
  const durations = comparison.arms
    .map((arm) => arm.durationMs)
    .filter((duration): duration is number => duration !== null)

  const lines = [
    `distribution over ${arms} arms${n === arms ? '' : ` (${n} runs)`} — verified ${passed}/${judged === 0 ? n : judged}` +
      (judged < n ? ` (${n - judged} not run)` : ''),
  ]
  if (costs.length > 0) {
    lines.push(`  cost      ${spread(costs, (value) => `$${value.toFixed(4)}`)}`)
  }
  if (durations.length > 0) {
    lines.push(`  duration  ${spread(durations, formatDuration)}`)
  }
  lines.push('no winner is named: prd12 ruling 4 reports distributions, and the choice stays yours.')
  return lines
}

/**
 * One line per arm, only once some arm holds more than one run — a single-run
 * fork prints exactly what it always printed. Whether an arm's runs may be
 * summarised is core's call (`canSummariseArm` over the runs a gate JUDGED —
 * core's `isCompletedVerdict`, pass or fail), the same count the console's
 * summariser and Metrics use; `web/src/lab/floor-agreement-law.test.ts` holds
 * the three to one answer.
 */
function armSummaryLines(comparison: ForkComparison): string[] {
  if (comparison.arms.length === comparison.armCount) return []
  const byArm = new Map<number, ArmComparison[]>()
  for (const row of comparison.arms) {
    byArm.set(row.arm, [...(byArm.get(row.arm) ?? []), row])
  }
  const lines: string[] = ['']
  for (const [arm, rows] of byArm) {
    const measured = rows.filter((row) => isCompletedVerdict(row.verified)).length
    const verdict = canSummariseArm(measured)
      ? 'a summary may be stated'
      : `no summary — ${COUNTERFACTUAL_CLAUSE} (needs ${MIN_COMPLETED_RUNS_TO_SUMMARISE} measured)`
    lines.push(`arm ${arm}: ${rows.length} run(s), ${measured} measured — ${verdict}`)
  }
  return lines
}

function spread(values: readonly number[], format: (value: number) => string): string {
  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0] as number
  const max = sorted[sorted.length - 1] as number
  const median = sorted[Math.floor((sorted.length - 1) / 2)] as number
  return `min ${format(min)} · median ${format(median)} · max ${format(max)}  (n=${sorted.length})`
}

function formatTreatment(arm: ArmComparison): string {
  const model = arm.model ?? 'default'
  const prompt = arm.promptDigest === null ? 'no-prompt' : `prompt:${arm.promptDigest.slice(0, 8)}`
  return `${model} / ${prompt}`
}

function formatVerified(arm: ArmComparison): string {
  if (arm.verified === 'not-run') return `not-run${arm.verifiedDetail === null ? '' : ` (${arm.verifiedDetail})`}`
  return arm.verified
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
}
