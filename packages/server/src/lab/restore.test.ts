import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { exec as realExec } from '../server/exec.js'
import { captureCheckpoint } from './checkpoint.js'
import { armWorktreePath, labWorktreesRoot } from './paths.js'
import {
  restoreCheckpoint,
  restoreWorkspace,
  rewriteWorktreePaths,
  synthesizeSession,
  verifySessionPrefix,
  type CheckpointCoordinates,
} from './restore.js'

/**
 * Hermetic under 4x concurrency (the #148 lesson): every path in this file
 * comes from a `mkdtemp` root created per test, and every id that could
 * collide machine-wide carries `process.pid` plus a fresh uuid. Nothing is
 * shared between tests and nothing is written outside the temp root.
 */

let root: string
let repoDir: string
let dataRoot: string
let claudeProjectsRoot: string
let parentSessionFile: string

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function uniqueId(label: string): string {
  return `${label}-${process.pid}-${randomUUID()}`
}

/** A miniature Claude Code session: JSONL, every line naming the parent's tree. */
function parentSessionLines(worktree: string, sessionId: string): string {
  return (
    `${JSON.stringify({ type: 'user', sessionId, cwd: worktree, message: 'start' })}\n` +
    `${JSON.stringify({
      type: 'assistant',
      sessionId,
      cwd: worktree,
      toolUse: { name: 'Read', input: { file_path: `${worktree}/tracked.txt` } },
    })}\n` +
    `${JSON.stringify({ type: 'user', sessionId, cwd: worktree, message: `see ${worktree}/notes.md` })}\n`
  )
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-restore-test-'))
  repoDir = path.join(root, 'repo')
  dataRoot = path.join(root, 'data')
  claudeProjectsRoot = path.join(root, 'claude-projects')

  await mkdir(repoDir, { recursive: true })
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  await writeFile(path.join(repoDir, 'tracked.txt'), 'v1\n')
  await writeFile(path.join(repoDir, 'package.json'), `${JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }, null, 2)}\n`)
  git(['add', '.'])
  git(['commit', '-m', 'initial commit'])

  // The three kinds of dirt the checkpoint recipe captures in one commit.
  await writeFile(path.join(repoDir, 'tracked.txt'), 'v2 modified\n')
  await writeFile(path.join(repoDir, 'staged.txt'), 'staged\n')
  git(['add', 'staged.txt'])
  await writeFile(path.join(repoDir, 'untracked.txt'), 'untracked\n')

  const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir))
  await mkdir(projectDir, { recursive: true })
  parentSessionFile = path.join(projectDir, `${randomUUID()}.jsonl`)
  await writeFile(parentSessionFile, parentSessionLines(repoDir, path.basename(parentSessionFile, '.jsonl')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Captures a real checkpoint and narrows it to what a restore needs. */
async function capture(): Promise<CheckpointCoordinates> {
  const { event } = await captureCheckpoint({
    lane: 'parent-lane',
    worktreePath: repoDir,
    capturedBy: 'operator',
    exec: realExec,
    dataRoot,
    claudeProjectsRoot,
    now: () => 1_000_000,
    checkpointId: uniqueId('ckpt'),
  })
  return event.payload
}

describe('verifySessionPrefix', () => {
  it('accepts the exact prefix the checkpoint digested', async () => {
    const checkpoint = await capture()
    const verified = await verifySessionPrefix(checkpoint)
    expect(verified.digest).toBe(checkpoint.sessionDigest)
    expect(verified.bytes).toHaveLength(checkpoint.sessionCutByte)
  })

  it('refuses loudly when the session file changed under the digest', async () => {
    const checkpoint = await capture()
    // Same length, different bytes — only the digest can catch this.
    const original = await readFile(checkpoint.sessionFile, 'utf8')
    await writeFile(checkpoint.sessionFile, original.replace('start', 'stArt'))

    await expect(verifySessionPrefix(checkpoint)).rejects.toThrow(/session digest mismatch/)
  })

  it('names both digests in the refusal, so the operator can see which side moved', async () => {
    const checkpoint = await capture()
    const original = await readFile(checkpoint.sessionFile, 'utf8')
    await writeFile(checkpoint.sessionFile, original.replace('start', 'stArt'))

    const error = await verifySessionPrefix(checkpoint).catch((err: unknown) => err)
    expect(String(error)).toContain(checkpoint.sessionDigest)
    expect(String(error)).toMatch(/read [0-9a-f]{64}/)
  })

  it('refuses when the session file was truncated below the cut', async () => {
    const checkpoint = await capture()
    await writeFile(checkpoint.sessionFile, '{"short":true}\n')
    await expect(verifySessionPrefix(checkpoint)).rejects.toThrow(/truncated or replaced/)
  })

  it('refuses when the session file is gone', async () => {
    const checkpoint = await capture()
    await rm(checkpoint.sessionFile)
    await expect(verifySessionPrefix(checkpoint)).rejects.toThrow(/cannot read its session file/)
  })
})

describe('rewriteWorktreePaths', () => {
  it('rewrites a path at a segment boundary and at end-of-string', () => {
    const { text } = rewriteWorktreePaths('cwd=/a/parent file=/a/parent/x.ts', '/a/parent', '/b/fork')
    expect(text).toBe('cwd=/b/fork file=/b/fork/x.ts')
  })

  it('leaves a sibling whose name merely STARTS with the parent path alone', () => {
    const { text } = rewriteWorktreePaths('/a/parent-other/x.ts', '/a/parent', '/b/fork')
    expect(text).toBe('/a/parent-other/x.ts')
  })

  it('rewrites inside JSON string values without disturbing the surrounding line', () => {
    const line = JSON.stringify({ cwd: '/a/parent', keep: 1.5, note: 'x' })
    const { text } = rewriteWorktreePaths(line, '/a/parent', '/b/fork')
    expect(JSON.parse(text)).toEqual({ cwd: '/b/fork', keep: 1.5, note: 'x' })
  })

  it('counts what it replaced — zero is reported, not hidden', () => {
    const { rewrites } = rewriteWorktreePaths('nothing here', '/a/parent', '/b/fork')
    expect(rewrites[0]).toMatchObject({ count: 0 })
  })
})

describe('synthesizeSession (prd12 ruling 5)', () => {
  it('MANDATORY: rewrites every parent-worktree path to the fork worktree, leaving none behind', async () => {
    const checkpoint = await capture()
    const forkWorktree = armWorktreePath(dataRoot, uniqueId('fork'), 1)

    const session = await synthesizeSession({
      checkpoint,
      parentWorktreePath: repoDir,
      forkWorktreePath: forkWorktree,
      claudeProjectsRoot,
    })

    const written = await readFile(session.filePath, 'utf8')
    expect(written).not.toContain(repoDir)
    expect(written).toContain(forkWorktree)

    // Every line still parses, and every cwd names the fork.
    const lines = written.trimEnd().split('\n').map((line) => JSON.parse(line) as { cwd: string })
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(line.cwd).toBe(forkWorktree)

    // Including the path buried in a tool input and the one inside prose.
    expect(written).toContain(`${forkWorktree}/tracked.txt`)
    expect(written).toContain(`see ${forkWorktree}/notes.md`)
    expect(session.rewrites[0]?.count).toBeGreaterThanOrEqual(5)
  })

  it('lands under the FORK worktree project slug — the sessionlog collector finds it with zero new code', async () => {
    const checkpoint = await capture()
    const forkWorktree = armWorktreePath(dataRoot, uniqueId('fork'), 1)

    const session = await synthesizeSession({
      checkpoint,
      parentWorktreePath: repoDir,
      forkWorktreePath: forkWorktree,
      claudeProjectsRoot,
    })

    const expectedDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(forkWorktree))
    expect(path.dirname(session.filePath)).toBe(expectedDir)
    expect(path.basename(session.filePath)).toBe(`${session.sessionId}.jsonl`)
  })

  it('never writes into the parent lane project slug', async () => {
    const checkpoint = await capture()
    const forkWorktree = armWorktreePath(dataRoot, uniqueId('fork'), 1)

    const session = await synthesizeSession({
      checkpoint,
      parentWorktreePath: repoDir,
      forkWorktreePath: forkWorktree,
      claudeProjectsRoot,
    })

    const parentDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir))
    expect(session.filePath.startsWith(parentDir + path.sep)).toBe(false)
    // And the parent's own session file is byte-for-byte what it was.
    const parentStill = await readFile(checkpoint.sessionFile, 'utf8')
    expect(parentStill).toBe(parentSessionLines(repoDir, path.basename(checkpoint.sessionFile, '.jsonl')))
  })

  it('refuses outright when the fork worktree IS the parent worktree — ruling 5 hard edge', async () => {
    const checkpoint = await capture()
    await expect(
      synthesizeSession({
        checkpoint,
        parentWorktreePath: repoDir,
        forkWorktreePath: repoDir,
        claudeProjectsRoot,
      }),
    ).rejects.toThrow(/never be written into its parent/)
  })

  it('rewrites the session id so the file agrees with its own name', async () => {
    const checkpoint = await capture()
    const forkWorktree = armWorktreePath(dataRoot, uniqueId('fork'), 1)
    const sessionUuid = randomUUID()

    const session = await synthesizeSession({
      checkpoint,
      parentWorktreePath: repoDir,
      forkWorktreePath: forkWorktree,
      claudeProjectsRoot,
      sessionUuid,
    })

    const written = await readFile(session.filePath, 'utf8')
    expect(written).not.toContain(path.basename(checkpoint.sessionFile, '.jsonl'))
    const first = JSON.parse(written.split('\n')[0] ?? '{}') as { sessionId: string }
    expect(first.sessionId).toBe(sessionUuid)
  })

  it('verifies the digest before writing anything — a mismatch leaves no file behind', async () => {
    const checkpoint = await capture()
    const forkWorktree = armWorktreePath(dataRoot, uniqueId('fork'), 1)
    const original = await readFile(checkpoint.sessionFile, 'utf8')
    await writeFile(checkpoint.sessionFile, original.replace('start', 'stArt'))

    await expect(
      synthesizeSession({
        checkpoint,
        parentWorktreePath: repoDir,
        forkWorktreePath: forkWorktree,
        claudeProjectsRoot,
      }),
    ).rejects.toThrow(/digest mismatch/)

    const forkDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(forkWorktree))
    await expect(readFile(path.join(forkDir, 'anything.jsonl'), 'utf8')).rejects.toThrow()
  })

  it('drops a trailing partial line rather than writing half a JSON object', async () => {
    const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir))
    const midCutFile = path.join(projectDir, `${randomUUID()}.jsonl`)
    const body = `${JSON.stringify({ cwd: repoDir, n: 1 })}\n{"cwd":"${repoDir}","n":2`
    await writeFile(midCutFile, body)

    const { createHash } = await import('node:crypto')
    const checkpoint: CheckpointCoordinates = {
      checkpointId: uniqueId('ckpt-partial'),
      sessionFile: midCutFile,
      sessionCutByte: Buffer.byteLength(body),
      sessionDigest: createHash('sha256').update(Buffer.from(body)).digest('hex'),
      snapshotSha: 'unused-here',
    }

    const forkWorktree = armWorktreePath(dataRoot, uniqueId('fork'), 1)
    const session = await synthesizeSession({
      checkpoint,
      parentWorktreePath: repoDir,
      forkWorktreePath: forkWorktree,
      claudeProjectsRoot,
    })

    expect(session.droppedPartialLine).toBe(true)
    expect(session.linesCopied).toBe(1)
    const written = await readFile(session.filePath, 'utf8')
    expect(() => JSON.parse(written.trimEnd())).not.toThrow()
  })
})

