import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { EventOf, Exec, PayloadOf } from '@rhizomorph/core'
import { createEvent, createIdFactory } from '@rhizomorph/core'
import { defaultDataRoot, sessionDirFor, sessionFileName } from '../log/paths.js'
import { findResumableSession, listSessions, RESUME_WINDOW_MS, readSessionEvents } from '../log/session-log.js'
import { exec as realExec, withTimeout } from '../server/exec.js'
import { SessionRecorder } from '../server/recorder.js'
import { armLeaf, armWorktreePath } from './paths.js'
import {
  type CheckpointCoordinates,
  restoreCheckpoint,
  type SynthesizedSession,
} from './restore.js'

/**
 * prd12 phase 2's dispatch half: n arms × r runs of one checkpoint (prd53
 * ruling 1), each run a restored reality of its own, each marked synthetic by
 * the `fork.dispatched` event this module emits.
 *
 * ## Why launching is opt-in
 *
 * The issue's instruction is to launch each arm "through the EXISTING workmux
 * machinery (shell out to `workmux add` ...) — the lab does not reinvent lane
 * launching", and {@link workmuxAddArgv} does exactly that, in the shape
 * `scripts/lane-agent.sh` documents.
 *
 * But `workmux add <handle>` creates a branch in the operator's own ref
 * namespace and a worktree of workmux's choosing, and ruling 1 confines every write
 * the laboratory makes to `refs/rhizomorph/`, worktrees the lab itself
 * creates, and artifacts outside the watched repo. So the lab restores the
 * arm completely — worktree in its own namespace, session synthesized and
 * path-rewritten — and runs the launcher only when the operator says
 * `--launch`, which is them authorising those two writes with their own hand.
 * Restated stronger, never weakened: without the flag the lab writes nothing
 * outside its namespaces, and with it the operator is told exactly what was
 * written and where.
 *
 * When a launch does happen, the arm's session follows the agent: workmux
 * decides which tree the agent runs in, `workmux path` reports it, and if it
 * is not the lab's worktree the session is synthesized there too (ruling 5 —
 * whichever tree the agent wakes up in, its session names that tree and never
 * its parent's).
 */

export interface ForkTreatmentInput {
  /**
   * Which harness an arm runs — prd-57 ruling 8. Defaults to `claude`, the one
   * dialect this repo has a captured headless launch for
   * ({@link headlessLaunchFor}); anything else reaches the copyable-command
   * floor rather than a guessed argv.
   */
  dialect?: string
  /** Model the arms run. Undefined means the fleet default from `.workmux.yaml`. */
  model?: string | undefined
  /** Prompt file handed to each arm. Undefined means workmux's own prompt handling. */
  promptFile?: string | undefined
}

export interface DispatchForkOptions extends ForkTreatmentInput {
  /** The real lane being forked. */
  parentLane: string
  /** The parent lane's worktree — where its checkpoints were captured, and where git runs. */
  parentWorktreePath: string
  /** Which checkpoint to fork from. Undefined takes the lane's most recent. */
  checkpointId?: string | undefined
  /** How many arms. prd12 ruling 4's default is 3. */
  arms: number
  /**
   * How many runs of each arm (prd53 ruling 1). Default 1. Every run is its
   * own restored worktree, its own session and its own `fork.dispatched`;
   * the arm is what they share — one treatment, one number.
   */
  runs?: number | undefined
  /**
   * The number of the first arm this call dispatches. Default 1. With
   * `arms: 1` this reads "dispatch arm k of fork `forkId`" — how `api/lab.ts`'s
   * launch gives every arm its own treatment while all of them stay inside
   * ONE experiment: one `forkId` minted by the caller, one call per arm.
   */
  armNumber?: number | undefined
  /**
   * The operator's declared launch ceiling for THIS dispatch, in spending
   * lanes (arms × runs), when they mean to go past {@link LAUNCH_CEILING_LANES}
   * (prd53 ruling 6). Recorded on every `fork.dispatched` it produces — an
   * override is an act with a name, never a config nobody can find later.
   */
  ceilingOverride?: number | undefined
  /**
   * The `rd.proposal` this experiment came from (prd55 ruling 4). Recorded on
   * every `fork.dispatched` this call produces, so the experiment can be read
   * back to what SUGGESTED it. Undefined when an operator chose it by hand,
   * which is most launches — and the absence means exactly that, never a
   * proposal that went missing.
   *
   * It records provenance, never authority: `rd.override` is what says the
   * operator changed the pick, and nothing here re-attributes a choice to the
   * agent.
   */
  proposalId?: string | undefined
  exec?: Exec
  now?: () => number
  dataRoot?: string
  claudeProjectsRoot?: string
  /** The fork id to dispatch into — the launch's one-per-experiment id, or a deterministic one for tests. Minted here when absent. */
  forkId?: string | undefined
  /** Injectable per-run session uuids, in dispatch order: index 0 is the first arm's first run. */
  sessionUuids?: readonly string[]
  /** Passed through to the restore; see `RestoreWorkspaceOptions.install`. */
  install?: boolean
  /** Run the launcher. Off by default — see the module doc. */
  launch?: boolean
}

