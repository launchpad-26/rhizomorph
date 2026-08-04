import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Exec, PayloadOf } from '@rhizomorph/core'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { exec as realExec } from '../server/exec.js'
import { runGit } from './git.js'
import { assertInsideLabWorktrees } from './paths.js'

/**
 * prd12 phase 2's restore half — the inverse of `checkpoint.ts`. A checkpoint
 * bound three coordinates together (event-log index, session-file byte
 * offset, workspace snapshot sha); restoring turns two of them back into a
 * place an agent can actually be resumed in:
 *
 * 1. **Workspace** — `git worktree add --detach <lab worktree> <snapshotSha>`
 *    under the lab's own namespace (`paths.ts`, ruling 1), then `npm install`.
 *    The snapshot commit already contains the parent's dirt (tracked-modified,
 *    staged and untracked alike), so the restored tree arrives clean with the
 *    parent's uncommitted work present — the whole point of the temp-index
 *    recipe.
 * 2. **Session** — the parent's Claude Code session JSONL, cut at
 *    `sessionCutByte`, digest-verified, **with every absolute path into the
 *    parent worktree rewritten to the fork worktree** (ruling 5), written into
 *    the FORK worktree's project slug under a fresh uuid. That last part is
 *    what makes the existing sessionlog collector discover the arm with zero
 *    new code: it maps cwd → slug, and the fork's cwd is its own worktree.
 *
 * Ruling 5 calls the path rewrite "the one corruption this design must make
 * impossible": a synthesized session that still names the parent's tree is an
 * agent that will edit its parent's files while believing they are its own.
 * Two defences here — the rewrite itself, and a flat refusal to write into the
 * parent's own project slug (`synthesizeSession` throws when the fork and
 * parent worktree paths coincide).
 *
 * Nothing in this module writes inside the watched repo, and nothing here
 * runs without an explicit `rhizomorph lab` invocation.
 */

/** The coordinates a restore needs — a `fork.checkpoint` payload, narrowed. */
export type CheckpointCoordinates = Pick<
  PayloadOf<'fork.checkpoint'>,
  'checkpointId' | 'sessionFile' | 'sessionCutByte' | 'sessionDigest' | 'snapshotSha'
>

// --- session digest -----------------------------------------------------------

export interface VerifiedSessionPrefix {
  /** Exactly `sessionCutByte` bytes off the head of the parent's session file. */
  bytes: Buffer
  digest: string
}

/**
 * Reads the checkpoint's prefix of the parent session file and proves it is
 * the same prefix the checkpoint digested. Refuses loudly on any of the three
 * ways this can be wrong — file gone, file truncated below the cut, contents
 * changed under us — because every one of them means the fork would resume
 * from a conversation that is not the one the operator asked for.
 */
export async function verifySessionPrefix(
  checkpoint: CheckpointCoordinates,
): Promise<VerifiedSessionPrefix> {
  let whole: Buffer
  try {
    whole = await readFile(checkpoint.sessionFile)
  } catch (err) {
    throw new Error(
      `refusing to restore checkpoint ${checkpoint.checkpointId}: cannot read its session file ` +
        `${checkpoint.sessionFile} (${err instanceof Error ? err.message : String(err)})`,
    )
  }

  if (whole.length < checkpoint.sessionCutByte) {
    throw new Error(
      `refusing to restore checkpoint ${checkpoint.checkpointId}: ${checkpoint.sessionFile} is ` +
        `${whole.length} bytes but the checkpoint cuts at ${checkpoint.sessionCutByte} — ` +
        'the session file has been truncated or replaced since capture',
    )
  }

  const bytes = whole.subarray(0, checkpoint.sessionCutByte)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== checkpoint.sessionDigest) {
    throw new Error(
      `refusing to restore checkpoint ${checkpoint.checkpointId}: session digest mismatch for ` +
        `${checkpoint.sessionFile} — expected ${checkpoint.sessionDigest}, read ${digest}. ` +
        'The first ' +
        `${checkpoint.sessionCutByte} bytes are not the ones this checkpoint was taken over, so the ` +
        'fork would resume a different conversation.',
    )
  }

  return { bytes, digest }
}

// --- path rewriting (ruling 5) -------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A path occurrence ends where a path can no longer continue. Without this
 * lookahead a parent of `/tmp/x/repo` would also rewrite the unrelated
 * `/tmp/x/repo-other`, silently pointing the fork at a tree nobody named. `/`
 * continues the same path and so is included; every other terminator here is
 * a character that cannot appear mid-segment in the JSONL a session file is.
 */
