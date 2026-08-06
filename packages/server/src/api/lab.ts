import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, RhizomorphEvent } from '@rhizomorph/core'
import { reduceAll, selectSpendRateByLane } from '@rhizomorph/core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { listSessions, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import type { ServerContext } from '../server/context.js'

/**
 * Read-only routes over the laboratory's own event slice (prd12 rulings 2/3;
 * prd14 wave 1 — "the seam and the route"): every `fork.checkpoint` this repo
 * has captured, and every experiment (`fork.dispatched`, grouped by forkId)
 * it has run.
 *
 * These routes read `@rhizomorph/core`'s fold directly (`reduceAll` →
 * `state.checkpoints` / `state.forks`) rather than importing anything under
 * `server/src/lab/` — `lab/namespace-law.test.ts` confines that module to its
 * one CLI wiring point (prd12 ruling 1: the laboratory is a second,
 * explicitly-invoked hand, never reachable from a request a background
 * process — or an always-on server route — could trigger). A GET here can
 * never write; it folds the same log every other route already reads.
 *
 * `POST /api/lab/launch` (prd14 ruling 2/4 — wave 2, "the act of launching an
 * experiment") is the one write this file adds, and it reaches the
 * laboratory the SAME way `namespace-law.test.ts` already requires: through
 * `runCli(['lab', 'fork', ...])`, in-process, exactly the call
 * `packages/server/src/cli/index.ts` is the one declared importer for. That
 * satisfies the namespace law's letter (this file's own import specifiers
 * never mention `lab/`) and its spirit (prd12 ruling 1's "a UI button is an
 * explicit human invocation and is permitted" — the CLI is still the only
 * hand that ever touches `fork.ts`/`checkpoint.ts`; this route is the human's
 * finger on it, not a new one). See `explicit-invocation-law` below for the
 * structural proof that nothing else reaches it.
 *
 * `runCli` is loaded with a dynamic `import()` inside {@link runLabCliOnce}
 * rather than a static import at the top of this file: `cli/index.ts` itself
 * imports `server/build-app.js`, which registers THIS file's routes — a
 * static import here would close that into a load-time cycle. A dynamic
 * import resolves the same module after the graph has already settled, so
 * the cycle never has to run.
 */

export interface LabCheckpointDTO {
  eventId: string
  lane: string
  checkpointId: string
  capturedAt: number
  capturedBy: string
  snapshotRef: string
  snapshotSha: string
  headSha: string
}

export interface LabTreatmentDTO {
  model: string | null
  promptDigest: string | null
}

export interface LabRunDTO {
  eventId: string
  dispatchedAt: number
  laneHandle: string
  worktreePath: string
}

export interface LabArmDTO {
  arm: number
  treatment: LabTreatmentDTO
  runs: LabRunDTO[]
}

export interface LabExperimentDTO {
  forkId: string
  parentLane: string
  checkpointId: string
  arms: LabArmDTO[]
}

/**
 * Every event this repo has recorded, across every session file plus the
 * live recorder's own buffer — the same merge `log/listing.ts`'s
 * `listSessionListings` performs, so a request can never race the live
 * writer's append (reads the buffer, not the file it hasn't flushed to yet).
 */
async function readAllEvents(ctx: ServerContext): Promise<RhizomorphEvent[]> {
  const summaries = await listSessions(ctx.sessionDir)
  const events: RhizomorphEvent[] = []
  let sawLive = false

  for (const summary of summaries) {
    if (summary.id === ctx.recorder.sessionId) {
      sawLive = true
      events.push(...ctx.recorder.eventsSoFar())
    } else {
      events.push(...(await readSessionEvents(sessionFilePath(ctx.sessionDir, summary.id))))
    }
  }

  // The live session may not have a file on disk yet (its first event hasn't
  // landed) — `listSessions` only sees files, so its buffer would otherwise
  // be missing entirely rather than just late.
  if (!sawLive) events.push(...ctx.recorder.eventsSoFar())

  return events
}