export interface DispatchedArm {
  arm: number
  /** 1-based run within the arm (prd53 ruling 1). */
  run: number
  laneHandle: string
  /** The lab-owned worktree this arm was restored into. */
  labWorktreePath: string
  /** Where the agent will actually run — the lab worktree unless a launcher moved it. */
  worktreePath: string
  session: SynthesizedSession
  /** A second session, synthesized under the launcher's worktree when it differs. */
  launcherSession: SynthesizedSession | null
  /** The launcher argv, whether or not it was run. Empty when nothing can be run. */
  launcherArgv: readonly string[]
  launched: boolean
  /**
   * Why no arm was started, when none was — prd-20 ruling 7's floor.
   * Absent, never `null`, when a launch was possible: "nothing refused" and
   * "the refusal was lost" must not look alike (the same rule the fork event's
   * optional keys are spread for).
   */
  headlessRefusal?: string
  event: EventOf<'fork.dispatched'>
}

export interface DispatchForkResult {
  forkId: string
  checkpointId: string
  parentLane: string
  /** Every run of every arm dispatched by this call, in dispatch order — `arms.length` is arms × runs. */
  arms: DispatchedArm[]
  /** Runs per arm, as dispatched. */
  runs: number
  /** The rhizomorph event log the `fork.dispatched` events were appended to. */
  recordedTo: string
}

/** prd12 ruling 4: three arms is the floor at which a comparison may say anything at all. */
export const DEFAULT_ARMS = 3

/**
 * Per-exec ceiling for the plumbing this module spawns directly — `workmux
 * path`, same value as `ROUTE_EXEC_TIMEOUT_MS` / `RETARGET_EXEC_TIMEOUT_MS`. A
 * hung read must not hang `dispatchFork` itself.
 *
 * NOT used for `workmux add` — see {@link FORK_LAUNCH_TIMEOUT_MS}, which
 * bounds that spawn alone, for why the two are different kinds of wait.
 */
export const FORK_EXEC_TIMEOUT_MS = 5000

/**
 * Per-exec ceiling for `workmux add` alone (#408). `workmux add` runs the
 * worktree's configured setup — `.workmux.yaml`'s `post_create` hook, `npm
 * ci` in this repo — unless given `-H`, and {@link workmuxAddArgv} does not
 * pass `-H`. That makes it a dependency install, not a plumbing read: walking
 * the prd-55 stack live, two launches from the panel both failed `exit null`
 * at arm 1 because `FORK_EXEC_TIMEOUT_MS` (5s) killed `workmux add` mid `npm
 * install` on a cold cache, while a hand-run `workmux add` in the same
 * environment finished in ~7s once the cache was warm — the "sometimes
 * enough" shape that reads as a flake rather than the ceiling defect it is
 * (`docs/design-notes/lab-launch-ceilings.md` left this open after PR #123's
 * review named the shape without a number).
 *
 * Same order of magnitude as `RESTORE_EXEC_TIMEOUT_MS` (120s, `restore.ts`),
 * which already bounds this repo's OTHER `npm install` for the identical
 * reason — a dependency install is a wider thing to wait on than a plumbing
 * read, and narrower than the ten-minute family that waits on a model or a
 * test suite (`RD_HAND_TIMEOUT_MS`, `COMPARE_VERIFY_TIMEOUT_MS`). The
 * hung-process protection `FORK_EXEC_TIMEOUT_MS` existed for is kept, only
 * resized to what this call actually runs: `withTimeout` still kills a
 * wedged `workmux add` and `dispatchFork` still returns and still reports
 * it — only the wall clock before that happens moved.
 */