const PATH_BOUNDARY = '(?=/|["\\\\\\s,)\\]};:\'`]|$)'

export interface PathRewrite {
  from: string
  to: string
  /** How many occurrences were replaced. Zero is a fact worth reporting, not an error. */
  count: number
}

/**
 * Rewrites every absolute reference to `from` into `to`, as raw text rather
 * than by re-serialising the JSON.
 *
 * Textual on purpose: a Claude Code session line is a large object whose exact
 * bytes the CLI wrote, and round-tripping it through `JSON.parse`/`stringify`
 * would silently renormalise numbers, unicode escapes and anything else it
 * does not model. A path substitution needs to change the paths and nothing
 * else, so it changes the paths and nothing else. The JSON-escaped spelling of
 * each path is substituted too, for the platforms whose separators JSON has to
 * escape.
 */
export function rewriteWorktreePaths(text: string, from: string, to: string): { text: string; rewrites: PathRewrite[] } {
  const spellings: Array<[string, string]> = [[from, to]]
  const escapedFrom = JSON.stringify(from).slice(1, -1)
  const escapedTo = JSON.stringify(to).slice(1, -1)
  if (escapedFrom !== from) spellings.push([escapedFrom, escapedTo])

  let out = text
  const rewrites: PathRewrite[] = []
  for (const [needle, replacement] of spellings) {
    const pattern = new RegExp(escapeRegExp(needle) + PATH_BOUNDARY, 'g')
    let count = 0
    out = out.replace(pattern, () => {
      count += 1
      return replacement
    })
    rewrites.push({ from: needle, to: replacement, count })
  }

  return { text: out, rewrites }
}

// --- session synthesis ---------------------------------------------------------

export interface SynthesizeSessionOptions {
  checkpoint: CheckpointCoordinates
  /** The worktree the parent lane ran in — the paths being rewritten AWAY from. */
  parentWorktreePath: string
  /** The worktree the arm will run in — the paths being rewritten TO. */
  forkWorktreePath: string
  /** Overrides `~/.claude/projects`; tests point this at a fixture dir. */
  claudeProjectsRoot?: string
  /** Injectable session uuid, for deterministic tests. Defaults to a real uuid. */
  sessionUuid?: string
}

export interface SynthesizedSession {
  /** The new session's uuid — its filename, and what `--resume` would be given. */
  sessionId: string
  /** Absolute path of the synthesized JSONL, under the FORK worktree's project slug. */
  filePath: string
  /** The parent session file it was cut from. */
  parentSessionFile: string
  linesCopied: number
  bytes: number
  /** Occurrences replaced, per spelling of the parent path. */
  rewrites: PathRewrite[]
  /**
   * True when `sessionCutByte` fell mid-line and the fragment was dropped. The
   * digest still covers the full cut; only the written file stops at the last
   * complete line, because half a JSON object is not a session.
   */
  droppedPartialLine: boolean
}

/**
 * Writes the fork's own session: the parent's conversation up to the
 * checkpoint, pointed at the fork's worktree instead of the parent's.
 */
export async function synthesizeSession(options: SynthesizeSessionOptions): Promise<SynthesizedSession> {
  const parentWorktreePath = path.resolve(options.parentWorktreePath)
  const forkWorktreePath = path.resolve(options.forkWorktreePath)

  // Ruling 5's hard edge. If these coincide, the "synthesized" session would
  // land in the parent's own project directory and the rewrite would be a
  // no-op — the exact corruption the ruling names, arrived at by accident.
  if (forkWorktreePath === parentWorktreePath) {
    throw new Error(
      `refusing to synthesize a session for ${forkWorktreePath}: it is the parent worktree itself ` +
        "(prd12 ruling 5 — a fork's session may never be written into its parent's project slug)",
    )
  }

  const { bytes } = await verifySessionPrefix(options.checkpoint)

  const raw = bytes.toString('utf8')
  const lastNewline = raw.lastIndexOf('\n')
  const droppedPartialLine = lastNewline !== raw.length - 1
  const complete = lastNewline === -1 ? '' : raw.slice(0, lastNewline + 1)

  const { text: rewritten, rewrites } = rewriteWorktreePaths(complete, parentWorktreePath, forkWorktreePath)

  // The fork's own session id, and the file's own name. Claude Code names a
  // session file after the uuid inside it, so the copy's internal id is
  // rewritten to match: a file whose contents claim to be the parent's
  // session is a file two lanes both believe they own.
  const sessionId = options.sessionUuid ?? randomUUID()
  const parentSessionId = path.basename(options.checkpoint.sessionFile, '.jsonl')
  const body =
    parentSessionId.length > 0 && parentSessionId !== sessionId
      ? rewritten.split(parentSessionId).join(sessionId)
      : rewritten

  const projectsRoot = options.claudeProjectsRoot ?? path.join(homedir(), '.claude', 'projects')
  const projectDir = path.join(projectsRoot, worktreePathToProjectSlug(forkWorktreePath))
  const filePath = path.join(projectDir, `${sessionId}.jsonl`)

  await mkdir(projectDir, { recursive: true })
  if (await exists(filePath)) {
    throw new Error(`refusing to overwrite an existing session file: ${filePath}`)
  }
  await writeFile(filePath, body, 'utf8')

  return {
    sessionId,
    filePath,
    parentSessionFile: options.checkpoint.sessionFile,
    linesCopied: body.length === 0 ? 0 : body.split('\n').length - 1,
    bytes: Buffer.byteLength(body, 'utf8'),
    rewrites,
    droppedPartialLine,
  }
}

