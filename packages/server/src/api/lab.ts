import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, RhizomorphEvent } from '@rhizomorph/core'
import { buildFleet, reduceAll } from '@rhizomorph/core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { listSessions, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import type { ServerContext } from '../server/context.js'
import { requireCapabilityToken } from './security.js'

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
  /** 1-based run within its arm (prd53 ruling 1); 1 for every record written before an arm could hold more than one. */
  run: number
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
        run: dispatch.run,
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
 * `costUsdPerHour` read straight off the forked lane's own `Lane` row in
 * `buildFleet`'s output (never a fleet-wide or borrowed rate) — the same
 * derivation `Burn.costUsdPerHour` already sums across every lane, over the
 * trailing hour. Reading it from the one fleet object rather than re-folding
 * the log a second time with its own spend-rate selector call is issue #246:
 * two callers asking buildFleet's own question independently is exactly how
 * a lane's judged spend ends up disagreeing between two surfaces. Zero
 * real activity in that window means the rate cannot be established —
 * reported as `available: false` with a `reason`, never as a `$0.00` that
 * reads as a real answer (ruling 4's own words: "a guess wearing a suit").
 */
export async function estimateLaunchSpend(ctx: ServerContext, lane: string, arms: number): Promise<LabEstimateResult> {
  const events = await readAllEvents(ctx)
  const state = reduceAll(events)
  const now = ctx.now?.() ?? Date.now()
  const fleet = buildFleet(state, { now, windowMs: ESTIMATE_WINDOW_MS })
  const laneRow = fleet.lanes.find(
    (row) => row.handles.includes(lane) || row.id === lane || row.branch === lane,
  )

  // `costRateIsAuthoritative` is `null` exactly when no dollars were counted
  // at all for this lane inside the window (`Lane`'s own vocabulary) — the
  // one case ruling 4 says must read as "the rate cannot be established",
  // never as `$0.00`.
  if (laneRow === undefined || laneRow.costRateIsAuthoritative === null) {
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
    windowMs: ESTIMATE_WINDOW_MS,
    costUsdPerHour: laneRow.costUsdPerHour,
    estimatedTotalUsd: laneRow.costUsdPerHour * arms,
  }
}

// --- launch (prd14 ruling 2/4: free-form arms, one confirmation, real spend) ----

export class LaunchValidationError extends Error {}

/**
 * THE MODEL GRAMMAR (#234's second defect).
 *
 * An arm's `model` was validated as `typeof === 'string'` and nothing more.
 * It travels `--model <model>` through `runCli(['lab','fork',…])` into
 * `lab/fork.ts`'s `workmuxAddArgv`, which composes
 * `` `bash scripts/lane-agent.sh ${model}` `` — a *string* that workmux then
 * hands to a shell in a tmux pane. Every hop inside rhizomorph uses argv
 * arrays correctly; the injection lands one hop downstream, in workmux's own
 * execution of that string, which is why auditing this repo's spawn sites
 * alone clears the code.
 *
 * So the value is refused HERE, at the request boundary, long before argv is
 * built — and again in `lab/fork.ts` for the `rhizomorph lab fork --model`
 * path, which never passes through this file at all. The two copies are
 * deliberate and each is literal-pinned in its own test, the same mitigation
 * ADR-0012 records for the capability header's duplicated spelling: the
 * laboratory's namespace law (`lab/namespace-law.test.ts`) forbids this file
 * from importing anything under `server/src/lab/`, so there is no module both
 * sides may share today.
 *
 * The grammar is every character the real model strings this repo dispatches
 * actually use — `sonnet`, `opus`, `haiku`, `claude-opus-5`,
 * `claude-3-5-sonnet-20241022`, and a bedrock-style
 * `us.anthropic.claude-3-5-sonnet-20241022-v1:0` — and no character a shell
 * gives meaning to. Notably absent: the space, which is what makes a
 * `model` that smuggles a second word impossible rather than merely
 * suspicious.
 */
export const MODEL_GRAMMAR = /^[A-Za-z0-9._:-]+$/

/**
 * The first character of `model` the grammar refuses, rendered so a control
 * character is legible in the refusal rather than vanishing into it — a
 * refusal that says "invalid model" and nothing else sends the operator
 * hunting through a value they cannot see.
 */
export function offendingModelCharacter(model: string): string | null {
  for (const character of model) {
    if (MODEL_GRAMMAR.test(character)) continue
    const code = character.codePointAt(0) ?? 0
    if (character === '\n') return '\\n'
    if (character === '\r') return '\\r'
    if (character === '\t') return '\\t'
    if (code < 0x20 || code === 0x7f) return `\\u${code.toString(16).padStart(4, '0')}`
    return character
  }
  return null
}

/** The sentence both refusal sites say, so the operator reads the same explanation whichever hand they used. */
export function modelRefusalMessage(model: string, offender: string): string {
  return (
    `"model" contains ${offender === ' ' ? 'a space' : `"${offender}"`}, which this instrument refuses: ` +
    `a model reaches the launcher inside a command line a shell interprets, so it may only use ` +
    `letters, digits, and . _ : - (received "${model}")`
  )
}

export interface LaunchArmInput {
  model?: string
  brief?: string
}

export interface LaunchRequestBody {
  lane: string
  checkpointId: string
  arms: LaunchArmInput[]
  /** Runs of every arm (prd53 ruling 1). 1 when the request did not say. */
  runs: number
}

/** One run of a launched arm — its own worktree, its own handle, its own launch. */
export interface LaunchedRunResult {
  run: number
  laneHandle: string
  worktreePath: string
  launched: boolean
}

export interface LaunchedArmResult {
  arm: number
  model: string | null
  briefProvided: boolean
  /** The experiment's id — the same on every arm of one launch (prd53 ruling 1). */
  forkId: string
  /** The first run's handle, worktree and launch state — kept so a reader of one run per arm still reads truthfully; `runs` holds all of them. */
  laneHandle: string
  worktreePath: string
  launched: boolean
  runs: LaunchedRunResult[]
}

export interface LaunchResult {
  /** ONE per launch, minted before the first arm is dispatched (prd53 ruling 1). */
  forkId: string
  parentLane: string
  checkpointId: string
  arms: LaunchedArmResult[]
  /** Set when an arm failed — dispatch stops there; arms already dispatched already spent real money and are kept, never discarded. */
  failed: { arm: number; error: string } | null
}

/**
 * Refuses a value whose FIRST character is `-`, for every field that reaches
 * the CLI as argv.
 *
 * `lane` travels as an argv positional, and `parseFlags` (`cli/args.ts`) reads
 * any `-`-prefixed positional as a flag. The argv puts these after `--`, so
 * `parseFlags` itself can never misread them — but `parseLabForkArgs` scans
 * raw argv for `--help`/`-h` BEFORE `parseFlags` runs, and `--` does not cover
 * that pre-scan. A value spelled `--help` prints the fork command's help,
 * exits 0, and surfaces as "could not read the dispatch result" rather than as
 * anything an operator can act on.
 *
 * Applied to `lane`, `checkpointId` and each arm's `model` — every value that
 * reaches argv. `lane` had this guard alone; the other two reach the same
 * pre-scan by the same route, and `MODEL_GRAMMAR` does not close it
 * (`/^[A-Za-z0-9._:-]+$/` accepts `-h` and `--help`, since `-` is a legal
 * character *within* a model name).
 *
 * Deliberately narrow: it constrains the first character only, which is the
 * whole of what the pre-scan can misread. A lane may legitimately contain
 * `/`, `.` and `_`; a model legitimately contains `-`.
 */
function refuseFlagShaped(value: string, label: string, why: string): void {
  const trimmed = value.trim()
  if (trimmed.startsWith('-')) {
    throw new LaunchValidationError(
      `${label} may not begin with "-" (received "${trimmed}") — ${why}, and a leading dash is how a command line spells a flag`,
    )
  }
}

/**
 * The most arms one launch request may dispatch — each arm forks a real
 * worktree and, with `--launch`, a real spending agent lane (prd41 ruling 4:
 * "a ceiling that spends money is declared"). The number itself is a
 * design-note decision, not this file's own reasoning: see
 * docs/design-notes/lab-launch-ceilings.md.
 */
export const MAX_ARMS = 8

function parseLaunchRequestBody(body: unknown): LaunchRequestBody {
  if (typeof body !== 'object' || body === null) {
    throw new LaunchValidationError('request body must be a JSON object')
  }
  const { lane, checkpointId, arms, runs: runsRaw } = body as Record<string, unknown>

  if (typeof lane !== 'string' || lane.trim().length === 0) {
    throw new LaunchValidationError('"lane" must be a non-empty string')
  }
  // `lane` travels as an argv POSITIONAL (`launchExperiment` below), and
  // `parseFlags` (`cli/args.ts`) reads any `-`-prefixed positional as a flag.
  // The argv there puts it after `--` so this can never be misparsed, but
  // `parseLabForkArgs` scans raw argv for `--help`/`-h` BEFORE `parseFlags`
  // runs, so `--` does not cover those two: a lane spelled `--help` would
  // print the fork command's help, exit 0, and surface as "unexpected CLI
  // output" rather than as anything an operator could act on. Refused here
  // instead, in the operator's own vocabulary. Deliberately narrow — a lane
  // name may legitimately contain `/`, `.` and `_`, so this constrains the
  // first character only, which is the whole of what argv parsing can
  // misread. Since #246 the estimate resolves this name against fleet rows
  // by handle, id, or branch (review of #499: the `.find` ORs all three
  // predicates per row in `byAttentionThenSize` order, so an ambiguous name
  // — one lane's branch spelling another lane's handle — is answered by
  // attention rank; acceptable while names are unique per worktree, worth a
  // tiebreak if that ever stops holding).
  refuseFlagShaped(lane, '"lane"', 'a lane names a worktree — its handle, id, or branch')
  if (typeof checkpointId !== 'string' || checkpointId.trim().length === 0) {
    throw new LaunchValidationError(
      '"checkpointId" must be a non-empty string — the lab never launches from an interpolated moment (prd12 ruling 2)',
    )
  }
  refuseFlagShaped(checkpointId, '"checkpointId"', 'a checkpoint id names a captured moment')
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new LaunchValidationError('"arms" must be a non-empty array — an experiment needs at least one arm')
  }
  // prd41 ruling 4: a ceiling that spends money is declared. See MAX_ARMS below —
  // this is the same validation block ruling 4 says the ceiling belongs beside.
  if (arms.length > MAX_ARMS) {
    throw new LaunchValidationError(
      `"arms" may not exceed ${MAX_ARMS} — received ${arms.length}, and each arm forks a live, spending agent lane`,
    )
  }
  const runs = runsRaw === undefined ? 1 : runsRaw
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1) {
    throw new LaunchValidationError('"runs" must be a positive integer when present — how many times each arm is run (prd53 ruling 1)')
  }
  // The same ceiling, read for what it actually bounds: every RUN is a live,
  // spending agent lane, so arms × runs is the count prd41 ruling 4 declared a
  // ceiling over — not the arm count alone. prd53 ruling 6 (wave 2) makes this
  // configurable and names the override; until then the fixed number holds.
  if (arms.length * runs > MAX_ARMS) {
    throw new LaunchValidationError(
      `"arms" × "runs" may not exceed ${MAX_ARMS} spending lanes — received ${arms.length} arm(s) × ${runs} run(s) = ${arms.length * runs}, and every run forks a live, spending agent lane`,
    )
  }

  const parsedArms: LaunchArmInput[] = arms.map((arm, index) => {
    if (typeof arm !== 'object' || arm === null) {
      throw new LaunchValidationError(`arm ${index + 1} must be an object`)
    }
    const { model, brief } = arm as Record<string, unknown>
    if (model !== undefined && typeof model !== 'string') {
      throw new LaunchValidationError(`arm ${index + 1}'s "model" must be a string when present`)
    }
    // The grammar is checked on the TRIMMED value, because that is the value
    // that actually travels: `launchExperiment` below trims before deciding
    // whether an arm names a model at all, and an all-whitespace `model` is
    // "no model", not a violation.
    if (typeof model === 'string') {
      const trimmed = model.trim()
      const offender = trimmed.length === 0 ? null : offendingModelCharacter(trimmed)
      if (offender !== null) {
        throw new LaunchValidationError(`arm ${index + 1}'s ${modelRefusalMessage(trimmed, offender)}`)
      }
      // MODEL_GRAMMAR admits `-` because model names contain it
      // (`claude-opus-5`), so it accepts `-h` and `--help` too. Those reach
      // `parseLabForkArgs`'s raw `--help` pre-scan ahead of the `--`
      // separator, exactly as a flag-shaped lane would.
      if (trimmed.length > 0) {
        refuseFlagShaped(trimmed, `arm ${index + 1}'s "model"`, 'a model is a name, not a flag')
      }
    }
    if (brief !== undefined && typeof brief !== 'string') {
      throw new LaunchValidationError(`arm ${index + 1}'s "brief" must be a string when present`)
    }
    return { model, brief }
  })

  return { lane, checkpointId, arms: parsedArms, runs }
}

