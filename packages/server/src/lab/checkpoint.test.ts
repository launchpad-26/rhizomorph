import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rhizomorphEventSchema } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSessionEvents } from '../log/session-log.js'
import { exec as realExec } from '../server/exec.js'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { captureCheckpoint } from './checkpoint.js'

let repoDir: string
let dataRoot: string
let claudeProjectsRoot: string
let sessionFilePath: string

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/**
 * A literal id here would be a machine-wide collision under concurrent test
 * runs (checkpoint.ts's own temp index path no longer derives from it, but a
 * fixed id in a test is still a smell worth not reintroducing) — pid + a
 * fresh uuid per call.
 */
function uniqueCheckpointId(label: string): string {
  return `ckpt-${label}-${process.pid}-${randomUUID()}`
}

function status(): string {
  return git(['status', '--porcelain'])
}

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-checkpoint-test-'))
  repoDir = path.join(root, 'repo')
  dataRoot = path.join(root, 'data')
  claudeProjectsRoot = path.join(root, 'claude-projects')

  await mkdir(repoDir, { recursive: true })
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])

  await writeFile(path.join(repoDir, 'tracked.txt'), 'v1\n')
  git(['add', 'tracked.txt'])
  git(['commit', '-m', 'initial commit'])

  // Dirty in three ways the spike's recipe must all capture in one commit.
  await writeFile(path.join(repoDir, 'tracked.txt'), 'v2 modified\n') // unstaged modification
  await writeFile(path.join(repoDir, 'staged.txt'), 'staged content\n')
  git(['add', 'staged.txt']) // staged addition
  await writeFile(path.join(repoDir, 'untracked.txt'), 'untracked content\n') // untracked

  const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir))
  await mkdir(projectDir, { recursive: true })
  sessionFilePath = path.join(projectDir, 'session-fixture.jsonl')
  await writeFile(sessionFilePath, '{"line":1}\n{"line":2}\n')
})

afterEach(async () => {
  await rm(path.dirname(repoDir), { recursive: true, force: true })
})

describe('captureCheckpoint', () => {
  it('leaves the working tree exactly as it found it', async () => {
    const before = status()

    await captureCheckpoint({
      lane: '148-lab-checkpoint',
      worktreePath: repoDir,
      capturedBy: 'operator',
      exec: realExec,
      dataRoot,
      claudeProjectsRoot,
      now: () => 1_000_000,
    })

    const after = status()
    expect(after).toBe(before)
  })

  it('captures tracked-modified, staged AND untracked in one commit, reachable via the ref, HEAD unmoved', async () => {
    const headBefore = git(['rev-parse', 'HEAD']).trim()
    const checkpointId = uniqueCheckpointId('one-commit')

    const { event } = await captureCheckpoint({
      lane: '148-lab-checkpoint',
      worktreePath: repoDir,
      capturedBy: 'operator',
      exec: realExec,
      dataRoot,
      claudeProjectsRoot,
      now: () => 1_000_000,
      checkpointId,
    })

    expect(event.payload.snapshotRef).toBe(`refs/rhizomorph/checkpoints/${checkpointId}`)
    expect(event.payload.headSha).toBe(headBefore)
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore) // HEAD never moved

    const refSha = git(['rev-parse', event.payload.snapshotRef]).trim()
    expect(refSha).toBe(event.payload.snapshotSha)

    const files = git(['ls-tree', '-r', '--name-only', event.payload.snapshotSha]).trim().split('\n').sort()
    expect(files).toEqual(['staged.txt', 'tracked.txt', 'untracked.txt'])

    const modified = git(['show', `${event.payload.snapshotSha}:tracked.txt`])
    expect(modified).toBe('v2 modified\n')
  })

  it('restores cleanly into a detached worktree with all three kinds of dirt present', async () => {
    const { event } = await captureCheckpoint({
      lane: '148-lab-checkpoint',
      worktreePath: repoDir,
      capturedBy: 'operator',
      exec: realExec,
      dataRoot,
      claudeProjectsRoot,
      now: () => 1_000_000,
    })

    const restorePath = path.join(path.dirname(repoDir), 'restored')
    git(['worktree', 'add', '--detach', restorePath, event.payload.snapshotSha])
    try {
      const restoredStatus = execFileSync('git', ['status', '--porcelain'], {
        cwd: restorePath,
        encoding: 'utf8',
      })
      expect(restoredStatus).toBe('') // arrives clean — the dirt is committed, honestly, into the snapshot
      const trackedContent = await readFile(path.join(restorePath, 'tracked.txt'), 'utf8')
      expect(trackedContent).toBe('v2 modified\n')
      const untrackedContent = await readFile(path.join(restorePath, 'untracked.txt'), 'utf8')
      expect(untrackedContent).toBe('untracked content\n')
    } finally {
      git(['worktree', 'remove', '--force', restorePath])
    }
  })

  it('records the session cut — byte offset at EOF and its sha256 digest', async () => {
    const fileBytes = await readFile(sessionFilePath)
    const expectedDigest = createHash('sha256').update(fileBytes).digest('hex')

    const { event } = await captureCheckpoint({
      lane: '148-lab-checkpoint',
      worktreePath: repoDir,
      capturedBy: 'operator',
      exec: realExec,
      dataRoot,
      claudeProjectsRoot,
      now: () => 1_000_000,
    })

    expect(event.payload.sessionFile).toBe(sessionFilePath)
    expect(event.payload.sessionCutByte).toBe(fileBytes.length)
    expect(event.payload.sessionDigest).toBe(expectedDigest)
  })

  it('throws when no session file exists for the lane', async () => {
    await rm(sessionFilePath)
    await expect(
      captureCheckpoint({
        lane: '148-lab-checkpoint',
        worktreePath: repoDir,
        capturedBy: 'operator',
        exec: realExec,
        dataRoot,
        claudeProjectsRoot,
        now: () => 1_000_000,
      }),
    ).rejects.toThrow(/session/)
  })

  it('emits a valid fork.checkpoint event through the existing recorder path — appended to the event log', async () => {
    const { event, recordedTo } = await captureCheckpoint({
      lane: '148-lab-checkpoint',
      worktreePath: repoDir,
      capturedBy: 'gate',
      exec: realExec,
      dataRoot,
      claudeProjectsRoot,
      now: () => 1_000_000,
    })

    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
    expect(event.source).toBe('lab')
    expect(event.payload.capturedBy).toBe('gate')

    const recorded = await readSessionEvents(recordedTo)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toEqual(event)
  })

  it('sets eventIndex to the log length at capture, and advances it across a second checkpoint on the same session', async () => {
    const now = () => 1_000_000 // young enough to resume within RESUME_WINDOW_MS
    const first = await captureCheckpoint({
      lane: '148-lab-checkpoint',
      worktreePath: repoDir,
      capturedBy: 'operator',
      exec: realExec,
      dataRoot,
      claudeProjectsRoot,
      now,
      checkpointId: uniqueCheckpointId('first'),
    })
    expect(first.event.payload.eventIndex).toBe(0)

    await writeFile(path.join(repoDir, 'untracked-2.txt'), 'more\n')
    const second = await captureCheckpoint({
      lane: '148-lab-checkpoint',
      worktreePath: repoDir,
      capturedBy: 'operator',
      exec: realExec,
      dataRoot,
      claudeProjectsRoot,
      now,
      checkpointId: uniqueCheckpointId('second'),
    })
    expect(second.event.payload.eventIndex).toBe(1)
    expect(second.recordedTo).toBe(first.recordedTo)

    const recorded = await readSessionEvents(first.recordedTo)
    expect(recorded).toHaveLength(2)
  })
})