/** `state.checkpoints.records`, oldest first — the same chronological order `GET /api/sessions` lists in. */
function checkpointDTOs(events: readonly RhizomorphEvent[]): LabCheckpointDTO[] {
  const state = reduceAll(events)
  return state.checkpoints.records.map((record) => ({
    eventId: record.eventId,
    lane: record.lane,
    checkpointId: record.checkpointId,
    capturedAt: record.ts,
    capturedBy: record.capturedBy,
    snapshotRef: record.snapshotRef,
    snapshotSha: record.snapshotSha,
    headSha: record.headSha,
  }))
}

/**
 * `state.forks.dispatches`, grouped first by `forkId` (an experiment), then
 * by `arm` number within it (one arm, one or more runs) — mirroring
 * `lab/compare.ts`'s own grouping over the identical state, without
 * importing that module (see the file doc).
 */
function experimentDTOs(events: readonly RhizomorphEvent[]): LabExperimentDTO[] {
  const state = reduceAll(events)
  const experiments: LabExperimentDTO[] = []

  for (const forkId of Object.keys(state.forks.byFork)) {
    const positions = state.forks.byFork[forkId] ?? []
    const dispatches = positions.map((at) => state.forks.dispatches[at]).filter((d) => d !== undefined)
    if (dispatches.length === 0) continue

    const armsByNumber = new Map<number, LabArmDTO>()
    for (const dispatch of dispatches) {
      const run: LabRunDTO = {
        eventId: dispatch.eventId,
        dispatchedAt: dispatch.ts,
        laneHandle: dispatch.laneHandle,
        worktreePath: dispatch.worktreePath,
      }
      const existing = armsByNumber.get(dispatch.arm)
      if (existing === undefined) {
        armsByNumber.set(dispatch.arm, {
          arm: dispatch.arm,
          treatment: { model: dispatch.model, promptDigest: dispatch.promptDigest },
          runs: [run],
        })
      } else {
        existing.runs.push(run)
      }
    }

    const first = dispatches[0]
    if (first === undefined) continue
    experiments.push({
      forkId,
      parentLane: first.parentLane,
      checkpointId: first.checkpointId,
      arms: [...armsByNumber.values()].sort((a, b) => a.arm - b.arm),
    })
  }

  return experiments
}

// --- estimate (prd14 ruling 4: an estimate never appears without its basis) ------

/** An hour: long enough that one lane's ordinary lull between requests doesn't read as "no rate". */
const ESTIMATE_WINDOW_MS = 60 * 60_000

export interface LabEstimateResult {
  lane: string
  arms: number
  /** False means "the rate cannot be established" — never a fabricated or bare-zero number (ruling 4). */
  available: boolean
  windowMs?: number
  costUsdPerHour?: number
  /** `costUsdPerHour * arms` — one arm assumed to run about as long as the window the rate itself was measured over. */
  estimatedTotalUsd?: number
  /** Set only when `available` is false — why no number is shown. */
  reason?: string
}

/**
 * `costUsdPerHour` derived from the forked lane's OWN recent spend (never a
 * fleet-wide or borrowed rate), over the trailing hour. Zero real activity in
 * that window means the rate cannot be established — reported as
 * `available: false` with a `reason`, never as a `$0.00` that reads as a real
 * answer (ruling 4's own words: "a guess wearing a suit").
 */
export async function estimateLaunchSpend(ctx: ServerContext, lane: string, arms: number): Promise<LabEstimateResult> {
  const events = await readAllEvents(ctx)
  const state = reduceAll(events)
  const now = ctx.now?.() ?? Date.now()
  const rate = selectSpendRateByLane(state, { now, windowMs: ESTIMATE_WINDOW_MS })[lane]

  // `costIsAuthoritative` is `null` exactly when no dollars were counted at
  // all (`selectors/spend.ts`'s own vocabulary) — the one case ruling 4 says
  // must read as "the rate cannot be established", never as `$0.00`.
  if (rate === undefined || rate.totals.costIsAuthoritative === null) {
    return {
      lane,
      arms,
      available: false,
      reason: `"${lane}" has no recorded spend in the last hour — its rate cannot be established`,
    }
  }

  return {
    lane,
    arms,
    available: true,
    windowMs: rate.windowMs,
    costUsdPerHour: rate.costUsdPerHour,
    estimatedTotalUsd: rate.costUsdPerHour * arms,
  }
}