/**
 * How long a launch will wait for another launch's `runCli` call to clear
 * before refusing rather than joining the queue behind it (prd41 ruling 2:
 * "refuse, never queue... a queued launch is money the operator did not
 * watch being spent"). This bounds how long a NEW caller sits behind
 * whatever is already running — it does not bound the in-flight call itself,
 * which keeps the lock until it settles on its own; that is a separate,
 * exec-level concern the other wave-2 issue gives the four lab modules. See
 * docs/design-notes/lab-launch-ceilings.md for the number.
 */
export const LAB_CLI_LOCK_CEILING_MS = 30_000

/** Thrown when a launch gives up waiting for the lab CLI lock. The route maps this to 503. */
export class LabCliLockCeilingError extends Error {}

/**
 * Every concurrent request that reaches the laboratory serialises through
 * here — one `runCli(['lab', ...])` in flight at a time, process-wide. Two
 * reasons: `runLabCliOnce` below installs and later restores the single
 * process-wide `process.stderr.write` function pointer around each call —
 * `stderrCaptureScope` (see below) scopes what gets CAPTURED to this call's
 * own writes, but two overlapping installs would still step on each other's
 * restore; and `dispatchFork` itself runs real `git worktree add` against the
 * SAME parent repo per arm, which is safer serialised than raced.
 */
