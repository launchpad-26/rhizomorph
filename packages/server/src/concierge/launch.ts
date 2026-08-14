import { spawn } from 'node:child_process'
import type { AgentRole, CapabilityDetail, Exec } from '@rhizomorph/core'
import { isSafeSessionId } from '../log/transcript-attribution.js'
import { exec as realExec } from '../server/exec.js'
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
 * ## The gap that was not a gap (#532)
 *
 * The paragraph that used to end this header said the launched process is
 * spawned detached, `unref`'d, stdio ignored, and that "nothing here opens a
 * terminal, a pane, or any surface for the operator to type into — that
 * interaction surface is a known, explicit gap this issue does not close".
 *
 * That reading was wrong, and the wave-8 live proof is what proved it wrong: a
 * real `claude --resume <id>` under those exact conditions does not sit there
 * waiting for a terminal that never comes. It **exits at once** — "Provide a
 * prompt to continue the conversation" — in every mode, launch, continue and
 * resume alike. So the missing surface was not a usability gap on top of a
 * working spawn; it was the reason nothing survived the spawn. And because
 * #264's tests all inject `spawnLaunch`, no test ever ran a real interactive
 * CLI, so `{kind:'launched', pid}` was reported over a corpse every time.
 *
 * Two halves answer it, and they answer different questions.
 *
 * ### 1. A TTY when one is reachable — {@link tryTmuxLaunch}
 *
 * When a tmux server is running, this launches the conductor into a real
 * window (`tmux new-window -d`) instead of into the void. The operator can
 * then attach and type, which is the whole point of an interactive harness,
 * and the response says WHERE it landed (`via: 'tmux'`, and the
 * `session:index` to attach to) rather than only that a process exists. The
 * precedent is the repo's own: `scripts/lane-agent.sh` and workmux both put
 * agents in panes, and `collectors/tmux/` already reads them back.
 *
 * **And it settles before it claims, exactly as the detached path does**
 * (ledger #3). `new-window`'s report is made the moment the window is created;
 * it says a window exists, never that anything is still running in it. Trusting
 * it was #532's own defect at one remove — the detached path had stopped
 * trusting `spawn`'s success while this path went on trusting `new-window`'s.
 * So after the SAME {@link LAUNCH_SETTLE_MS} window, on the same injected
 * clock, {@link tmuxPaneStillThere} asks tmux whether the pane is there; a
 * vanished or dead pane is `{kind:'died', via:'tmux'}` carrying the window it
 * would have pointed the operator at. The #532 death itself cannot recur here
 * (a pane has a TTY) — what this catches is every other insta-death, a wrapper
 * refusing its arguments or a harness exiting on a bad config.
 *
 * **The honest limit, stated rather than discovered.** `tmux new-window`'s
 * window command is a COMMAND STRING, which tmux hands to a shell — the very
 * thing namespace-law clause 4 exists to keep out of this module. Clause 4's
 * own documented shape is "an argv launch of a shell" (#373), and that is
 * exactly what this is: tmux itself is invoked in argv form through ADR-0004's
 * `Exec` seam (never `exec`/a command line of our own), so nothing this module
 * writes is parsed by a shell of ours; what tmux then does with the string is
 * tmux's documented behaviour. The mitigation is that every value interpolated
 * into that string is fenced twice over:
 *
 * - `sessionId` passed `isSafeSessionId` at parse time, before it could reach
 *   any argv at all ({@link parseConciergeLaunchRequestBody});
 * - argv[0] is the executable `detect()` verified on PATH, never caller text;
 * - every token is then POSIX single-quoted by {@link quoteForTmux}, which
 *   also REFUSES a token carrying a control character — and a refusal is a
 *   fall back to the detached path, never a "quote it and hope";
 * - the env envelope never enters the string at all. It rides as tmux's own
 *   `-e KEY=VALUE` argv flags (tmux ≥ 3.2), which no shell ever sees. On an
 *   older tmux `new-window` fails on the unknown flag, and this falls back to
 *   the detached path rather than degrading to a quoted `env …` prefix.
 *
 * ### 2. Liveness honesty when it is not — {@link runDetachedLaunch}
 *
 * With no tmux, the detached spawn is still the only thing available, and it
 * will still die. What changes is that this stops CLAIMING otherwise: after
 * `spawn` fires, a short bounded window ({@link LAUNCH_SETTLE_MS}) is given to
 * the child's own `exit` event. A child that exits inside it resolves
 * `{kind:'died'}` — carrying its exit status and the known no-TTY explanation,
 * pointing at the command line the operator can run themselves — and never
 * `launched`. Ruling 3 already said a `launched` is not a claim that telemetry
 * is flowing; this makes it at least a claim that something is still running.
 *
 * **Why no stderr tail, when the outcome would read better with one.** It
 * would cost the fix its own premise. Capturing stderr means a pipe, and this
 * server owns the read end: when the server exits, the conductor it launched
 * to outlive it starts writing into a pipe with no reader and takes an EPIPE
 * for it. Killing the process this route exists to keep alive, to improve the
 * wording of the message for the case where it died anyway, is a bad trade.
 * The exit status and the signal are the child's own evidence and cost
 * nothing, so those are what the message carries.
 *
 * ### The clock this module still does not own (clause 3)
 *
 * A bounded window needs a clock, and nothing under `concierge/` may schedule
 * work — the law's clause 3, and `clone.ts` says the same for itself. So the
 * wait is **the caller's**, a required field of {@link RunLaunchOptions}, not
 * an optional one with a timer hidden behind it: `api/concierge.ts` supplies
 * the real one, which is precisely where `clone.ts`'s own header already
 * points for "a hard wall-clock cap on top of that". Required rather than
 * optional so a future call site cannot silently opt back into claiming
 * `launched` over a corpse — there is no default to fall through to.
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

/**
 * What became of the launch, and — for the two that made a process — WHERE.
 *
 * `via` is not decoration: "there is a pid" and "there is a window you can
 * attach to and type into" are different facts about an interactive harness,
 * and #532 is the bill for reporting the first as if it were the second.
 *
 * - `launched, via: 'tmux'` — a real window in a real tmux session, named by
 *   `window` (`<session>:<index>`, what `tmux attach -t` takes) with the
 *   pane's own pid. The one outcome where the operator has a surface to type
 *   into.
 * - `launched, via: 'detached'` — a detached, TTY-less process that was still
 *   alive when the settle window closed. Everything ruling 3 says about a
 *   `launched` still applies, and so does the reason it may not last: an
 *   interactive harness with nothing attached has no one to talk to.
 * - `died` — the process was made and was gone again within the settle window.
 *   The defect class #532 named, now a reportable outcome instead of a lie.
 *   It has BOTH `via` values, and that is the point of the second one: a tmux
 *   window is a stronger claim than a pid, so it earns the same settle-window
 *   check the detached path already made rather than being trusted because
 *   `new-window` said so (ledger #3).
 * - `error` — no process was made at all (the binary vanished between
 *   `detect()` and here), or tmux made a window it then could not describe.
 */
export type LaunchOutcome =
  | { kind: 'launched'; via: 'tmux'; pid: number; window: string }
  | { kind: 'launched'; via: 'detached'; pid: number }
  | { kind: 'died'; via: 'detached'; message: string }
  | { kind: 'died'; via: 'tmux'; window: string; message: string }
  | { kind: 'error'; message: string }

/** The minimal shape {@link runLaunch} needs from a spawned child — real `ChildProcess` satisfies it structurally. */
export interface SpawnedLaunch {
  readonly pid?: number
  unref(): void
  once(event: 'spawn', listener: () => void): this
  once(event: 'error', listener: (err: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
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
 *
 * `stdio: 'ignore'` survives #532 unchanged, and the header says why at
 * length: piping stderr to quote it back in a `died` message would hand this
 * server the read end of a pipe the conductor must outlive, which is a way of
 * killing the healthy launches to describe the dead ones better.
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

/**
 * How long a detached child gets to prove it is still there before this
 * reports `launched`. Short enough that the one HTTP request the operator is
 * already waiting on does not visibly stall, long enough for the failure it
 * exists to catch: the live capture in #532 had `claude` printing its refusal
 * and exiting immediately, which is milliseconds, not seconds.
 *
 * It is a floor on honesty, never a promise of health — a process that dies at
 * 1.6 seconds is reported `launched` here and shows up as a connection fact
 * that never flips, which is ruling 3's own answer to "is it really working".
 */
export const LAUNCH_SETTLE_MS = 1500

/** The tmux window a launched conductor is given, so the operator can find it by name and not by index alone. */
export const CONDUCTOR_WINDOW_NAME = 'rhizomorph-conductor'

/** Neither probe reads a large output and neither should ever hang; a tmux that does is a tmux this falls back from. */
const TMUX_PROBE_TIMEOUT_MS = 2000

export interface RunLaunchOptions {
  spawnLaunch?: SpawnLaunchFn
  /**
   * ADR-0004's argv-form seam, used for `tmux` and nothing else. Defaults to
   * the real `server/exec.ts`. A test injects one and needs no tmux; an
   * injected exec that fails is exactly what "this machine has no tmux" looks
   * like from here.
   */
  exec?: Exec
  /**
   * Resolves after roughly `ms`. **Required** — the concierge owns no clock
   * (namespace-law clause 3), and see this module's header for why this is not
   * an optional field with a hidden default.
   */
  wait: (ms: number) => Promise<void>
  /** Override {@link LAUNCH_SETTLE_MS}. Tests name their own; production never passes one. */
  settleMs?: number
}

/**
 * POSIX single-quoting for one token of a tmux window command, or `null` for a
 * token that may not be quoted at all.
 *
 * `'` → `'\''` is the whole of the escaping, and it is total: inside single
 * quotes a POSIX shell gives no character any meaning, so a correctly closed
 * and reopened quote leaves nothing a value can do. A CONTROL CHARACTER is
 * refused rather than quoted anyway — not because quoting would fail on it,
 * but because no legitimate token here contains one (argv[0] is a detected
 * executable path, the rest is `isSafeSessionId`-fenced) and a refusal that
 * falls back to the detached path costs nothing, while a newline reaching a
 * command line is the one class worth never testing our quoting against.
 */
function quoteForTmux(token: string): string | null {
  // Char codes rather than a regex: the class this refuses is exactly the one
  // a regex literal cannot spell without carrying control characters in this
  // file's own source text.
  for (const character of token) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return null
  }
  return `'${token.replaceAll("'", "'\\''")}'`
}

/** The whole argv as one quoted command line, or `null` if any token was refused. */
function tmuxCommandLine(argv: readonly string[]): string | null {
  const quoted: string[] = []
  for (const token of argv) {
    const safe = quoteForTmux(token)
    if (safe === null) return null
    quoted.push(safe)
  }
  return quoted.join(' ')
}

/**
 * The env envelope as tmux's own `-e KEY=VALUE` argv flags — never text in the
 * window command. This is the half of the tmux path that touches no shell at
 * all: tmux sets these in the pane's environment itself.
 */
function tmuxEnvFlags(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`])
}

/**
 * Launch into a real tmux window, or `null` when this machine cannot offer one
 * — no tmux server, no session to hang a window on, a token this refuses to
 * quote, or a `new-window` that failed (an old tmux with no `-e`, most
 * likely). Every one of those is a fall-back to the detached path, so `null`
 * always means "nothing was started here".
 *
 * The one non-null non-launch is deliberate: once `new-window` has SUCCEEDED a
 * window exists, and this must never return `null` after that point, because
 * `null` means the caller spawns a second conductor. So a `new-window` that
 * somehow reports no pane pid resolves `{kind:'error'}` naming the window it
 * did make, rather than falling back and starting a second one.
 *
 * **Executed against real tmux 3.4** (2026-08-14, on a throwaway `-L` socket
 * so no operator's own server was touched), because every test below injects
 * `Exec` and would therefore be just as green against an argv tmux rejects:
 * `has-session` exits 0 with a server running and 1 with none; `list-sessions
 * -F '#{session_name}'` prints one name per line; and this exact `new-window`
 * argv answered `4069121 main:1` — parsed here as pid and window — with both
 * `-e` variables present in the pane's own environment and the single-quoted
 * command line running as written.
 */
async function tryTmuxLaunch(plan: LaunchPlan, exec: Exec, run: RunLaunchOptions): Promise<LaunchOutcome | null> {
  const options = { cwd: plan.cwd, timeoutMs: TMUX_PROBE_TIMEOUT_MS }

  // Is a tmux server reachable at all? Cheapest possible probe, and the one
  // that answers "no tmux installed" (a spawn error) and "installed, no server
  // running" identically — both are `failed`, and both mean no window.
  const probe = await exec('tmux', ['has-session'], options)
  if (probe.failed) return null

  // WHICH session gets the window. Named, not defaulted: `new-window` with no
  // `-t` picks tmux's own current session, which outside a client is whichever
  // was most recently used — and the response would then be naming a window in
  // a session this never looked at.
  const sessions = await exec('tmux', ['list-sessions', '-F', '#{session_name}'], options)
  if (sessions.failed) return null
  const session = sessions.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (session === undefined) return null

  const command = tmuxCommandLine(plan.argv)
  if (command === null) return null

  // `-d` so the operator's current pane is not yanked away by a window they
  // asked for in a browser; `-P -F` so the answer names the window rather than
  // leaving the operator to hunt for it.
  const created = await exec(
    'tmux',
    [
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{pane_pid} #{session_name}:#{window_index}',
      '-t',
      session,
      '-n',
      CONDUCTOR_WINDOW_NAME,
      '-c',
      plan.cwd,
      ...tmuxEnvFlags(plan.env),
      command,
    ],
    { cwd: plan.cwd },
  )
  if (created.failed) return null

  const reported = created.stdout.trim()
  const separator = reported.indexOf(' ')
  const pid = Number(separator === -1 ? '' : reported.slice(0, separator))
  const window = separator === -1 ? '' : reported.slice(separator + 1).trim()
  if (!Number.isInteger(pid) || pid <= 0 || window.length === 0) {
    return {
      kind: 'error',
      message:
        `tmux created a window in session ${session} but did not report a pane pid and window index ` +
        `(it answered ${JSON.stringify(reported)}). The conductor may well be running: look for the ` +
        `${CONDUCTOR_WINDOW_NAME} window. Nothing else was started, so there is no second process.`,
    }
  }

  // THE SAME SETTLE WINDOW THE DETACHED PATH GIVES, for the same reason
  // (ledger #3). Everything above is `new-window`'s own report, and that report
  // is made the instant the window is created — it says a window was made, not
  // that anything is still running in it. #532's exact failure at one remove:
  // the detached path stopped trusting `spawn`'s success and this path went on
  // trusting `new-window`'s.
  //
  // A pane HAS a TTY, so the specific death #532 caught — an interactive
  // harness exiting for want of a terminal — cannot happen here, and this is
  // not that bug again. What it catches is every OTHER insta-death: a wrapper
  // that rejects its arguments, a harness that exits on a bad config, a command
  // tmux could start and the shell could not run. All of those close the pane
  // within milliseconds, and all of them read as `launched` with a window to
  // attach to that is no longer there.
  await run.wait(run.settleMs ?? LAUNCH_SETTLE_MS).catch(() => undefined)
  const still = await tmuxPaneStillThere(window, exec, options)
  if (still !== null) {
    return {
      kind: 'died',
      via: 'tmux',
      window,
      message:
        `the process was started in the tmux window ${window} and was gone again within ` +
        `${String(run.settleMs ?? LAUNCH_SETTLE_MS)}ms — ${still}. The window had a terminal, so this is not the ` +
        'no-TTY death (#532): whatever was launched exited on its own. ' +
        `Run it yourself in a terminal to see what it says: ${plan.argv.join(' ')}`,
    }
  }

  return { kind: 'launched', via: 'tmux', pid, window }
}

/**
 * Whether the window this launch made still holds a live pane — `null` when it
 * does, and the EVIDENCE of its absence when it does not.
 *
 * Two ways a pane is gone, and both are checked because only checking the first
 * would leave the second reading as alive:
 *
 * - the window itself is gone (`list-panes -t` exits non-zero, "can't find
 *   window"), which is what tmux does by default when a pane's command exits;
 * - the window is still listed and its pane is DEAD — `remain-on-exit on`, a
 *   real and not-rare tmux setting, keeps the corpse's pane on screen so the
 *   operator can read what it printed. `#{pane_dead}` is tmux's own name for
 *   exactly that state, and a check that only asked "does the window exist"
 *   would call it a live conductor.
 *
 * An exec that fails for a reason other than a missing window (tmux gone
 * between the two calls, a timeout) also reads as absent here. That is the
 * conservative direction and the one this module already takes everywhere else:
 * "we could not confirm it is there" is reported as not-there, never as
 * launched, because a `died` costs the operator a look at a window that turns
 * out to be fine and a false `launched` costs them the search for a process
 * that never was.
 */
async function tmuxPaneStillThere(
  window: string,
  exec: Exec,
  options: { cwd: string; timeoutMs: number },
): Promise<string | null> {
  const panes = await exec('tmux', ['list-panes', '-t', window, '-F', '#{pane_dead}'], options)
  if (panes.failed) {
    const said = panes.stderr.trim()
    return said.length > 0
      ? `tmux no longer lists a pane in it (${said})`
      : 'tmux no longer lists a pane in it, so the command it was given has already exited'
  }
  const states = panes.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (states.length === 0) return 'tmux listed the window with no pane in it at all'
  // `remain-on-exit on` keeps a dead pane visible; every pane reporting dead is
  // a window the operator can attach to and type into nothing.
  if (states.every((state) => state === '1')) {
    return 'its pane is still on screen and its command has exited (tmux reports the pane dead — this server has `remain-on-exit` on)'
  }
  return null
}

/**
 * The message a corpse gets. It says what happened (the child's own exit
 * status), why it most likely happened (this is the path with no terminal),
 * and what the operator can do instead — the command line itself, which is the
 * no-trust path prd-20 ruling 3 keeps working for exactly this case.
 */
function describeDeath(argv: readonly string[], code: number | null, signal: NodeJS.Signals | null): string {
  const status = signal !== null ? `killed by ${signal}` : `exited with code ${String(code)}`
  return (
    `the process started and then ${status} straight away — nothing survived the launch. ` +
    'No tmux window was available for this launch, so the conductor was spawned detached with no terminal ' +
    'attached, and an interactive harness with no TTY and no prompt exits immediately (#532). ' +
    `Run it yourself in a terminal instead: ${argv.join(' ')}`
  )
}

/**
 * The no-tmux path: spawn detached, `unref`, and then — the half #532 adds —
 * hold the answer open for {@link LAUNCH_SETTLE_MS} to see whether the child
 * is still there. Never throws; exactly one of `error`, `exit`-inside-the-
 * window or the window closing settles it.
 */
function runDetachedLaunch(plan: LaunchPlan, options: RunLaunchOptions): Promise<LaunchOutcome> {
  const spawnLaunch = options.spawnLaunch ?? realSpawnLaunch
  const settleMs = options.settleMs ?? LAUNCH_SETTLE_MS
  return new Promise((resolve) => {
    const [command, ...args] = plan.argv
    let settled = false
    const settle = (outcome: LaunchOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    const child = spawnLaunch(command as string, args, { cwd: plan.cwd, env: plan.env })
    child.once('error', (err) => {
      settle({ kind: 'error', message: `could not start ${command as string}: ${err.message}` })
    })
    // Registered before `spawn` fires, not inside its handler: a child that
    // exits between the two events is precisely the case being caught, and a
    // listener attached later could miss it.
    child.once('exit', (code, signal) => {
      settle({ kind: 'died', via: 'detached', message: describeDeath(plan.argv, code, signal) })
    })
    child.once('spawn', () => {
      child.unref()
      const pid = child.pid as number
      // A clock that rejects is the caller's bug, not evidence about the
      // child — so it closes the window rather than hanging the request the
      // operator is waiting on. If the child had already exited, `settle` has
      // long since answered `died` and this is a no-op.
      void options
        .wait(settleMs)
        .catch(() => undefined)
        .then(() => {
          settle({ kind: 'launched', via: 'detached', pid })
        })
    })
  })
}

/**
 * Starts {@link LaunchPlan}: into a real tmux window when this machine has a
 * tmux server, and detached-with-a-liveness-check when it does not. Never
 * throws — every failure is a value, and ruling 3 means even a clean
 * `launched` is not a claim that telemetry is flowing, only that a process
 * exists and (for `via: 'detached'`) was still there a moment later.
 *
 * The tmux attempt runs FIRST and is all-or-nothing: it either returns an
 * outcome (and nothing detached is spawned) or it returns `null` having
 * started nothing. There is no path on which both run.
 */
export async function runLaunch(plan: LaunchPlan, options: RunLaunchOptions): Promise<LaunchOutcome> {
  const viaTmux = await tryTmuxLaunch(plan, options.exec ?? realExec, options)
  if (viaTmux !== null) return viaTmux
  return runDetachedLaunch(plan, options)
}