// --- launch (prd14 ruling 2/4: free-form arms, one confirmation, real spend) ----

export class LaunchValidationError extends Error {}

export interface LaunchArmInput {
  model?: string
  brief?: string
}

export interface LaunchRequestBody {
  lane: string
  checkpointId: string
  arms: LaunchArmInput[]
}

export interface LaunchedArmResult {
  arm: number
  model: string | null
  briefProvided: boolean
  forkId: string
  laneHandle: string
  worktreePath: string
  launched: boolean
}

export interface LaunchResult {
  parentLane: string
  checkpointId: string
  arms: LaunchedArmResult[]
  /** Set when an arm failed — dispatch stops there; arms already dispatched already spent real money and are kept, never discarded. */
  failed: { arm: number; error: string } | null
}

function parseLaunchRequestBody(body: unknown): LaunchRequestBody {
  if (typeof body !== 'object' || body === null) {
    throw new LaunchValidationError('request body must be a JSON object')
  }
  const { lane, checkpointId, arms } = body as Record<string, unknown>

  if (typeof lane !== 'string' || lane.trim().length === 0) {
    throw new LaunchValidationError('"lane" must be a non-empty string')
  }
  if (typeof checkpointId !== 'string' || checkpointId.trim().length === 0) {
    throw new LaunchValidationError(
      '"checkpointId" must be a non-empty string — the lab never launches from an interpolated moment (prd12 ruling 2)',
    )
  }
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new LaunchValidationError('"arms" must be a non-empty array — an experiment needs at least one arm')
  }

  const parsedArms: LaunchArmInput[] = arms.map((arm, index) => {
    if (typeof arm !== 'object' || arm === null) {
      throw new LaunchValidationError(`arm ${index + 1} must be an object`)
    }
    const { model, brief } = arm as Record<string, unknown>
    if (model !== undefined && typeof model !== 'string') {
      throw new LaunchValidationError(`arm ${index + 1}'s "model" must be a string when present`)
    }
    if (brief !== undefined && typeof brief !== 'string') {
      throw new LaunchValidationError(`arm ${index + 1}'s "brief" must be a string when present`)
    }
    return { model, brief }
  })

  return { lane, checkpointId, arms: parsedArms }
}

/**
 * Every concurrent request that reaches the laboratory serialises through
 * here — one `runCli(['lab', ...])` in flight at a time, process-wide. Two
 * reasons: `runLabCliOnce` below temporarily replaces `process.stderr.write`
 * to capture the CLI's own error text, which is only safe with nothing else
 * mid-flight; and `dispatchFork` itself runs real `git worktree add` against
 * the SAME parent repo per arm, which is safer serialised than raced.
 */
let labCliQueue: Promise<unknown> = Promise.resolve()

function withLabCliLock<T>(fn: () => Promise<T>): Promise<T> {
  const runAfterPrevious = labCliQueue.then(fn, fn)
  labCliQueue = runAfterPrevious.then(
    () => undefined,
    () => undefined,
  )
  return runAfterPrevious
}

/** Thrown by the injected `exit` below to unwind `runCli` without touching the real process. */
class LabCliExit {
  constructor(readonly code: number) {}
}

interface LabCliInvocation {
  exitCode: number
  stdout: string
  stderr: string
}

export interface LabCliRunOptions {
  exec?: Exec
  dataRoot?: string
  claudeProjectsRoot?: string
  now?: () => number
}

/**
 * Runs one `rhizomorph lab <argv>` in-process via `runCli` — the same
 * explicit-invocation surface a human typing the command gets, never a
 * direct import of `server/src/lab/*` (see the file doc, and
 * `explicit-invocation-law` below). `process.stderr.write` is captured
 * rather than passed through: every lab subcommand's error path writes
 * there directly rather than through the injected `log`, and the launch
 * route needs that text to explain a failed arm honestly instead of just
 * reporting a bare non-zero exit.
 */