let labCliQueue: Promise<unknown> = Promise.resolve()
/** What `labCliQueue`'s current holder is doing — the diagnostic a ceiling refusal names. */
let labCliQueueLabel: string | null = null

/**
 * A caller that must WAIT for the current holder races that wait against
 * `ceilingMs`. If the holder has not cleared by then, this rejects with
 * `LabCliLockCeilingError` naming what it waited on, and — the part that
 * makes this a refusal rather than a slow queue — `fn` is never called for
 * this caller: giving up must mean nothing is dispatched and no money is
 * spent, not "dispatched late with nobody watching."
 */
function withLabCliLock<T>(label: string, fn: () => Promise<T>, ceilingMs: number = LAB_CLI_LOCK_CEILING_MS): Promise<T> {
  const waitedOn = labCliQueueLabel
  const previous = labCliQueue
  let gaveUp = false
  let ceilingTimer: ReturnType<typeof setTimeout>

  const ceilingReached = new Promise<never>((_resolve, reject) => {
    ceilingTimer = setTimeout(() => {
      gaveUp = true
      reject(
        new LabCliLockCeilingError(
          waitedOn === null
            ? `the laboratory did not clear within ${ceilingMs}ms — refused rather than queued`
            : `the laboratory is still running ${waitedOn} — waited ${ceilingMs}ms and refused rather than queued`,
        ),
      )
    }, ceilingMs)
  })

  const settleThenRun = async (): Promise<T> => {
    if (gaveUp) {
      throw new LabCliLockCeilingError('gave up waiting for the lab CLI lock before this turn arrived')
    }
    clearTimeout(ceilingTimer)
    labCliQueueLabel = label
    try {
      return await fn()
    } finally {
      labCliQueueLabel = null
    }
  }

  const attempt = previous.then(settleThenRun, settleThenRun)
  labCliQueue = attempt.then(
    () => undefined,
    () => undefined,
  )

  return Promise.race([attempt, ceilingReached])
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
 * Bounds stderr capture to exactly the async continuation of one
 * `runLabCliOnce` call, not the process as a whole. A bare
 * `process.stderr.write = capture` used to swallow ANY write that happened to
 * land during the call's (potentially multi-second — real `git`/`workmux`
 * work) await window, `console.error` from a totally unrelated request or
 * background loop included — that write never reached the operator's real
 * stderr and never should have been eligible for `failed.error` either. A
 * write made inside `stderrCaptureScope.run(...)` (this call's own `runCli`
 * invocation, and only that) is captured; a write from any other async
 * context — one this call never entered — falls straight through to the
 * real stream, exactly as if nothing here were patched at all.
 */
