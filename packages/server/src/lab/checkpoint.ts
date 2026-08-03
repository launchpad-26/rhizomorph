import { createHash, randomUUID } from 'node:crypto'
import { copyFile, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type { EventOf, Exec } from '@rhizomorph/core'
import { createEvent, createIdFactory } from '@rhizomorph/core'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { defaultDataRoot, sessionDirFor, sessionFileName } from '../log/paths.js'
import { findResumableSession, RESUME_WINDOW_MS } from '../log/session-log.js'
import { exec as realExec } from '../server/exec.js'
import { SessionRecorder } from '../server/recorder.js'

/**
 * prd12 ruling 2's capture module — the laboratory's own hand. Everything
 * here is either a read (git status, the session file) or a write confined
 * to the amended namespaces (ruling 1): a git ref under
 * `refs/rhizomorph/checkpoints/`, the loose objects that ref requires, and
 * the rhizomorph event log itself (already outside the watched repo — same
 * data-directory posture as every collector). Nothing here ever runs `push`,
 * `merge`, or `checkout`, and nothing writes inside the working tree — see
 * `namespace-law.test.ts` and `checkpoint.test.ts`'s before/after `git
 * status` assertion.
 */

export type CapturedBy = 'dispatch' | 'gate' | 'operator'

export interface CaptureCheckpointOptions {
  lane: string
  /** The worktree to snapshot. Resolved to an absolute path. */
  worktreePath: string
  capturedBy: CapturedBy
  exec?: Exec
  now?: () => number
  /** Overrides `~/.local/share/rhizomorph` — tests point this at a temp dir. */
  dataRoot?: string
  /** Overrides `~/.claude/projects` — tests point this at a fixture dir. */
  claudeProjectsRoot?: string
  /** Injectable checkpoint id, for deterministic tests. Defaults to a real uuid. */
  checkpointId?: string
}

export interface CaptureCheckpointResult {
  event: EventOf<'fork.checkpoint'>
  /** The rhizomorph event log this checkpoint was appended to. */
  recordedTo: string
}

/**
 * Captures a live checkpoint: a git workspace snapshot (temp-index recipe,
 * working tree untouched) bound to the current byte offset of the lane's
 * Claude Code session file, emitted as a `fork.checkpoint` event through the
 * existing recorder path. Never synthesized after the fact — this function
 * only ever describes a capture that just ran.
 */
export async function captureCheckpoint(options: CaptureCheckpointOptions): Promise<CaptureCheckpointResult> {
  const exec = options.exec ?? realExec
  const now = options.now ?? Date.now
  const worktreePath = path.resolve(options.worktreePath)
  const checkpointId = options.checkpointId ?? randomUUID()
  const ts = now()

  const workspace = await snapshotWorkspace(exec, worktreePath, checkpointId)
  const session = await cutSession(worktreePath, options.claudeProjectsRoot)

  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const sessionDir = sessionDirFor(worktreePath, dataRoot)
  const resumed = await findResumableSession(sessionDir, ts, RESUME_WINDOW_MS)
  const sessionId = resumed?.sessionId ?? String(ts)
  const logFilePath = resumed?.filePath ?? path.join(sessionDir, sessionFileName(ts))
  const eventIndex = resumed?.events.length ?? 0

  const recorder = new SessionRecorder(sessionId, logFilePath, resumed ? { resumeFrom: resumed.events } : {})
  const nextId = createIdFactory('lab')
  const event = createEvent(
    'fork.checkpoint',
    {
      lane: options.lane,
      checkpointId,
      eventIndex,
      sessionFile: session.sessionFile,
      sessionCutByte: session.sessionCutByte,
      sessionDigest: session.sessionDigest,
      snapshotRef: workspace.snapshotRef,
      snapshotSha: workspace.snapshotSha,
      headSha: workspace.headSha,
      capturedBy: options.capturedBy,
    },
    { id: nextId(), ts },
  )

  await recorder.record(event)

  return { event, recordedTo: logFilePath }
}

interface WorkspaceSnapshot {
  snapshotRef: string
  snapshotSha: string
  headSha: string
}

/**
 * The spike's proven recipe, 0.037s-class: copy the real index to a tempfile,
 * then under `GIT_INDEX_FILE=<copy>`, `add -A` → `write-tree` →
 * `commit-tree -p HEAD` → `update-ref refs/rhizomorph/checkpoints/<id>`. The
 * real index is never opened for writing, so the working tree — tracked,
 * staged and untracked alike — is byte-for-byte what it was before.
 */
async function snapshotWorkspace(
  exec: Exec,
  worktreePath: string,
  checkpointId: string,
): Promise<WorkspaceSnapshot> {
  const gitDir = (await runGit(exec, worktreePath, ['rev-parse', '--absolute-git-dir'])).trim()
  const headSha = (await runGit(exec, worktreePath, ['rev-parse', 'HEAD'])).trim()

  const realIndexPath = path.join(gitDir, 'index')
  const tmpIndexPath = path.join(tmpdir(), `rhizomorph-checkpoint-${checkpointId}-index`)
  await copyFile(realIndexPath, tmpIndexPath)

  try {
    // Explicit author/committer identity: a checkpoint must succeed on a
    // stranger's machine even when `user.name`/`user.email` are unset.
    const env = {
      GIT_INDEX_FILE: tmpIndexPath,
      GIT_AUTHOR_NAME: 'rhizomorph-lab',
      GIT_AUTHOR_EMAIL: 'lab@rhizomorph.local',
      GIT_COMMITTER_NAME: 'rhizomorph-lab',
      GIT_COMMITTER_EMAIL: 'lab@rhizomorph.local',
    }
    await runGit(exec, worktreePath, ['add', '-A'], env)
    const treeSha = (await runGit(exec, worktreePath, ['write-tree'], env)).trim()
    const snapshotSha = (
      await runGit(
        exec,
        worktreePath,
        ['commit-tree', treeSha, '-p', headSha, '-m', `rhizomorph checkpoint ${checkpointId}`],
        env,
      )
    ).trim()

    const snapshotRef = `refs/rhizomorph/checkpoints/${checkpointId}`
    await runGit(exec, worktreePath, ['update-ref', snapshotRef, snapshotSha])

    return { snapshotRef, snapshotSha, headSha }
  } finally {
    await rm(tmpIndexPath, { force: true })
  }
}

async function runGit(
  exec: Exec,
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await exec('git', args, { cwd, env })
  if (result.failed) {
    const detail = result.stderr.trim() || result.errorMessage || `exit ${result.code}`
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
  return result.stdout
}

interface SessionCut {
  sessionFile: string
  sessionCutByte: number
  sessionDigest: string
}

/**
 * The session cut: the lane's Claude Code session file, located the same way
 * the sessionlog collector does (`worktreePathToProjectSlug`), cut at its
 * current end — the byte offset a fork of this checkpoint would resume from
 * — and digested so a later fork can prove it read the same prefix.
 */
async function cutSession(worktreePath: string, claudeProjectsRoot?: string): Promise<SessionCut> {
  const projectsRoot = claudeProjectsRoot ?? path.join(homedir(), '.claude', 'projects')
  const projectDir = path.join(projectsRoot, worktreePathToProjectSlug(worktreePath))

  const sessionFile = await findActiveSessionFile(projectDir)
  const buffer = await readFile(sessionFile)
  const sessionCutByte = buffer.length
  const sessionDigest = createHash('sha256').update(buffer.subarray(0, sessionCutByte)).digest('hex')

  return { sessionFile, sessionCutByte, sessionDigest }
}

/** The most recently modified `*.jsonl` in a Claude Code project dir — the lane's active session. */
async function findActiveSessionFile(projectDir: string): Promise<string> {
  let entries: string[]
  try {
    entries = await readdir(projectDir)
  } catch {
    throw new Error(
      `no Claude Code session directory found at ${projectDir} — is this lane's session running?`,
    )
  }

  const jsonlNames = entries.filter((name) => name.endsWith('.jsonl'))
  if (jsonlNames.length === 0) {
    throw new Error(`no session .jsonl files found under ${projectDir}`)
  }

  const withMtime = await Promise.all(
    jsonlNames.map(async (name) => {
      const filePath = path.join(projectDir, name)
      const info = await stat(filePath)
      return { filePath, mtimeMs: info.mtimeMs }
    }),
  )
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const newest = withMtime[0]
  if (!newest) throw new Error(`no session .jsonl files found under ${projectDir}`)
  return newest.filePath
}