async function runLabCliOnce(argv: readonly string[], options: LabCliRunOptions): Promise<LabCliInvocation> {
  const stdoutLines: string[] = []
  const log = {
    log: (message?: unknown) => stdoutLines.push(message === undefined ? '' : String(message)),
    warn: (message?: unknown) => stdoutLines.push(message === undefined ? '' : String(message)),
  }

  const stderrChunks: string[] = []
  const originalStderrWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write

  let exitCode = 0
  const exit = (code: number): never => {
    exitCode = code
    throw new LabCliExit(code)
  }

  try {
    const { runCli } = await import('../cli/index.js')
    await runCli(['lab', ...argv], {
      ...(options.exec === undefined ? {} : { exec: options.exec }),
      ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
      ...(options.claudeProjectsRoot === undefined ? {} : { claudeProjectsRoot: options.claudeProjectsRoot }),
      ...(options.now === undefined ? {} : { now: options.now }),
      log,
      exit,
    })
  } catch (err) {
    if (!(err instanceof LabCliExit)) throw err
  } finally {
    process.stderr.write = originalStderrWrite
  }

  return { exitCode, stdout: stdoutLines.join('\n'), stderr: stderrChunks.join('') }
}

interface ParsedSingleArmDispatch {
  forkId: string
  checkpointId: string
  laneHandle: string
  worktreePath: string
  launched: boolean
}

const FORK_HEADER_RE = /^fork (\S+) — \d+ arm\(s\) of lane "(?:[^"]*)" restored from checkpoint (\S+)$/m
const ARM_LINE_RE = /^ {2}arm 1 {2}(\S+)$/m
const WORKTREE_LINE_RE = /^ {4}worktree {2}(\S+)$/m
const LAUNCH_LINE_RE = /^ {4}launch {4}(ran|not run)/m

/**
 * `rhizomorph lab fork`'s stdout is prose, not JSON — this reads back exactly
 * the shape `runLabForkCommand` (`cli/index.ts`) is documented to print for a
 * single-arm dispatch. `lab.test.ts` exercises this against the REAL CLI
 * output (not a hand-written fixture), so a future wording change in
 * `cli/index.ts` fails here rather than silently mis-parsing.
 */
export function parseSingleArmForkStdout(stdout: string): ParsedSingleArmDispatch | null {
  const header = FORK_HEADER_RE.exec(stdout)
  const armLine = ARM_LINE_RE.exec(stdout)
  const worktreeLine = WORKTREE_LINE_RE.exec(stdout)
  const launchLine = LAUNCH_LINE_RE.exec(stdout)
  if (!header || !armLine || !worktreeLine || !launchLine) return null

  const [, forkId, checkpointId] = header
  const [, laneHandle] = armLine
  const [, worktreePath] = worktreeLine
  if (forkId === undefined || checkpointId === undefined || laneHandle === undefined || worktreePath === undefined) {
    return null
  }

  return { forkId, checkpointId, laneHandle, worktreePath, launched: launchLine[1] === 'ran' }
}

export interface LaunchExperimentOptions {
  repoPath: string
  exec?: Exec
  dataRoot?: string
  claudeProjectsRoot?: string
  now?: () => number
}

/**
 * Dispatches one arm per entry in `request.arms`, each with its OWN model
 * and brief (prd14 ruling 2 — free-form, never constrained to a single
 * knob). `dispatchFork` (the engine, read-only to this issue) only ever
 * applies ONE treatment across however many arms one call makes, so the only
 * way to give arm 2 a different model or brief than arm 1 without touching
 * that engine is one `--arms 1` dispatch per arm — which is exactly what
 * this does, sequentially, through the lock above.
 *
 * Arms are independent forks (their own `forkId`, always arm 1 within it):
 * this is an honest reflection of what `dispatchFork` can express today, not
 * a synthesized "one experiment" the engine never actually recorded. Ruling
 * 3's grouped, multi-arm comparison view is wave 4's surface over whatever
 * the engine holds; this route's job stops at getting each arm dispatched
 * and reporting, per arm, exactly what happened.
 *
 * Stops at the first failure rather than trying the rest: an arm that failed
 * to restore might mean the checkpoint itself is bad, and dispatching
 * further arms against it would spend more money chasing the same failure.
 * Arms already dispatched keep their result — they already spent real
 * money and that is never hidden (prd12 ruling 3).
 */