const stderrCaptureScope = new AsyncLocalStorage<string[]>()

/**
 * Runs one `rhizomorph lab <argv>` in-process via `runCli` — the same
 * explicit-invocation surface a human typing the command gets, never a
 * direct import of `server/src/lab/*` (see the file doc, and
 * `explicit-invocation-law` below). `process.stderr.write` is captured
 * rather than passed through: every lab subcommand's error path writes
 * there directly rather than through the injected `log`, and the launch
 * route needs that text to explain a failed arm honestly instead of just
 * reporting a bare non-zero exit. The capture itself is scoped by
 * `stderrCaptureScope` (see above) to this call's own `runCli` invocation, so
 * only THIS call's own writes are diverted — everything else still reaches
 * real stderr immediately, #239's loud degrade reporting included.
 */
async function runLabCliOnce(argv: readonly string[], options: LabCliRunOptions): Promise<LabCliInvocation> {
  const stdoutLines: string[] = []
  const log = {
    log: (message?: unknown) => stdoutLines.push(message === undefined ? '' : String(message)),
    warn: (message?: unknown) => stdoutLines.push(message === undefined ? '' : String(message)),
  }

  const stderrChunks: string[] = []
  const originalStderrWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const scoped = stderrCaptureScope.getStore()
    if (scoped === undefined) {
      return (originalStderrWrite as unknown as (...args: unknown[]) => boolean)(chunk, ...rest)
    }
    scoped.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write

  let exitCode = 0
  const exit = (code: number): never => {
    exitCode = code
    throw new LabCliExit(code)
  }

  try {
    const { runCli } = await import('../cli/index.js')
    await stderrCaptureScope.run(stderrChunks, () =>
      runCli(['lab', ...argv], {
        ...(options.exec === undefined ? {} : { exec: options.exec }),
        ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
        ...(options.claudeProjectsRoot === undefined ? {} : { claudeProjectsRoot: options.claudeProjectsRoot }),
        ...(options.now === undefined ? {} : { now: options.now }),
        log,
        exit,
      }),
    )
  } catch (err) {
    if (!(err instanceof LabCliExit)) throw err
  } finally {
    process.stderr.write = originalStderrWrite
  }

  return { exitCode, stdout: stdoutLines.join('\n'), stderr: stderrChunks.join('') }
}