export const FORK_LAUNCH_TIMEOUT_MS = 120_000

/**
 * THE LAUNCH CEILING, in spending lanes — arms × runs — that one dispatch may
 * create without the operator saying otherwise (prd53 ruling 6). Every run is
 * a restored worktree, an install, and with `--launch` a live agent; this
 * bounds machine LOAD, which is why it is configurable per dispatch where
 * prd-50's lock ceiling (a bound on WAITING) is fixed. The number is a
 * design-note decision: `docs/design-notes/lab-launch-ceiling-arms-runs.md`.
 *
 * Restated in `api/lab.ts` rather than imported — the namespace law
 * (`lab/namespace-law.test.ts`) forbids that file from reaching this one, the
 * same split `MODEL_GRAMMAR` lives with. Both copies are literal-pinned in
 * their own tests.
 */
export const LAUNCH_CEILING_LANES = 8

/**
 * THE MODEL GRAMMAR (#234's second defect), this side of the seam.
 *
 * {@link workmuxAddArgv} below is the one place in this repo that puts a
 * caller-supplied value into a *string* rather than an argv element — because
 * `workmux add -a` takes the agent's whole command line as one string and
 * runs it through a shell in a tmux pane. Everything else here uses argv
 * arrays, which is exactly why an audit of this repo's own spawn sites clears
 * the code: the injection lands one hop downstream, inside workmux.
 *
 * `api/lab.ts` refuses a bad `model` at the HTTP boundary. This copy exists
 * because `rhizomorph lab fork --model <x>` never passes through that file at
 * all — the CLI is the laboratory's original hand, and a grammar enforced only
 * on the route would leave the typed command wide open. Duplicated rather than
 * shared: `lab/namespace-law.test.ts` forbids `api/lab.ts` from importing
 * anything under `server/src/lab/`, so no module both sides may reach exists
 * today. Both copies are literal-pinned in their own tests, the mitigation
 * ADR-0012 already records for the capability header's identical split.
 *
 * Every real model string this repo dispatches passes — `sonnet` (the fleet
 * default in `.workmux.yaml` and `scripts/lane-agent.sh`), `opus`, `haiku`,
 * `claude-opus-5`, `claude-3-5-sonnet-20241022`, and a bedrock-style
 * `us.anthropic.claude-3-5-sonnet-20241022-v1:0`. No shell metacharacter
 * does, and neither does a space.
 */
export const MODEL_GRAMMAR = /^[A-Za-z0-9._:-]+$/

