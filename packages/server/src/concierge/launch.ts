import { spawn } from 'node:child_process'
import type { AgentRole, CapabilityDetail } from '@rhizomorph/core'
import { isSafeSessionId } from '../log/transcript-attribution.js'
import { harnessById } from './harness/registry.js'
import type {
  ContinuityPlan,
  HarnessAdapter,
  HarnessEnvRecipe,
  HarnessId,
  HarnessLaunchContext,
  HarnessPresence,
} from './harness/types.js'

/**
 * prd-20 ruling 1 / ADR-0019's first power, wired for real (#264):
 * "spawn a conductor in the watched repo with the env envelope" —
 * generalizing `scripts/lane-agent.sh`'s trick (resolve the env, THEN exec,
 * in one process) server-side, via `node:child_process`'s `spawn` with an
 * explicit `env` option, never a shell `eval`. The SCAR this answers: an env
 * block merely PREFIXED onto a command line can vanish before it ever
 * reaches the process that command execs — `.workmux.yaml`'s history, proven
 * only by reading `/proc/<pid>/environ` (`lane-agent.sh`'s own doc). Passing
 * `env` straight into `spawn`'s own options means the launched process's
 * environment IS this call's `env` argument, never a hope that something
 * upstream forwarded it.
 *
 * Two phases, the same shape as `clone.ts` and for the same reason:
 * {@link planLaunch} answers every question the harness registry and its own
 * `detect()` can answer before a byte of `spawn` runs — is `harness` one this
 * registry knows, is it implemented, is one actually launchable on this
 * machine, does the requested mode make sense for it — so a caller gets a
 * precise, typed failure before a process exists. {@link runLaunch} only
 * ever runs once planning has already succeeded, and it never throws: prd-20
 * ruling 3 is explicit that "the caller watches the connection facts flip,
 * never trusts the spawn's exit code", so this module's own job stops at "did
 * the OS actually create the process" — whether it goes on to export
 * telemetry is `/api/meta`'s `connection` facts' story to tell, not this
 * module's.
 *
 * The launched process is spawned detached and `unref`'d, stdio ignored: it
 * must outlive both this HTTP request and this server. Nothing here opens a
 * terminal, a pane, or any surface for the operator to type into — that
 * interaction surface is a known, explicit gap this issue does not close
 * (prd-20 leaves several such things "open, not ruled", and this is another).
 */

export class ConciergeLaunchValidationError extends Error {}

/**
 * A named, real harness that cannot be launched right now — either it is
 * `declared`, not `implemented` (ADR-0010's honesty style: listed, never
 * guessed), or `detect()` says this machine has none this hand could
 * actually start. Distinct from {@link ConciergeLaunchValidationError}: the request
 * named something real: the MACHINE is what refuses, not the request shape.
 */
export class HarnessNotAvailableError extends Error {}

/**
 * `mode: 'continue'` or `mode: 'resume'` was requested for a harness whose
 * continuity plan (respectively `continueArgv`'s or `resumeArgv`'s) is
 * `kind: 'none'`.
 */
export class LaunchContinuityUnavailableError extends Error {}

/**
 * `'resume'` is distinct from `'continue'`: `continue` means "the most recent
 * session, whichever that is" and carries no id; `resume` means "this exact
 * prior session", named by the caller, and requires a `sessionId` — prd-20 w6.
 */
export type LaunchMode = 'launch' | 'continue' | 'resume'

/**
 * `POST /api/concierge/launch`'s body: which harness, and fresh,
 * relaunch-with-continuity, or resume-by-id.
 *
 * `sessionId` is required and non-empty exactly when `mode: 'resume'` — never
 * present on any other mode, and never trusted unchecked: it is validated
 * with {@link isSafeSessionId} here, at parse time, so a malformed id can
 * never reach a spawned argv or a filesystem path. `isSafeSessionId` lives in
 * `log/transcript-attribution.ts`; the concierge is free to import outward
 * from its own namespace, the namespace law only fences who may import IN.
 */
export function parseConciergeLaunchRequestBody(
  body: unknown,
): { harness: string; mode: LaunchMode; sessionId?: string } {
  if (typeof body !== 'object' || body === null) {
    throw new ConciergeLaunchValidationError('request body must be a JSON object')
  }
  const { harness, mode, sessionId } = body as Record<string, unknown>
  if (typeof harness !== 'string' || harness.length === 0) {
    throw new ConciergeLaunchValidationError('"harness" must be a non-empty string')
  }
  if (mode !== 'launch' && mode !== 'continue' && mode !== 'resume') {
    throw new ConciergeLaunchValidationError('"mode" must be "launch", "continue" or "resume"')
  }

  if (mode !== 'resume') {
    if (sessionId !== undefined) {
      throw new ConciergeLaunchValidationError(`"sessionId" may only be supplied when mode is "resume", not "${mode}"`)
    }
    return { harness, mode }
  }

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new ConciergeLaunchValidationError('"sessionId" must be a non-empty string when mode is "resume"')
  }
  if (!isSafeSessionId(sessionId)) {
    throw new ConciergeLaunchValidationError(`"sessionId" is not a safe session id: ${JSON.stringify(sessionId)}`)
  }
  return { harness, mode, sessionId }
}