export interface ParsedForkRun {
  arm: number
  run: number
  laneHandle: string
  worktreePath: string
  launched: boolean
}

export interface ParsedForkDispatch {
  forkId: string
  checkpointId: string
  /** Every run the CLI printed, in the order it printed them. Never empty — no run, no parse. */
  runs: [ParsedForkRun, ...ParsedForkRun[]]
}

const FORK_HEADER_RE =
  /^fork (\S+) — \d+ arm\(s\)(?: × \d+ run\(s\))? of lane "(?:[^"]*)" restored from checkpoint (\S+)$/m
/**
 * One run's block: its `arm N[ run R]  handle` line, its worktree line, then
 * whatever session lines the CLI printed (one, or two when a launcher moved
 * the arm), then its launch line. `run R` is absent for a first run — the
 * elision `lab/paths.ts` documents — and read as 1.
 */
const RUN_BLOCK_RE = /^ {2}arm (\d+)(?: run (\d+))? {2}(\S+)\n {4}worktree {2}(\S+)\n(?:.*\n)*? {4}launch {4}(ran|not run)/gm

/**
 * `rhizomorph lab fork`'s stdout is prose, not JSON — this reads back exactly
 * the shape `runLabForkCommand` (`cli/index.ts`) is documented to print.
 * `lab.test.ts` exercises this against the REAL CLI output (not only a
 * hand-written fixture), so a future wording change in `cli/index.ts` fails
 * here rather than silently mis-parsing.
 */