/** The first refused character, rendered legibly — a raw newline in a refusal is a refusal that explains nothing. */
function offendingModelCharacter(model: string): string | null {
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

/**
 * Refuses a `model` no shell may safely be handed, naming the character that
 * caused it. Called twice on the dispatch path, deliberately: once by
 * {@link dispatchFork} before any worktree exists, so a refused model costs
 * nothing and leaves nothing behind, and once by {@link workmuxAddArgv}
 * itself, so the argv builder cannot produce a poisoned command line even if
 * a future caller reaches it by some other road.
 */
export function assertModelIsShellSafe(model: string): void {
  const offender = offendingModelCharacter(model)
  if (offender === null) return
  throw new Error(
    `refusing to launch: model contains ${offender === ' ' ? 'a space' : `"${offender}"`}, and the model is ` +
      `interpolated into a command line workmux runs through a shell — a model may only use letters, digits, ` +
      `and . _ : - (received "${model}")`,
  )
}

/**
 * The workmux invocation, as a pure function so a test — and a reader — can
 * see the exact argv without a process being spawned. Shape per
 * `scripts/lane-agent.sh`'s own documented usage:
 * `workmux add <handle> -a "bash scripts/lane-agent.sh <model>"`, which is
 * what makes the arm's telemetry env inherit by construction rather than by a
 * pane-command prefix that never reaches the agent (the 2026-08-04 scar).
 *
 * `-b` (background) because n arms must not yank the operator's tmux focus n
 * times.
 *
 * Throws on a `model` outside {@link MODEL_GRAMMAR} rather than escaping or
 * quoting it — the argv this returns is the argv that gets executed, so the
 * refusal has to happen before the array exists at all, never as a filter
 * applied to it afterwards.
 */
export function workmuxAddArgv(laneHandle: string, treatment: ForkTreatmentInput): string[] {
  const argv = ['add', laneHandle, '-b']
  if (treatment.model !== undefined) {
    assertModelIsShellSafe(treatment.model)
    argv.push('-a', `bash scripts/lane-agent.sh ${treatment.model}`)
  }
  if (treatment.promptFile !== undefined) {
    argv.push('-P', treatment.promptFile)
  }
  return argv
}

/**
 * The handle a run of an arm runs under — the same spelling as its worktree
 * leaf (`paths.ts`'s {@link armLeaf}, which is where `-run-1` is elided and
 * why). Distinct from the parent lane by construction — the schema refuses
 * otherwise.
 */
/**
 * THE HEADLESS LAUNCH — prd-57 ruling 8's launch half.
 *
 * An arm runs the harness directly, in the lab's own worktree, with no
 * multiplexer anywhere in the path. `workmux add` is still offered (see
 * {@link workmuxAddArgv}) and is no longer how an arm starts.
 *
 * ## Why the argv is declared here and not read off the adapter
 *
 * `concierge/harness/claude.ts` has a `launchArgv`, and the laboratory cannot
 * reach it: `concierge/namespace-law.test.ts` grants exactly one importer
 * (`api/concierge.ts`) and `lab/namespace-law.test.ts` grants the laboratory
 * exactly one (`cli/index.ts`). Neither set gains a member for this — the
 * issue says `ALLOWED_IMPORTERS` gains nothing, and a laboratory that could
 * reach the concierge would be a second route into the fourth hand.
 *
 * It is not a second roster either, which is the rule that would otherwise bite
 * (prd-26 ruling 6, "never two rosters"). The argv below is not a copy of the
 * adapter's launch line: it is the HEADLESS one, which the adapter does not
 * have, and it is already captured **in this directory** — `lab/rd.ts` spawns
 * the operator's own `claude` non-interactively and records the verification in
 * its own doc (*"the exact argv, verified against `claude --version` 2.1.266,
 * 2026-09-10"*). The R&D hand and a fork arm want the same thing from the same
 * binary, so the shape is stated once, here, beside the other one that uses it.
 *
 * ## Declared, never guessed
 *
 * A dialect with no captured headless launch gets no entry, and its arm falls
 * back to the copyable command — prd-20 ruling 7's floor, which is what that
 * ruling exists to guarantee. Inventing an argv for a binary nobody has run
 * headless would spawn a process on the operator's machine on the strength of a
 * spelling, which is the failure `harness-roster.ts` refuses one field at a
 * time and ADR-0010 refuses in general.
 */
export interface HeadlessLaunch {
  /** The binary, resolved on PATH by the caller's own exec. */
  readonly command: string
  /** Everything but the prompt, which the caller appends after `--`. */
  readonly argv: readonly string[]
}

/**
 * Why a dialect cannot run an arm headless, when it cannot. Never "unsupported"
 * on its own — the shape every refusal in this repo takes.
 */
export interface HeadlessRefusal {
  readonly reason: string
}

export function headlessLaunchFor(dialect: string): HeadlessLaunch | HeadlessRefusal {
  if (dialect === 'claude') {
    // `-p` is the non-interactive mode; `--strict-mcp-config` keeps an arm from
    // inheriting servers the operator configured for their own work, which
    // would make two arms differ by something the treatment never named.
    return { command: 'claude', argv: ['-p', '--strict-mcp-config'] }
  }
  return {
    reason:
      `this repo records no captured headless launch for ${dialect} — an arm cannot be started for it without ` +
      'inventing an argv nobody has run, so the command is handed back to be run by hand instead',
  }
}

export function isHeadlessRefusal(launch: HeadlessLaunch | HeadlessRefusal): launch is HeadlessRefusal {
  return 'reason' in launch
}

export function armLaneHandle(forkId: string, arm: number, run = 1): string {
  return armLeaf(forkId, arm, run)
}

// --- finding the checkpoint ------------------------------------------------------

export interface FindCheckpointOptions {
  parentWorktreePath: string
  lane: string
  checkpointId?: string | undefined
  dataRoot?: string
}

/**
 * Reads the lane's recorded checkpoints back out of the event log. Read-only:
 * every session file in the lane's data dir is scanned and nothing is written.
 */
export async function findCheckpoint(
  options: FindCheckpointOptions,
): Promise<PayloadOf<'fork.checkpoint'>> {
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const sessionDir = sessionDirFor(options.parentWorktreePath, dataRoot)
  const sessions = await listSessions(sessionDir)

  const found: Array<{ ts: number; payload: PayloadOf<'fork.checkpoint'> }> = []
  for (const session of sessions) {
    const events = await readSessionEvents(path.join(sessionDir, session.fileName))
    for (const event of events) {
      if (event.type !== 'fork.checkpoint') continue
      if (event.payload.lane !== options.lane) continue
      found.push({ ts: event.ts, payload: event.payload })
    }
  }

  if (options.checkpointId !== undefined) {
    const match = found.find((entry) => entry.payload.checkpointId === options.checkpointId)
    if (!match) {
      throw new Error(
        `no checkpoint "${options.checkpointId}" recorded for lane "${options.lane}" in ${sessionDir} — ` +
          `${found.length} checkpoint(s) found for that lane`,
      )
    }
    return match.payload
  }

  // Latest by envelope ts, ties broken by scan order (which is oldest session first).
  let latest: { ts: number; payload: PayloadOf<'fork.checkpoint'> } | undefined
  for (const entry of found) {
    if (latest === undefined || entry.ts >= latest.ts) latest = entry
  }
  if (!latest) {
    throw new Error(
      `no fork.checkpoint recorded for lane "${options.lane}" in ${sessionDir} — ` +
        `capture one first with 'rhizomorph lab checkpoint ${options.lane}'`,
    )
  }
  return latest.payload
}

// --- dispatch --------------------------------------------------------------------

export async function dispatchFork(options: DispatchForkOptions): Promise<DispatchForkResult> {
  // Deliberately NOT wrapped here. `restoreCheckpoint` → `restoreWorkspace`
  // does its own `withTimeout(exec, RESTORE_EXEC_TIMEOUT_MS)` (120s, wide
  // enough for `npm install`) — `withTimeout` always overrides the
  // `timeoutMs` an outer wrap would try to set, so whichever wrap sits
  // CLOSER to the raw exec wins. Wrapping here first would fix every
  // restore call to `FORK_EXEC_TIMEOUT_MS` (5s) regardless of what
  // `restoreWorkspace` asks for — exactly the composition bug #109 found.
  // The raw exec is what reaches the restore so ITS OWN wrap is the one
  // that ends up governing — the same reason this module wraps TWICE below
  // rather than once, each wrap as close as it can get to the one call it
  // is meant to bound:
  // `launchExec` carries the wider launch ceiling. The 5s plumbing ceiling had
  // exactly one user in this path, `workmux path`, and prd-57 ruling 8 removed
  // it: nothing asks a launcher where it put the arm any more, because nothing
  // but the lab chooses. `FORK_EXEC_TIMEOUT_MS` is kept and still exported —
  // `restore.ts` and this module's own doc reason about it — but this function
  // no longer wraps anything in it.
  // because that spawn runs the worktree's configured setup (`npm ci`) and a
  // plumbing ceiling killed it mid-install (#408).
  const rawExec = options.exec ?? realExec
  const launchExec = withTimeout(rawExec, FORK_LAUNCH_TIMEOUT_MS)
  const now = options.now ?? Date.now
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const parentWorktreePath = path.resolve(options.parentWorktreePath)
  const forkId = options.forkId ?? `fork-${randomUUID()}`

  if (!Number.isInteger(options.arms) || options.arms < 1) {
    throw new Error(`invalid arm count: ${options.arms} (must be a positive integer)`)
  }
  const runs = options.runs ?? 1
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`invalid run count: ${options.runs} (must be a positive integer)`)
  }
  const firstArm = options.armNumber ?? 1
  if (!Number.isInteger(firstArm) || firstArm < 1) {
    throw new Error(`invalid arm number: ${options.armNumber} (must be a positive integer)`)
  }
  if (options.ceilingOverride !== undefined && (!Number.isInteger(options.ceilingOverride) || options.ceilingOverride < 1)) {
    throw new Error(`invalid ceiling override: ${options.ceilingOverride} (must be a positive integer)`)
  }

  // The ceiling, before anything is restored (prd53 ruling 6 — prd41 ruling
  // 4's "a ceiling that spends money is declared", read for what it bounds).
  // The refusal names the number AND the override, so the operator's next
  // command is in the message rather than in a doc.
  const ceiling = options.ceilingOverride ?? LAUNCH_CEILING_LANES
  const lanes = options.arms * runs
  if (lanes > ceiling) {
    throw new Error(
      `refusing to dispatch ${lanes} spending lane(s) (${options.arms} arm(s) × ${runs} run(s)): the launch ceiling is ${ceiling}` +
        `${options.ceilingOverride === undefined ? ' (the default)' : ' (your override)'} — pass --ceiling-override ${lanes} to authorise ` +
        'exactly this many; the override is recorded on every fork.dispatched it produces (prd53 ruling 6)',
    )
  }

  // Before the checkpoint is even looked up, so a refused model restores no
  // workspace, creates no worktree, and records no `fork.dispatched`.
  if (options.model !== undefined) assertModelIsShellSafe(options.model)

  const checkpoint = await findCheckpoint({
    parentWorktreePath,
    lane: options.parentLane,
    checkpointId: options.checkpointId,
    dataRoot,
  })

  const promptDigest = options.promptFile === undefined ? null : await digestFile(options.promptFile)
  const treatment = { model: options.model ?? null, promptDigest }

  const ts = now()
  const sessionDir = sessionDirFor(parentWorktreePath, dataRoot)
  const resumed = await findResumableSession(sessionDir, ts, RESUME_WINDOW_MS)
  const logFilePath = resumed?.filePath ?? path.join(sessionDir, sessionFileName(ts))
  const recorder = new SessionRecorder(resumed?.sessionId ?? String(ts), logFilePath, resumed ? { resumeFrom: resumed.events } : {})
  // Tagged `fork` (#429): the CLI verb this module is invoked as
  // (`rhizomorph lab fork`), the same word `fork.dispatched` already carries.
  const nextId = createIdFactory('lab', 0, 'fork')

  // Arm-major, run-minor: every run of arm k is restored before arm k+1
  // begins, so a partial dispatch leaves whole arms behind it, never half of
  // two. `armLeaf` gives each (arm, run) its own worktree and handle by
  // construction — no two runs can share either.
  const arms: DispatchedArm[] = []
  for (let index = 0; index < options.arms; index += 1) {
    const arm = firstArm + index
    for (let run = 1; run <= runs; run += 1) {
      arms.push(
        await dispatchArm({
          arm,
          run,
          ordinal: arms.length,
          forkId,
          checkpoint,
          treatment,
          parentWorktreePath,
          dataRoot,
          restoreExec: rawExec,
          launchExec,
          now,
          recorder,
          nextId,
          options,
        }),
      )
    }
  }

  return { forkId, checkpointId: checkpoint.checkpointId, parentLane: options.parentLane, arms, runs, recordedTo: logFilePath }
}