/**
 * The lane and role the concierge launches under — always `conductor`, never
 * caller-supplied. prd-20's non-goal is "no simultaneous multi-repo": this
 * hand starts the one process a watched repo has, never a lane the
 * laboratory would otherwise dispatch (that hand's own grant, ADR-0001, is
 * untouched). `docs/telemetry.md`'s manual instructions name the identical
 * pair for the process this route replaces: `rhizomorph env conductor --role
 * conductor`.
 */
const CONDUCTOR_LANE = 'conductor'
const CONDUCTOR_ROLE: AgentRole = 'conductor'

export interface PlanLaunchContext {
  /** The repo this server is watching — the conductor's `cwd`. Never a caller-supplied path. */
  readonly watchedRepoPath: string
  /** This Rhizomorph's own OTLP receiver port — {@link HarnessLaunchContext.port}. */
  readonly port: number
  /** This Rhizomorph's own instance id — {@link HarnessLaunchContext.instance}. */
  readonly instance: string
  /** Defaults to the real registry's {@link harnessById}; overridable so a test needs no real machine. */
  readonly harnessLookup?: (id: string) => HarnessAdapter | undefined
}

export interface LaunchPlan {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  /** {@link HarnessAdapter.envRecipe}'s own honest claim about whether telemetry actually arrives — passed through, never upgraded. */
  readonly telemetry: CapabilityDetail
  /** Present only for `mode: 'continue'` or `mode: 'resume'` — what continuity means for this harness, and what it costs (ruling 3). */
  readonly continuity?: ContinuityPlan
}

/** Presence states other than `present`, and the one field each carries the honest reason in. */
function unavailableReason(presence: Exclude<HarnessPresence, { state: 'present' }>): string {
  if (presence.state === 'absent') return presence.evidence
  return presence.remedy === undefined ? presence.reason : `${presence.reason} — ${presence.remedy}`
}

/**
 * `ContinuityPlan.argv`'s own doc: "arguments appended to launchArgv's
 * COMMAND" — argv[0] only, not the whole fresh-launch array. codex's own
 * `continueArgv` comment says the same thing from the other side ("argv[0]
 * is settled there and not restated here"): its `argv` already carries its
 * OWN copy of the config after `resume --last`/`resume`, so appending it
 * after the FULL `fresh` array would run the config twice and put the resume
 * verb in the wrong position. Taking only `fresh[0]` (the resolved
 * executable) is what keeps this correct for both `continueArgv` and
 * `resumeArgv` alike — the same seam, the same trap, the same fix.
 *
 * `kind: 'none'` refuses with {@link LaunchContinuityUnavailableError} rather
 * than returning a plan with no argv: a caller with nothing to continue or
 * resume gets a typed, precise failure before a process exists.
 */
function planFromContinuity(
  adapter: HarnessAdapter,
  fresh: readonly string[],
  continuity: ContinuityPlan,
  envRecipe: HarnessEnvRecipe,
  cwd: string,
  storyName: string,
): LaunchPlan {
  if (continuity.kind === 'none') {
    throw new LaunchContinuityUnavailableError(`${adapter.displayName} has no ${storyName}: ${continuity.reason}`)
  }
  return {
    argv: [fresh[0] as string, ...continuity.argv],
    env: envRecipe.env,
    cwd,
    telemetry: envRecipe.telemetry,
    continuity,
  }
}

/**
 * Every check that can be answered before a process exists: is `harnessId`
 * one {@link harnessById} knows, is it `implemented` (not merely `declared` —
 * ADR-0010), does `detect()` find a launchable one on this machine, and — for
 * `mode: 'continue'`/`mode: 'resume'` — does the adapter have a continuity
 * story at all. Throws {@link ConciergeLaunchValidationError},
 * {@link HarnessNotAvailableError} or {@link LaunchContinuityUnavailableError}
 * — three distinct failures `api/concierge.ts` maps to three distinct HTTP
 * statuses, so a caller can tell "you asked for something that isn't real"
 * from "that's real, but not on this machine" from "that's real and present,
 * but has nothing to continue/resume".
 *
 * `sessionId` is required exactly when `mode === 'resume'` —
 * {@link parseConciergeLaunchRequestBody} already enforces this on the wire,
 * but this function is called directly by tests and is not willing to trust
 * a caller that skipped parsing, so it is checked again here.
 */