describe('restoreWorkspace', () => {
  it('refuses a target outside the lab namespace — ruling 1, enforced not described', async () => {
    const checkpoint = await capture()
    await expect(
      restoreWorkspace({
        parentWorktreePath: repoDir,
        snapshotSha: checkpoint.snapshotSha,
        forkWorktreePath: path.join(repoDir, 'inside-the-watched-repo'),
        dataRoot,
        exec: realExec,
        install: false,
      }),
    ).rejects.toThrow(/refusing to write outside the lab's namespace/)
  })

  it('restores the parent dirt into a detached lab worktree, leaving the parent untouched', async () => {
    const statusBefore = git(['status', '--porcelain'])
    const checkpoint = await capture()
    const forkWorktree = armWorktreePath(dataRoot, uniqueId('fork'), 1)

    const restored = await restoreWorkspace({
      parentWorktreePath: repoDir,
      snapshotSha: checkpoint.snapshotSha,
      forkWorktreePath: forkWorktree,
      dataRoot,
      exec: realExec,
      install: false,
    })

    expect(restored.worktreePath).toBe(forkWorktree)
    expect(forkWorktree.startsWith(labWorktreesRoot(dataRoot) + path.sep)).toBe(true)

    // All three kinds of dirt arrived, and the arm starts clean.
    expect(await readFile(path.join(forkWorktree, 'tracked.txt'), 'utf8')).toBe('v2 modified\n')
    expect(await readFile(path.join(forkWorktree, 'staged.txt'), 'utf8')).toBe('staged\n')
    expect(await readFile(path.join(forkWorktree, 'untracked.txt'), 'utf8')).toBe('untracked\n')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: forkWorktree, encoding: 'utf8' })).toBe('')

    // Detached: `git branch --show-current` prints nothing, and the arm owns no ref.
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: forkWorktree,
      encoding: 'utf8',
    })
    expect(branch.trim()).toBe('')
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe('refs/heads/main\n')

    // And the parent worktree is exactly as it was.
    expect(git(['status', '--porcelain'])).toBe(statusBefore)
  })

  it('runs npm install when the restored tree has a package.json', async () => {
    const checkpoint = await capture()
    const forkWorktree = armWorktreePath(dataRoot, uniqueId('fork'), 1)
    const calls: string[][] = []

    const restored = await restoreWorkspace({
      parentWorktreePath: repoDir,
      snapshotSha: checkpoint.snapshotSha,
      forkWorktreePath: forkWorktree,
      dataRoot,
      install: true,
      exec: async (command, args, options) => {
        calls.push([command, ...args])
        if (command === 'npm') return { stdout: '', stderr: '', code: 0, failed: false }
        return realExec(command, args, options)
      },
    })

    expect(restored.installed).toBe(true)
    expect(calls).toContainEqual(['npm', 'install', '--no-audit', '--no-fund'])
  })

  it('says so rather than pretending when there is nothing to install', async () => {
    await rm(path.join(repoDir, 'package.json'))
    const checkpoint = await capture()
    const forkWorktree = armWorktreePath(dataRoot, uniqueId('fork'), 1)

    const restored = await restoreWorkspace({
      parentWorktreePath: repoDir,
      snapshotSha: checkpoint.snapshotSha,
      forkWorktreePath: forkWorktree,
      dataRoot,
      install: true,
      exec: realExec,
    })

    expect(restored.installed).toBe(false)
  })
})