export async function launchExperiment(body: unknown, options: LaunchExperimentOptions): Promise<LaunchResult> {
  const request = parseLaunchRequestBody(body)
  const arms: LaunchedArmResult[] = []
  let failed: LaunchResult['failed'] = null

  for (let index = 0; index < request.arms.length; index += 1) {
    const armNumber = index + 1
    const input = request.arms[index] ?? {}
    const model = input.model?.trim()
    const brief = input.brief?.trim()
    const hasModel = model !== undefined && model.length > 0
    const hasBrief = brief !== undefined && brief.length > 0

    let briefFile: string | null = null
    try {
      if (hasBrief) {
        briefFile = path.join(tmpdir(), `rhizomorph-lab-brief-${process.pid}-${randomUUID()}.md`)
        await writeFile(briefFile, brief, 'utf8')
      }

      const argv = ['fork', request.lane, '--path', options.repoPath, '--at', request.checkpointId, '--arms', '1', '--launch']
      if (hasModel) argv.push('--model', model)
      if (briefFile !== null) argv.push('--prompt-file', briefFile)

      const invocation = await withLabCliLock(() =>
        runLabCliOnce(argv, {
          ...(options.exec === undefined ? {} : { exec: options.exec }),
          ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
          ...(options.claudeProjectsRoot === undefined ? {} : { claudeProjectsRoot: options.claudeProjectsRoot }),
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
      )

      if (invocation.exitCode !== 0) {
        failed = { arm: armNumber, error: invocation.stderr.trim() || `rhizomorph lab fork exited ${invocation.exitCode}` }
        break
      }

      const parsed = parseSingleArmForkStdout(invocation.stdout)
      if (parsed === null) {
        failed = { arm: armNumber, error: `could not read the dispatch result for arm ${armNumber} — unexpected CLI output` }
        break
      }

      arms.push({
        arm: armNumber,
        model: hasModel ? model : null,
        briefProvided: hasBrief,
        forkId: parsed.forkId,
        laneHandle: parsed.laneHandle,
        worktreePath: parsed.worktreePath,
        launched: parsed.launched,
      })
    } finally {
      if (briefFile !== null) await rm(briefFile, { force: true })
    }
  }

  return { parentLane: request.lane, checkpointId: request.checkpointId, arms, failed }
}

export function registerLabRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/lab/checkpoints', async () => {
    const events = await readAllEvents(ctx)
    return { checkpoints: checkpointDTOs(events) }
  })

  app.get('/api/lab/experiments', async () => {
    const events = await readAllEvents(ctx)
    return { experiments: experimentDTOs(events) }
  })

  app.get('/api/lab/estimate', async (request: FastifyRequest, reply) => {
    const query = request.query as Record<string, unknown>
    const lane = typeof query.lane === 'string' ? query.lane.trim() : ''
    const armsRaw = typeof query.arms === 'string' ? Number(query.arms) : NaN

    if (lane.length === 0 || !Number.isInteger(armsRaw) || armsRaw < 1) {
      return reply
        .code(400)
        .send({ error: '"lane" (non-empty string) and "arms" (positive integer) query params are required' })
    }

    return estimateLaunchSpend(ctx, lane, armsRaw)
  })

  app.post('/api/lab/launch', async (request: FastifyRequest, reply) => {
    if (ctx.readOnly === true) {
      return reply.code(409).send({
        error: 'this server is replaying a session record, not watching a repo — there is nothing live to fork',
      })
    }

    try {
      return await launchExperiment(request.body, { repoPath: ctx.repoPath, ...(ctx.now === undefined ? {} : { now: ctx.now }) })
    } catch (err) {
      if (err instanceof LaunchValidationError) {
        return reply.code(400).send({ error: err.message })
      }
      throw err
    }
  })
}