export async function planLaunch(
  harnessId: string,
  mode: LaunchMode,
  context: PlanLaunchContext,
  sessionId?: string,
): Promise<LaunchPlan> {
  const lookup = context.harnessLookup ?? ((id: string) => harnessById(id as HarnessId))
  const adapter = lookup(harnessId)
  if (adapter === undefined) {
    throw new ConciergeLaunchValidationError(`unknown harness "${harnessId}"`)
  }
  if (adapter.implementation.status === 'declared') {
    throw new HarnessNotAvailableError(`${adapter.displayName} is not implemented: ${adapter.implementation.reason}`)
  }
  if (mode === 'resume' && (sessionId === undefined || sessionId.length === 0)) {
    throw new ConciergeLaunchValidationError('"sessionId" is required for mode: "resume"')
  }

  const detection = await adapter.detect()
  if (detection.onPath.state !== 'present') {
    throw new HarnessNotAvailableError(
      `${adapter.displayName} cannot be launched on this machine: ${unavailableReason(detection.onPath)}`,
    )
  }

  const launchContext: HarnessLaunchContext = {
    lane: CONDUCTOR_LANE,
    role: CONDUCTOR_ROLE,
    port: context.port,
    instance: context.instance,
    executablePath: detection.onPath.executablePath,
  }

  const envRecipe = adapter.envRecipe(launchContext)
  // Already complete for a fresh launch — telemetry config included
  // (`HarnessAdapter.launchArgv`'s own doc). `envRecipe.configArgv` is NOT
  // appended a second time here: codex's `launchArgv` already folds its own
  // `configArgv` in, and doing so again would duplicate every `-c` override
  // on the spawned command line.
  const fresh = adapter.launchArgv(launchContext)

  if (mode === 'launch') {
    return { argv: fresh, env: envRecipe.env, cwd: context.watchedRepoPath, telemetry: envRecipe.telemetry }
  }

  if (mode === 'resume') {
    return planFromContinuity(
      adapter,
      fresh,
      adapter.resumeArgv(launchContext, sessionId as string),
      envRecipe,
      context.watchedRepoPath,
      'resume-by-id story',
    )
  }

  // mode === 'continue'
  return planFromContinuity(
    adapter,
    fresh,
    adapter.continueArgv(launchContext),
    envRecipe,
    context.watchedRepoPath,
    'relaunch-with-continuity story',
  )
}

export type LaunchOutcome = { kind: 'launched'; pid: number } | { kind: 'error'; message: string }

/** The minimal shape {@link runLaunch} needs from a spawned child — real `ChildProcess` satisfies it structurally. */
export interface SpawnedLaunch {
  readonly pid?: number
  unref(): void
  once(event: 'spawn', listener: () => void): this
  once(event: 'error', listener: (err: Error) => void): this
}

export interface SpawnLaunchOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export type SpawnLaunchFn = (command: string, args: readonly string[], options: SpawnLaunchOptions) => SpawnedLaunch

/**
 * `detached: true`, `stdio: 'ignore'`: the conductor must survive both this
 * request and this server's own exit, and nothing here reads its output.
 * `env` is `process.env` merged with the recipe's own block — the same
 * merge shape `server/exec.ts` already uses for collectors — never the
 * recipe alone, so the launched process still inherits `PATH` and everything
 * else an ordinary shell launch would have given it.
 *
 * Exported so the SCAR's own line is pinned by a test rather than living in
 * the one seam tests cannot reach: every test injects `spawnLaunch`, so
 * without this the real merge order (recipe over inherited, never recipe
 * alone) survived mutation — swapping it left all 195 targeted tests green.
 * #264's own Direction names exactly this failure: "an env prefix that
 * doesn't reach the exec'd process fails invisibly."
 */
export function launchSpawnNodeOptions(options: SpawnLaunchOptions): {
  cwd: string
  env: Record<string, string>
  detached: true
  stdio: 'ignore'
} {
  return {
    cwd: options.cwd,
    env: { ...(process.env as Record<string, string>), ...options.env },
    detached: true,
    stdio: 'ignore',
  }
}

const realSpawnLaunch: SpawnLaunchFn = (command, args, options) =>
  spawn(command, args, launchSpawnNodeOptions(options))

export interface RunLaunchOptions {
  spawnLaunch?: SpawnLaunchFn
}

/**
 * Spawns {@link LaunchPlan}, detached and stdio-ignored, `unref`'s it, then
 * walks away. Never throws — resolves `{ kind: 'error' }` for a spawn that
 * never started (the binary vanished between `detect()` and here, or
 * similar), and ruling 3 means even a clean `{ kind: 'launched' }` is not a
 * claim that telemetry is flowing: only that the OS created the process.
 * No clock: exactly one of the child's own `spawn`/`error` events settles
 * this, the same event-driven shape `clone.ts`'s `runClone` uses for `git`.
 */
export function runLaunch(plan: LaunchPlan, options: RunLaunchOptions = {}): Promise<LaunchOutcome> {
  const spawnLaunch = options.spawnLaunch ?? realSpawnLaunch
  return new Promise((resolve) => {
    const [command, ...args] = plan.argv
    const child = spawnLaunch(command as string, args, { cwd: plan.cwd, env: plan.env })
    child.once('spawn', () => {
      child.unref()
      resolve({ kind: 'launched', pid: child.pid as number })
    })
    child.once('error', (err) => {
      resolve({ kind: 'error', message: `could not start ${command as string}: ${err.message}` })
    })
  })
}