export function parseForkStdout(stdout: string): ParsedForkDispatch | null {
  const header = FORK_HEADER_RE.exec(stdout)
  if (!header) return null
  const [, forkId, checkpointId] = header
  if (forkId === undefined || checkpointId === undefined) return null

  const runs: ParsedForkRun[] = []
  for (const block of stdout.matchAll(RUN_BLOCK_RE)) {
    const [, arm, run, laneHandle, worktreePath, launch] = block
    if (arm === undefined || laneHandle === undefined || worktreePath === undefined || launch === undefined) return null
    runs.push({ arm: Number(arm), run: run === undefined ? 1 : Number(run), laneHandle, worktreePath, launched: launch === 'ran' })
  }

  const [head, ...tail] = runs
  if (head === undefined) return null
  return { forkId, checkpointId, runs: [head, ...tail] }
}

export interface LaunchExperimentOptions {
  repoPath: string
  exec?: Exec
  dataRoot?: string
  claudeProjectsRoot?: string
  now?: () => number
  /** Overrides `LAB_CLI_LOCK_CEILING_MS` — a test seam; production takes the default. */
  lockCeilingMs?: number
}

/**
 * Dispatches ONE experiment: an arm per entry in `request.arms`, each with its
 * OWN model and brief (prd14 ruling 2 — free-form, never constrained to a
 * single knob), each holding `request.runs` runs (prd53 ruling 1).
 *
 * `dispatchFork` applies one treatment across however many arms one call
 * makes, so giving arm 2 a different model or brief than arm 1 still takes
 * one `--arms 1` call per arm — sequentially, through the lock above. What
 * prd53 ruling 1 changed is what those calls SHARE: this function mints one
 * `forkId` before the first call and passes it, with the arm's own number, on
 * every call (`--fork-id`, `--arm-number`). The engine then records n arms of
 * one fork, because that is what happened — not n forks of one arm each,
 * which is what it recorded before and what left the comparison surface
 * honestly, permanently empty (no arm could ever hold the runs a summary
 * needs).
 *
 * Stops at the first failure rather than trying the rest: an arm that failed
 * to restore might mean the checkpoint itself is bad, and dispatching
 * further arms against it would spend more money chasing the same failure.
 * Arms already dispatched keep their result — they already spent real
 * money and that is never hidden (prd12 ruling 3). An experiment stopped
 * midway is a PARTIAL experiment: the arms before the failure are real, and
 * recorded under the same `forkId` as the ones that never came. prd53 ruling
 * 7 names that state; this function reports it as `failed` beside `arms`.
 */