describe('restoreCheckpoint — end to end', () => {
  it('restores workspace AND session against a real fixture repo', async () => {
    const checkpoint = await capture()
    const forkWorktree = armWorktreePath(dataRoot, uniqueId('fork'), 1)

    const { workspace, session } = await restoreCheckpoint({
      checkpoint,
      parentWorktreePath: repoDir,
      forkWorktreePath: forkWorktree,
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
    })

    expect(workspace.worktreePath).toBe(forkWorktree)
    expect(await readFile(path.join(forkWorktree, 'untracked.txt'), 'utf8')).toBe('untracked\n')

    const written = await readFile(session.filePath, 'utf8')
    expect(written).not.toContain(repoDir)
    expect(written).toContain(forkWorktree)
    expect(session.linesCopied).toBe(3)
  })

  it('refuses on a digest mismatch BEFORE creating a worktree — nothing to clean up', async () => {
    const checkpoint = await capture()
    const forkWorktree = armWorktreePath(dataRoot, uniqueId('fork'), 1)
    const original = await readFile(checkpoint.sessionFile, 'utf8')
    await writeFile(checkpoint.sessionFile, original.replace('start', 'stArt'))

    await expect(
      restoreCheckpoint({
        checkpoint,
        parentWorktreePath: repoDir,
        forkWorktreePath: forkWorktree,
        dataRoot,
        claudeProjectsRoot,
        exec: realExec,
        install: false,
      }),
    ).rejects.toThrow(/digest mismatch/)

    await expect(readFile(path.join(forkWorktree, 'tracked.txt'), 'utf8')).rejects.toThrow()
    expect(git(['worktree', 'list'])).not.toContain(forkWorktree)
  })

  it('gives two arms of the same checkpoint independent worktrees and sessions', async () => {
    const checkpoint = await capture()
    const forkId = uniqueId('fork')

    const arms = []
    for (const arm of [1, 2]) {
      arms.push(
        await restoreCheckpoint({
          checkpoint,
          parentWorktreePath: repoDir,
          forkWorktreePath: armWorktreePath(dataRoot, forkId, arm),
          dataRoot,
          claudeProjectsRoot,
          exec: realExec,
          install: false,
        }),
      )
    }

    const [first, second] = arms
    if (!first || !second) throw new Error('expected two arms')
    expect(first.workspace.worktreePath).not.toBe(second.workspace.worktreePath)
    expect(first.session.filePath).not.toBe(second.session.filePath)
    expect(first.session.sessionId).not.toBe(second.session.sessionId)

    // Each arm's session names its OWN tree and no other.
    const firstText = await readFile(first.session.filePath, 'utf8')
    expect(firstText).toContain(first.workspace.worktreePath)
    expect(firstText).not.toContain(second.workspace.worktreePath)
  })
})
