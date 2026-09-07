import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, ForkDispatchRecord, ForkOutcomeRecord, RhizomorphEvent, SessionState } from '@rhizomorph/core'
import { buildFleet, createEvent, createIdFactory, reduceAll } from '@rhizomorph/core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { listSessions, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import type { ServerContext } from '../server/context.js'
import type { SessionRecorder } from '../server/recorder.js'
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
  /** Where in the lane's session the cut fell — the event index, the tie-break for two cuts at one byte (prd53 S1). */
  eventIndex: number
  /** The byte the session was cut at. Position on the lab's axis is this over `sessionByteLength` — never wall-clock. */
  sessionCutByte: number
  /**
   * The recorded session file's length NOW, or null when it cannot be read —
   * S1's *degraded* state (the file moved), which renders as a marker with its
   * reason, never as a checkpoint that is not there.
   */
  sessionByteLength: number | null
}

export interface LabTreatmentDTO {
  model: string | null
  promptDigest: string | null
}

export interface LabOutcomeProvenanceDTO {
  /** Who ran the gate. */
  source: 'measure-route' | 'compare-cli'
  /** The gate command, verbatim — a verdict means nothing without it. */
  verifyCommand: string
  /** When the gate ran — the `fork.measured` event's own ts (epoch ms). */
  measuredAt: number
}

/**
 * prd53 ruling 3 — ONE RUN's measured outcome, typed with its provenance.
 * Absent from a run nobody has measured; nothing stands in for it. The gate's
 * facts (`verified`, `verifiedDetail`, `commits`) come from the newest
 * `fork.measured` for the run; `costUsd` and `durationMs` are the fold's own
 * (booked `llm.cost` per lane, dispatch → newest event) so they cannot
 * disagree with what every other surface derives from the same state.
 */
export interface LabRunOutcomeDTO {
  verified: 'pass' | 'fail' | 'not-run'
  verifiedDetail: string | null
  costUsd: number | null
  durationMs: number | null
  commits: number | null
  provenance: LabOutcomeProvenanceDTO
}

