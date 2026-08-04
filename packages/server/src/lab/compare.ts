import path from 'node:path'
import type { Exec, RhizomorphEvent } from '@rhizomorph/core'
import { reduceAll } from '@rhizomorph/core'
import type { ForkDispatchRecord } from '@rhizomorph/core'
import { defaultDataRoot, sessionDirFor } from '../log/paths.js'
import { listSessions, readSessionEvents } from '../log/session-log.js'
import { exec as realExec } from '../server/exec.js'
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

/** prd12 ruling 4's floor. Below this the surface shows runs, never conclusions. */
export const MIN_ARMS_TO_RANK = 3

export type VerifiedOutcome = 'pass' | 'fail' | 'not-run'

export interface ArmComparison {
  arm: number
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
  arms: ArmComparison[]
  /** True when there are enough arms for the table to say anything comparative. */
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
  const exec = options.exec ?? realExec
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
    .sort((a, b) => a.arm - b.arm)

  const first = dispatches[0]
  if (!first) throw new Error(`fork "${options.forkId}" has no readable arms`)

  const arms: ArmComparison[] = []
  for (const dispatch of dispatches) {
    const verification = options.skipVerify === true
      ? { outcome: 'not-run' as const, detail: '--no-verify' }
      : await verifyArm(exec, dispatch.worktreePath, verifyCommand)

    arms.push({
      arm: dispatch.arm,
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

  return {
    forkId: options.forkId,
    parentLane: first.parentLane,
    checkpointId: first.checkpointId,
    arms,
    rankable: arms.length >= MIN_ARMS_TO_RANK,
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
    const line = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? ''
    return { outcome: 'fail', detail: line.length > 0 ? line : `exit ${result.code}` }
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

const COLUMNS = ['arm', 'lane', 'treatment', 'verified', 'cost', 'duration', 'commits'] as const

/**
 * The table, and nothing that resembles a verdict. Rows are always in arm
 * order — NOT sorted by any measurement, because a sorted table is a ranking
 * whether or not it says so.
 */
export function renderComparison(comparison: ForkComparison): string {
  const rows = comparison.arms.map((arm) => [
    String(arm.arm),
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

  const out: string[] = [
    `fork ${comparison.forkId} — ${comparison.arms.length} arm(s) of lane "${comparison.parentLane}" ` +
      `at checkpoint ${comparison.checkpointId}`,
    `verified by: ${comparison.verifyCommand}`,
    '',
    line([...COLUMNS]),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
    '',
  ]

  out.push(...distributionLines(comparison))
  return out.join('\n')
}

/**
 * prd12 ruling 4, both halves. Under three arms this is a refusal; at three or
 * more it is a spread. Neither is a winner.
 */
function distributionLines(comparison: ForkComparison): string[] {
  const n = comparison.arms.length
  if (!comparison.rankable) {
    return [
      `${n} arm(s) — runs only. Ranking needs n >= ${MIN_ARMS_TO_RANK} (prd12 ruling 4:`,
      'a comparison below three arms reports what happened, never which arm was better).',
    ]
  }

  const passed = comparison.arms.filter((arm) => arm.verified === 'pass').length
  const judged = comparison.arms.filter((arm) => arm.verified !== 'not-run').length
  const costs = comparison.arms.map((arm) => arm.costUsd).filter((cost): cost is number => cost !== null)
  const durations = comparison.arms
    .map((arm) => arm.durationMs)
    .filter((duration): duration is number => duration !== null)

  const lines = [
    `distribution over ${n} arms — verified ${passed}/${judged === 0 ? n : judged}` +
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