interface DispatchArmContext {
  arm: number
  run: number
  /** Position in dispatch order, 0-based — what indexes `sessionUuids`. */
  ordinal: number
  forkId: string
  checkpoint: CheckpointCoordinates
  treatment: { model: string | null; promptDigest: string | null }
  parentWorktreePath: string
  dataRoot: string
  /** Handed to `restoreCheckpoint` UNWRAPPED — its own `RESTORE_EXEC_TIMEOUT_MS` wrap is the one that must govern. */
  restoreExec: Exec
  /** `FORK_LAUNCH_TIMEOUT_MS`-bounded (120s) — for the `workmux add` spawn alone, which runs the worktree's configured setup (#408). */
  launchExec: Exec
  now: () => number
  recorder: SessionRecorder
  nextId: () => string
  options: DispatchForkOptions
}

async function dispatchArm(ctx: DispatchArmContext): Promise<DispatchedArm> {
  const { arm, run, forkId, options } = ctx
  const laneHandle = armLaneHandle(forkId, arm, run)
  const labWorktreePath = armWorktreePath(ctx.dataRoot, forkId, arm, run)
  const sessionUuid = options.sessionUuids?.[ctx.ordinal]

  const restored = await restoreCheckpoint({
    checkpoint: ctx.checkpoint,
    parentWorktreePath: ctx.parentWorktreePath,
    forkWorktreePath: labWorktreePath,
    dataRoot: ctx.dataRoot,
    exec: ctx.restoreExec,
    ...(options.claudeProjectsRoot === undefined ? {} : { claudeProjectsRoot: options.claudeProjectsRoot }),
    ...(sessionUuid === undefined ? {} : { sessionUuid }),
    ...(options.install === undefined ? {} : { install: options.install }),
  })

  const headless = headlessLaunchFor(options.dialect ?? 'claude')
  /**
   * THE ARM'S OWN COMMAND LINE — prd-57 ruling 8.
   *
   * It was `workmux add …`, which created a branch in the operator's own ref
   * namespace and a worktree of workmux's choosing. Ruling 1 confines every lab
   * write to `refs/rhizomorph/`, worktrees the lab creates itself, and
   * artifacts outside the watched repo — and this module's own header has
   * worried about exactly that contradiction since it was written. It is
   * resolved by not shelling to `workmux add` at all: `restoreCheckpoint` above
   * has already made the worktree, detached, with no ref outside the lab's
   * namespace, so there is nothing left for a launcher to create.
   */
  const launcherArgv = isHeadlessRefusal(headless)
    ? []
    : [headless.command, ...headless.argv, ...(options.promptFile === undefined ? [] : ['--', options.promptFile])]
  let launched = false
  const worktreePath = labWorktreePath
  const launcherSession: SynthesizedSession | null = null

  if (options.launch === true && !isHeadlessRefusal(headless)) {
    // `launchExec`, not `forkExec` (#408): a launch is not a plumbing read and
    // keeps the wider ceiling, even though nothing runs `npm ci` here any more.
    //
    // `cwd` is the LAB's worktree, not the parent's. That is the whole point of
    // the change: the arm runs in the tree the lab restored, so ruling 5's "the
    // session follows the agent" is satisfied by construction rather than by
    // asking a launcher afterwards where it put things.
    const result = await ctx.launchExec(headless.command, launcherArgv.slice(1), { cwd: labWorktreePath })
    if (result.failed) {
      const detail = result.stderr.trim() || result.errorMessage || `exit ${result.code}`
      throw new Error(`${launcherArgv.join(' ')} failed: ${detail}`)
    }
    launched = true
  }

  const event = createEvent(
    'fork.dispatched',
    {
      forkId,
      parentLane: options.parentLane,
      checkpointId: ctx.checkpoint.checkpointId,
      arm,
      run,
      ...(options.ceilingOverride === undefined ? {} : { ceilingOverride: options.ceilingOverride }),
      // prd55 ruling 4, spread rather than assigned for the same reason the
      // ceiling above is: an absent proposal must leave the key off the record
      // entirely, so "nobody proposed this" and "the proposal was lost" can
      // never look alike in the log.
      ...(options.proposalId === undefined ? {} : { proposalId: options.proposalId }),
      treatment: ctx.treatment,
      laneHandle,
      worktreePath,
    },
    { id: ctx.nextId(), ts: ctx.now() },
  )
  await ctx.recorder.record(event)

  return {
    arm,
    run,
    laneHandle,
    labWorktreePath,
    worktreePath,
    session: restored.session,
    launcherSession,
    launcherArgv,
    launched,
    // prd-20 ruling 7's floor, reached whenever the dialect declares no
    // captured headless launch: the arm is restored and ready, and the command
    // is handed back to be run by hand rather than guessed at.
    ...(isHeadlessRefusal(headless) ? { headlessRefusal: headless.reason } : {}),
    event,
  }
}


async function digestFile(filePath: string): Promise<string> {
  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch (err) {
    throw new Error(
      `cannot read prompt file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return createHash('sha256').update(bytes).digest('hex')
}