export async function launchExperiment(body: unknown, options: LaunchExperimentOptions): Promise<LaunchResult> {
  const request = parseLaunchRequestBody(body)
  // One experiment, one id — minted here, before any arm exists, and handed
  // to every dispatch. The engine's own default (`fork-${randomUUID()}`) is
  // what it would mint per call, which is exactly the fragmentation this ends.
  const forkId = `fork-${randomUUID()}`
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

      // Every flag first, then `--`, then the ONE positional. `parseFlags`
      // (`cli/args.ts`) stops interpreting `-`-prefixed tokens after `--`,
      // exactly as any POSIX tool does, so a caller-supplied lane can never
      // be read as a flag no matter what it spells — the same argument-
      // injection class the `model` grammar closes, closed structurally here
      // rather than by another allowlist. `parseLaunchRequestBody` also
      // refuses a leading `-` up front, for the `--help`/`-h` scan that runs
      // before `parseFlags` and that `--` therefore cannot cover.
      const argv = [
        'fork',
        '--path', options.repoPath,
        '--at', request.checkpointId,
        '--arms', '1',
        '--fork-id', forkId,
        '--arm-number', String(armNumber),
        '--runs', String(request.runs),
        '--launch',
      ]
      if (hasModel) argv.push('--model', model)
      if (briefFile !== null) argv.push('--prompt-file', briefFile)
      argv.push('--', request.lane)

      const invocation = await withLabCliLock(
        `arm ${armNumber} for lane "${request.lane}"`,
        () =>
          runLabCliOnce(argv, {
            ...(options.exec === undefined ? {} : { exec: options.exec }),
            ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
            ...(options.claudeProjectsRoot === undefined ? {} : { claudeProjectsRoot: options.claudeProjectsRoot }),
            ...(options.now === undefined ? {} : { now: options.now }),
          }),
        options.lockCeilingMs,
      )

      if (invocation.exitCode !== 0) {
        failed = { arm: armNumber, error: invocation.stderr.trim() || `rhizomorph lab fork exited ${invocation.exitCode}` }
        break
      }

      const parsed = parseForkStdout(invocation.stdout)
      if (parsed === null) {
        failed = { arm: armNumber, error: `could not read the dispatch result for arm ${armNumber} — unexpected CLI output` }
        break
      }
      // The CLI was told which fork to dispatch into. If it answered with
      // another, the arm is real and recorded somewhere this launch cannot
      // account for — said plainly rather than filed under the id it was
      // supposed to have.
      if (parsed.forkId !== forkId) {
        failed = {
          arm: armNumber,
          error: `arm ${armNumber} was recorded under fork ${parsed.forkId}, not this experiment's ${forkId} — the dispatch ignored --fork-id`,
        }
        break
      }

      const [first] = parsed.runs
      arms.push({
        arm: armNumber,
        model: hasModel ? model : null,
        briefProvided: hasBrief,
        forkId: parsed.forkId,
        laneHandle: first.laneHandle,
        worktreePath: first.worktreePath,
        launched: first.launched,
        runs: parsed.runs.map((run) => ({
          run: run.run,
          laneHandle: run.laneHandle,
          worktreePath: run.worktreePath,
          launched: run.launched,
        })),
      })
    } finally {
      if (briefFile !== null) await rm(briefFile, { force: true })
    }
  }

  return { forkId, parentLane: request.lane, checkpointId: request.checkpointId, arms, failed }
}

export function registerLabRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/lab/checkpoints', { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') }, async () => {
    const events = await readAllEvents(ctx)
    return { checkpoints: checkpointDTOs(events) }
  })

  app.get('/api/lab/experiments', { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') }, async () => {
    const events = await readAllEvents(ctx)
    return { experiments: experimentDTOs(events) }
  })

  app.get(
    '/api/lab/estimate',
    { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') },
    async (request: FastifyRequest, reply) => {
      const query = request.query as Record<string, unknown>
      const lane = typeof query.lane === 'string' ? query.lane.trim() : ''
      const armsRaw = typeof query.arms === 'string' ? Number(query.arms) : NaN

      if (lane.length === 0 || !Number.isInteger(armsRaw) || armsRaw < 1) {
        return reply
          .code(400)
          .send({ error: '"lane" (non-empty string) and "arms" (positive integer) query params are required' })
      }

      return estimateLaunchSpend(ctx, lane, armsRaw)
    },
  )

  // Token-gated since #234: this route forks a worktree and dispatches a live
  // agent that spends real money, and the app-wide guard deliberately lets a
  // request with no `Origin` through (`server/mutation-guard.ts`) — which is
  // every non-browser caller, `curl` included. The capability token
  // (`api/security.ts`, delivered in-band per ADR-0012) is the control that
  // closes that half; the launch panel was widened to send it in the same
  // commit, because gating a route whose caller cannot authenticate is how
  // #249 happened.
  app.post('/api/lab/launch', { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') }, async (request: FastifyRequest, reply) => {
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
      if (err instanceof LabCliLockCeilingError) {
        return reply.code(503).send({ error: err.message })
      }
      throw err
    }
  })
}