export interface LabRunDTO {
  eventId: string
  dispatchedAt: number
  /** 1-based run within its arm (prd53 ruling 1); 1 for every record written before an arm could hold more than one. */
  run: number
  laneHandle: string
  worktreePath: string
  /** Present only once this run has been measured (prd53 ruling 3). */
  outcome?: LabRunOutcomeDTO
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

/** The session file's byte length today, or null when it cannot be read — a fact about now, not about the record. */
async function sessionByteLength(sessionFile: string): Promise<number | null> {
  try {
    return (await stat(sessionFile)).size
  } catch {
    return null
  }
}

/** `state.checkpoints.records`, oldest first — the same chronological order `GET /api/sessions` lists in. */
async function checkpointDTOs(events: readonly RhizomorphEvent[]): Promise<LabCheckpointDTO[]> {
  const state = reduceAll(events)
  return Promise.all(
    state.checkpoints.records.map(async (record) => ({
      eventId: record.eventId,
      lane: record.lane,
      checkpointId: record.checkpointId,
      capturedAt: record.ts,
      capturedBy: record.capturedBy,
      snapshotRef: record.snapshotRef,
      snapshotSha: record.snapshotSha,
      headSha: record.headSha,
      eventIndex: record.eventIndex,
      sessionCutByte: record.sessionCutByte,
      sessionByteLength: await sessionByteLength(record.sessionFile),
    })),
  )
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
      const measured = latestOutcomeFor(state, dispatch.laneHandle)
      const run: LabRunDTO = {
        eventId: dispatch.eventId,
        dispatchedAt: dispatch.ts,
        run: dispatch.run,
        laneHandle: dispatch.laneHandle,
        worktreePath: dispatch.worktreePath,
        ...(measured === undefined ? {} : { outcome: runOutcomeDTO(measured, state, events, dispatch) }),
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

/** The newest `fork.measured` for this run's lane, or undefined when nobody has measured it. `Object.hasOwn`, so a hostile handle cannot read the prototype. */
function latestOutcomeFor(state: SessionState, laneHandle: string): ForkOutcomeRecord | undefined {
  const index = state.forks.latestOutcomeByLane
  if (!Object.hasOwn(index, laneHandle)) return undefined
  const at = index[laneHandle]
  return at === undefined ? undefined : state.forks.measurements[at]
}

function runOutcomeDTO(
  measured: ForkOutcomeRecord,
  state: SessionState,
  events: readonly RhizomorphEvent[],
  dispatch: ForkDispatchRecord,
): LabRunOutcomeDTO {
  return {
    verified: measured.verified,
    verifiedDetail: measured.verifiedDetail,
    costUsd: laneCost(state, dispatch.laneHandle),
    durationMs: laneDuration(events, dispatch),
    commits: measured.commits,
    provenance: { source: measured.source, verifyCommand: measured.verifyCommand, measuredAt: measured.ts },
  }
}

// The two derivations below restate `lab/compare.ts`'s `laneCost`/`laneDuration`
// rather than import them: the namespace law (`lab/namespace-law.test.ts`)
// forbids this file from reaching `server/src/lab/` — the same split
// `MODEL_GRAMMAR` lives with, and the reason both are kept to a few lines.

/** Dollars booked to the run's lane, or null when nothing has been — never a `$0` that reads as a measurement. */
function laneCost(state: SessionState, laneHandle: string): number | null {
  const booked = state.telemetry.costs.filter((cost) => cost.lane === laneHandle)
  if (booked.length === 0) return null
  return booked.reduce((sum, cost) => sum + cost.costUsd, 0)
}

/** Dispatch → the newest event recorded for the run's lane. Null while nothing has come back yet. */
function laneDuration(events: readonly RhizomorphEvent[], dispatch: ForkDispatchRecord): number | null {
  let newest: number | null = null
  for (const event of events) {
    if (event.ts <= dispatch.ts) continue
    const payload = event.payload as Record<string, unknown>
    if (payload['lane'] !== dispatch.laneHandle && payload['handle'] !== dispatch.laneHandle) continue
    newest = newest === null ? event.ts : Math.max(newest, event.ts)
  }
  return newest === null ? null : newest - dispatch.ts
}

// --- estimate (prd14 ruling 4: an estimate never appears without its basis) ------

/** An hour: long enough that one lane's ordinary lull between requests doesn't read as "no rate". */
const ESTIMATE_WINDOW_MS = 60 * 60_000

export interface LabEstimateResult {
  lane: string
  arms: number
  /** Runs of each arm (prd53 ruling 1). 1 unless the caller said otherwise. */
  runs: number
  /** arms × runs — the spending lanes this launch would create, which is what the estimate scales by. */
  lanes: number
  /** False means "the rate cannot be established" — never a fabricated or bare-zero number (ruling 4). */
  available: boolean
  windowMs?: number
  costUsdPerHour?: number
  /** `costUsdPerHour * lanes` — one lane assumed to run about as long as the window the rate itself was measured over. */
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
export async function estimateLaunchSpend(ctx: ServerContext, lane: string, arms: number, runs = 1): Promise<LabEstimateResult> {
  const lanes = arms * runs
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
      runs,
      lanes,
      available: false,
      reason: `"${lane}" has no recorded spend in the last hour — its rate cannot be established`,
    }
  }

  return {
    lane,
    arms,
    runs,
    lanes,
    available: true,
    windowMs: ESTIMATE_WINDOW_MS,
    costUsdPerHour: laneRow.costUsdPerHour,
    // Every run is its own spending lane (prd53 ruling 1): an estimate that
    // scaled by arms alone would understate a three-run experiment threefold.
    estimatedTotalUsd: laneRow.costUsdPerHour * lanes,
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
  /** The operator's declared launch ceiling in spending lanes, when they mean to go past the default (prd53 ruling 6). */
  ceilingOverride?: number
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
 * THE LAUNCH CEILING, in spending lanes — arms × runs — that one launch may
 * create unless the operator declares otherwise (prd53 ruling 6; prd41 ruling
 * 4: "a ceiling that spends money is declared"). Every run forks a real
 * worktree and, with `--launch`, a real spending agent lane. Restated from
 * `lab/fork.ts`'s `LAUNCH_CEILING_LANES` rather than imported — the namespace
 * law forbids this file from reaching that one — and literal-pinned in both
 * tests. The number and the override's shape are a design-note decision:
 * docs/design-notes/lab-launch-ceiling-arms-runs.md.
 */
export const LAUNCH_CEILING_LANES = 8

function parseLaunchRequestBody(body: unknown): LaunchRequestBody {
  if (typeof body !== 'object' || body === null) {
    throw new LaunchValidationError('request body must be a JSON object')
  }
  const { lane, checkpointId, arms, runs: runsRaw, ceilingOverride } = body as Record<string, unknown>

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
  const runs = runsRaw === undefined ? 1 : runsRaw
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1) {
    throw new LaunchValidationError('"runs" must be a positive integer when present — how many times each arm is run (prd53 ruling 1)')
  }
  if (
    ceilingOverride !== undefined &&
    (typeof ceilingOverride !== 'number' || !Number.isInteger(ceilingOverride) || ceilingOverride < 1)
  ) {
    throw new LaunchValidationError(
      '"ceilingOverride" must be a positive integer of spending lanes when present — the ceiling you are declaring for this launch (prd53 ruling 6)',
    )
  }
  // prd41 ruling 4: a ceiling that spends money is declared — here, in the
  // same validation block, before anything is dispatched. Read for what it
  // bounds: every RUN is a live, spending agent lane, so arms × runs is the
  // count. The refusal names the number AND the override that would authorise
  // exactly this launch (prd53 ruling 6), so the operator's next move is in
  // the message; an override still too low is refused the same way.
  const ceiling = ceilingOverride ?? LAUNCH_CEILING_LANES
  const lanes = arms.length * runs
  if (lanes > ceiling) {
    throw new LaunchValidationError(
      `"arms" × "runs" = ${lanes} spending lanes may not exceed the launch ceiling of ${ceiling}` +
        `${ceilingOverride === undefined ? ' (the default)' : ' (your "ceilingOverride")'} — received ${arms.length} arm(s) × ${runs} run(s); ` +
        `pass "ceilingOverride": ${lanes} to authorise exactly this many, and it is recorded on every fork.dispatched this launch produces (prd53 ruling 6)`,
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

  return { lane, checkpointId, arms: parsedArms, runs, ...(ceilingOverride === undefined ? {} : { ceilingOverride }) }
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
        // The operator's declared ceiling travels to the engine, which
        // records it on every fork.dispatched (prd53 ruling 6).
        ...(request.ceilingOverride === undefined ? [] : ['--ceiling-override', String(request.ceilingOverride)]),
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

// --- measure (prd53 ruling 3: an outcome is per run, typed with its provenance, and measuring is a write) ---

export class MeasureValidationError extends Error {}

/** The laboratory said no such fork is recorded — the one failure a caller can act on differently from a crash (404, not 500). */
export class MeasureUnknownForkError extends Error {}

export interface MeasureRequestBody {
  forkId: string
  /** The gate command run in every run's worktree. The CLI's default (`npm test`) when absent. */
  verifyCommand?: string
}

export interface MeasuredRunResult {
  arm: number
  run: number
  laneHandle: string
  verified: 'pass' | 'fail' | 'not-run'
  verifiedDetail: string | null
  commits: number | null
}

export interface MeasureResult {
  forkId: string
  verifyCommand: string
  measured: MeasuredRunResult[]
}

export interface MeasureExperimentOptions extends LaunchExperimentOptions {
  /** Where the verdicts are written — the server's live recorder, the same log the experiments listing reads. */
  recorder: Pick<SessionRecorder, 'record'>
}

function parseMeasureRequestBody(body: unknown): MeasureRequestBody {
  if (typeof body !== 'object' || body === null) {
    throw new MeasureValidationError('request body must be a JSON object')
  }
  const { forkId, verifyCommand } = body as Record<string, unknown>
  if (typeof forkId !== 'string' || forkId.trim().length === 0) {
    throw new MeasureValidationError('"forkId" must be a non-empty string — the experiment to measure')
  }
  // Both values reach the CLI as argv (`--verify <cmd>`, then `-- <forkId>`);
  // the same `--help` pre-scan `refuseFlagShaped` guards the launch against
  // reads this argv too, so the same first-character rule applies.
  if (forkId.trim().startsWith('-')) {
    throw new MeasureValidationError(`"forkId" may not begin with "-" (received "${forkId.trim()}") — a fork id names an experiment, not a flag`)
  }
  if (verifyCommand !== undefined) {
    if (typeof verifyCommand !== 'string' || verifyCommand.trim().length === 0) {
      throw new MeasureValidationError('"verifyCommand" must be a non-empty string when present — the gate every run is judged by')
    }
    if (verifyCommand.trim().startsWith('-')) {
      throw new MeasureValidationError(`"verifyCommand" may not begin with "-" (received "${verifyCommand.trim()}") — a gate is a command, not a flag`)
    }
  }
  return { forkId: forkId.trim(), ...(verifyCommand === undefined ? {} : { verifyCommand: verifyCommand.trim() }) }
}

/** The shape `rhizomorph lab compare --json` prints — `ForkComparison`, read back without importing `lab/compare.ts`. */
interface ComparisonDocument {
  forkId: string
  verifyCommand: string
  arms: Array<{
    arm: number
    run: number
    laneHandle: string
    verified: 'pass' | 'fail' | 'not-run'
    verifiedDetail: string | null
    commits: number | null
  }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseComparisonJson(stdout: string): ComparisonDocument | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.forkId !== 'string' || typeof parsed.verifyCommand !== 'string') return null
  if (!Array.isArray(parsed.arms)) return null
  const arms: ComparisonDocument['arms'] = []
  for (const row of parsed.arms) {
    if (!isRecord(row)) return null
    const { arm, run, laneHandle, verified, verifiedDetail, commits } = row
    if (typeof arm !== 'number' || typeof run !== 'number' || typeof laneHandle !== 'string') return null
    if (verified !== 'pass' && verified !== 'fail' && verified !== 'not-run') return null
    if (typeof verifiedDetail !== 'string' && verifiedDetail !== null) return null
    if (typeof commits !== 'number' && commits !== null) return null
    arms.push({ arm, run, laneHandle, verified, verifiedDetail, commits })
  }
  return { forkId: parsed.forkId, verifyCommand: parsed.verifyCommand, arms }
}

/**
 * Measures one experiment: runs `rhizomorph lab compare <forkId> --verify <cmd>
 * --json` through `runCli` — the one door the namespace law leaves this file —
 * so the gate command runs in every run's own worktree exactly as it would
 * for a human typing it, then records ONE `fork.measured` per run on the live
 * log (prd53 ruling 3). That record is what `GET /api/lab/experiments` reads
 * back as each run's `outcome`, so the console sees what the CLI saw, from
 * the same fold, with the provenance attached.
 *
 * Measuring is a write twice over — real minutes of CPU in the arms'
 * worktrees, and events on the record — which is why this is a gated
 * mutation and not the read it resembles. The CLI's own `compare` stays a
 * read: it prints and records nothing. The route is the hand that writes.
 */
export async function measureExperiment(body: unknown, options: MeasureExperimentOptions): Promise<MeasureResult> {
  const request = parseMeasureRequestBody(body)
  const argv = [
    'compare',
    '--json',
    '--path', options.repoPath,
    ...(request.verifyCommand === undefined ? [] : ['--verify', request.verifyCommand]),
    '--', request.forkId,
  ]

  const invocation = await withLabCliLock(
    `measure of fork "${request.forkId}"`,
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
    const detail = invocation.stderr.trim() || `rhizomorph lab compare exited ${invocation.exitCode}`
    if (/^no fork "/.test(detail)) throw new MeasureUnknownForkError(detail)
    throw new Error(`could not measure fork ${request.forkId}: ${detail}`)
  }

  const comparison = parseComparisonJson(invocation.stdout)
  if (comparison === null || comparison.forkId !== request.forkId) {
    throw new Error(`could not read the comparison for fork ${request.forkId} — unexpected CLI output`)
  }

  const nextId = createIdFactory('lab')
  const now = options.now ?? Date.now
  const measured: MeasuredRunResult[] = []
  for (const row of comparison.arms) {
    const event = createEvent(
      'fork.measured',
      {
        forkId: comparison.forkId,
        laneHandle: row.laneHandle,
        arm: row.arm,
        run: row.run,
        verified: row.verified,
        verifiedDetail: row.verifiedDetail,
        verifyCommand: comparison.verifyCommand,
        commits: row.commits,
        source: 'measure-route',
      },
      { id: nextId(), ts: now() },
    )
    await options.recorder.record(event)
    measured.push({
      arm: row.arm,
      run: row.run,
      laneHandle: row.laneHandle,
      verified: row.verified,
      verifiedDetail: row.verifiedDetail,
      commits: row.commits,
    })
  }

  return { forkId: comparison.forkId, verifyCommand: comparison.verifyCommand, measured }
}

export function registerLabRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/lab/checkpoints', { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') }, async () => {
    const events = await readAllEvents(ctx)
    return { checkpoints: await checkpointDTOs(events) }
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
      const runsRaw = typeof query.runs === 'string' ? Number(query.runs) : 1

      if (lane.length === 0 || !Number.isInteger(armsRaw) || armsRaw < 1) {
        return reply
          .code(400)
          .send({ error: '"lane" (non-empty string) and "arms" (positive integer) query params are required' })
      }
      if (!Number.isInteger(runsRaw) || runsRaw < 1) {
        return reply.code(400).send({ error: '"runs" must be a positive integer when present (prd53 ruling 1)' })
      }

      return estimateLaunchSpend(ctx, lane, armsRaw, runsRaw)
    },
  )

  // prd53 ruling 3: measuring is a write. It runs a gate command in every
  // run's worktree (real CPU, real minutes) and records the verdicts on the
  // live log, so it is gated exactly like the launch it measures and reaches
  // the laboratory the same way — through `runCli`, never an import.
  app.post('/api/lab/measure', { preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') }, async (request: FastifyRequest, reply) => {
    if (ctx.readOnly === true) {
      return reply.code(409).send({
        error: 'this server is replaying a session record, not watching a repo — there is nothing live to measure',
      })
    }

    try {
      return await measureExperiment(request.body, {
        repoPath: ctx.repoPath,
        recorder: ctx.recorder,
        ...(ctx.now === undefined ? {} : { now: ctx.now }),
      })
    } catch (err) {
      if (err instanceof MeasureValidationError) {
        return reply.code(400).send({ error: err.message })
      }
      if (err instanceof MeasureUnknownForkError) {
        return reply.code(404).send({ error: err.message })
      }
      if (err instanceof LabCliLockCeilingError) {
        return reply.code(503).send({ error: err.message })
      }
      throw err
    }
  })

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