// --- workspace restore ----------------------------------------------------------

export interface RestoreWorkspaceOptions {
  /** A worktree of the repo the snapshot object lives in — git is run from here. */
  parentWorktreePath: string
  snapshotSha: string
  /** Target path. MUST be under `<dataRoot>/lab/worktrees` — asserted, not assumed. */
  forkWorktreePath: string
  /** The lab's data root, which defines the namespace the target is checked against. */
  dataRoot: string
  exec?: Exec
  /**
   * Run `npm install` in the restored tree. Default true — the spike's ~6s is
   * part of the recipe, because an arm that cannot run its own gate command is
   * not a restored reality. Set false only where a test has no dependencies to
   * install and is asserting something else.
   */
  install?: boolean
}

export interface RestoredWorkspace {
  worktreePath: string
  snapshotSha: string
  /** False when the tree has no package.json — nothing to install, said out loud rather than implied. */
  installed: boolean
}

export async function restoreWorkspace(options: RestoreWorkspaceOptions): Promise<RestoredWorkspace> {
  const exec = options.exec ?? realExec
  const parentWorktreePath = path.resolve(options.parentWorktreePath)
  const forkWorktreePath = path.resolve(options.forkWorktreePath)

  assertInsideLabWorktrees(options.dataRoot, forkWorktreePath)

  await mkdir(path.dirname(forkWorktreePath), { recursive: true })
  // `--detach`: the arm has no branch of its own, so the lab never creates a
  // ref outside `refs/rhizomorph/` and can never move one the operator owns.
  await runGit(exec, parentWorktreePath, [
    'worktree',
    'add',
    '--detach',
    forkWorktreePath,
    options.snapshotSha,
  ])

  const wantsInstall = options.install ?? true
  const hasManifest = await exists(path.join(forkWorktreePath, 'package.json'))
  if (wantsInstall && hasManifest) {
    const result = await exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: forkWorktreePath })
    if (result.failed) {
      const detail = result.stderr.trim() || result.errorMessage || `exit ${result.code}`
      throw new Error(`npm install failed in ${forkWorktreePath}: ${detail}`)
    }
  }

  return { worktreePath: forkWorktreePath, snapshotSha: options.snapshotSha, installed: wantsInstall && hasManifest }
}

// --- the whole restore ------------------------------------------------------------

export interface RestoreCheckpointOptions extends SynthesizeSessionOptions {
  dataRoot: string
  exec?: Exec
  install?: boolean
}

export interface RestoredCheckpoint {
  workspace: RestoredWorkspace
  session: SynthesizedSession
}

/**
 * Both halves, in the only safe order: the digest is proven BEFORE a worktree
 * is created, so a mismatched checkpoint leaves nothing behind to clean up.
 */
export async function restoreCheckpoint(options: RestoreCheckpointOptions): Promise<RestoredCheckpoint> {
  await verifySessionPrefix(options.checkpoint)

  const workspace = await restoreWorkspace({
    parentWorktreePath: options.parentWorktreePath,
    snapshotSha: options.checkpoint.snapshotSha,
    forkWorktreePath: options.forkWorktreePath,
    dataRoot: options.dataRoot,
    ...(options.exec === undefined ? {} : { exec: options.exec }),
    ...(options.install === undefined ? {} : { install: options.install }),
  })

  const session = await synthesizeSession(options)

  return { workspace, session }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}
