import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { EventOf, Exec, PayloadOf } from '@rhizomorph/core'
import { createEvent, createIdFactory } from '@rhizomorph/core'
import { defaultDataRoot, sessionDirFor, sessionFileName } from '../log/paths.js'
import { findResumableSession, listSessions, readSessionEvents, RESUME_WINDOW_MS } from '../log/session-log.js'
import { exec as realExec } from '../server/exec.js'
import { SessionRecorder } from '../server/recorder.js'
import { armWorktreePath } from './paths.js'
import {
  restoreCheckpoint,
  synthesizeSession,
  type CheckpointCoordinates,
  type SynthesizedSession,
} from './restore.js'

/**
 * prd12 phase 2's dispatch half: n arms of one checkpoint, each a restored
 * reality of its own, each marked synthetic by the `fork.dispatched` event
 * this module emits.
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
  exec?: Exec
  now?: () => number
  dataRoot?: string
  claudeProjectsRoot?: string
  /** Injectable fork id, for deterministic tests. */
  forkId?: string
  /** Injectable per-arm session uuids, index 0 = arm 1. */
  sessionUuids?: readonly string[]
  /** Passed through to the restore; see `RestoreWorkspaceOptions.install`. */
  install?: boolean
  /** Run the launcher. Off by default — see the module doc. */
  launch?: boolean
}

export interface DispatchedArm {
  arm: number
  laneHandle: string
  /** The lab-owned worktree this arm was restored into. */
  labWorktreePath: string
  /** Where the agent will actually run — the lab worktree unless a launcher moved it. */
  worktreePath: string
  session: SynthesizedSession
  /** A second session, synthesized under the launcher's worktree when it differs. */
  launcherSession: SynthesizedSession | null
  /** The launcher argv, whether or not it was run. */
  launcherArgv: readonly string[]
  launched: boolean
  event: EventOf<'fork.dispatched'>
}

export interface DispatchForkResult {
  forkId: string
  checkpointId: string
  parentLane: string
  arms: DispatchedArm[]
  /** The rhizomorph event log the `fork.dispatched` events were appended to. */
  recordedTo: string
}

/** prd12 ruling 4: three arms is the floor at which a comparison may say anything at all. */
export const DEFAULT_ARMS = 3

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
 */
export function workmuxAddArgv(laneHandle: string, treatment: ForkTreatmentInput): string[] {
  const argv = ['add', laneHandle, '-b']
  if (treatment.model !== undefined) {
    argv.push('-a', `bash scripts/lane-agent.sh ${treatment.model}`)
  }
  if (treatment.promptFile !== undefined) {
    argv.push('-P', treatment.promptFile)
  }
  return argv
}

/** The handle an arm runs under. Distinct from the parent lane by construction — the schema refuses otherwise. */
export function armLaneHandle(forkId: string, arm: number): string {
  return `${forkId}-arm-${arm}`
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
  const exec = options.exec ?? realExec
  const now = options.now ?? Date.now
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const parentWorktreePath = path.resolve(options.parentWorktreePath)
  const forkId = options.forkId ?? `fork-${randomUUID()}`

  if (!Number.isInteger(options.arms) || options.arms < 1) {
    throw new Error(`invalid arm count: ${options.arms} (must be a positive integer)`)
  }

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
  const nextId = createIdFactory('lab')

  const arms: DispatchedArm[] = []
  for (let arm = 1; arm <= options.arms; arm += 1) {
    arms.push(
      await dispatchArm({
        arm,
        forkId,
        checkpoint,
        treatment,
        parentWorktreePath,
        dataRoot,
        exec,
        now,
        recorder,
        nextId,
        options,
      }),
    )
  }

  return { forkId, checkpointId: checkpoint.checkpointId, parentLane: options.parentLane, arms, recordedTo: logFilePath }
}

interface DispatchArmContext {
  arm: number
  forkId: string
  checkpoint: CheckpointCoordinates
  treatment: { model: string | null; promptDigest: string | null }
  parentWorktreePath: string
  dataRoot: string
  exec: Exec
  now: () => number
  recorder: SessionRecorder
  nextId: () => string
  options: DispatchForkOptions
}

async function dispatchArm(ctx: DispatchArmContext): Promise<DispatchedArm> {
  const { arm, forkId, options } = ctx
  const laneHandle = armLaneHandle(forkId, arm)
  const labWorktreePath = armWorktreePath(ctx.dataRoot, forkId, arm)
  const sessionUuid = options.sessionUuids?.[arm - 1]

  const restored = await restoreCheckpoint({
    checkpoint: ctx.checkpoint,
    parentWorktreePath: ctx.parentWorktreePath,
    forkWorktreePath: labWorktreePath,
    dataRoot: ctx.dataRoot,
    exec: ctx.exec,
    ...(options.claudeProjectsRoot === undefined ? {} : { claudeProjectsRoot: options.claudeProjectsRoot }),
    ...(sessionUuid === undefined ? {} : { sessionUuid }),
    ...(options.install === undefined ? {} : { install: options.install }),
  })

  const launcherArgv = workmuxAddArgv(laneHandle, { model: options.model, promptFile: options.promptFile })
  let launched = false
  let worktreePath = labWorktreePath
  let launcherSession: SynthesizedSession | null = null

  if (options.launch === true) {
    const result = await ctx.exec('workmux', launcherArgv, { cwd: ctx.parentWorktreePath })
    if (result.failed) {
      const detail = result.stderr.trim() || result.errorMessage || `exit ${result.code}`
      throw new Error(`workmux ${launcherArgv.join(' ')} failed: ${detail}`)
    }
    launched = true

    // Whichever tree workmux put the agent in is the tree its session must
    // name. Ruling 5 is about the agent's cwd, not about ours.
    const reported = await workmuxWorktreePath(ctx.exec, ctx.parentWorktreePath, laneHandle)
    if (reported !== null && reported !== labWorktreePath) {
      worktreePath = reported
      // Session only, no workspace restore: workmux already made that tree,
      // and it is not the lab's to create (`restoreWorkspace` would refuse it,
      // correctly). What the lab still owes that tree is a session whose paths
      // name IT — ruling 5 follows the agent.
      launcherSession = await synthesizeSession({
        checkpoint: ctx.checkpoint,
        parentWorktreePath: ctx.parentWorktreePath,
        forkWorktreePath: reported,
        ...(options.claudeProjectsRoot === undefined ? {} : { claudeProjectsRoot: options.claudeProjectsRoot }),
      })
    }
  }

  const event = createEvent(
    'fork.dispatched',
    {
      forkId,
      parentLane: options.parentLane,
      checkpointId: ctx.checkpoint.checkpointId,
      arm,
      treatment: ctx.treatment,
      laneHandle,
      worktreePath,
    },
    { id: ctx.nextId(), ts: ctx.now() },
  )
  await ctx.recorder.record(event)

  return {
    arm,
    laneHandle,
    labWorktreePath,
    worktreePath,
    session: restored.session,
    launcherSession,
    launcherArgv: ['workmux', ...launcherArgv],
    launched,
    event,
  }
}

/** `workmux path <handle>`, or null when workmux cannot say — never a guess. */
async function workmuxWorktreePath(exec: Exec, cwd: string, laneHandle: string): Promise<string | null> {
  const result = await exec('workmux', ['path', laneHandle], { cwd })
  if (result.failed) return null
  const reported = result.stdout.trim()
  return reported.length > 0 ? path.resolve(reported) : null
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
