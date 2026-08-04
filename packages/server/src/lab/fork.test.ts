import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, ExecResult } from '@rhizomorph/core'
import { rhizomorphEventSchema } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { sessionDirFor } from '../log/paths.js'
import { listSessions, readSessionEvents } from '../log/session-log.js'
import { exec as realExec } from '../server/exec.js'
import { captureCheckpoint } from './checkpoint.js'
import { armLaneHandle, dispatchFork, findCheckpoint, workmuxAddArgv } from './fork.js'
import { labWorktreesRoot } from './paths.js'

/** Hermetic under 4x concurrency: per-test `mkdtemp` root, pid+uuid ids, no shared state. */

let root: string
let repoDir: string
let dataRoot: string
let claudeProjectsRoot: string

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function uniqueId(label: string): string {
  return `${label}-${process.pid}-${randomUUID()}`
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-fork-test-'))
  repoDir = path.join(root, 'repo')
  dataRoot = path.join(root, 'data')
  claudeProjectsRoot = path.join(root, 'claude-projects')

  await mkdir(repoDir, { recursive: true })
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  await writeFile(path.join(repoDir, 'tracked.txt'), 'v1\n')
  git(['add', '.'])
  git(['commit', '-m', 'initial commit'])
  await writeFile(path.join(repoDir, 'tracked.txt'), 'v2 in flight\n')

  const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir))
  await mkdir(projectDir, { recursive: true })
  const sessionId = randomUUID()
  await writeFile(
    path.join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', sessionId, cwd: repoDir, message: 'go' })}\n`,
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function capture(lane = 'parent-lane', now = 1_000_000): Promise<string> {
  const { event } = await captureCheckpoint({
    lane,
    worktreePath: repoDir,
    capturedBy: 'operator',
    exec: realExec,
    dataRoot,
    claudeProjectsRoot,
    now: () => now,
    checkpointId: uniqueId('ckpt'),
  })
  return event.payload.checkpointId
}

/** Real git, stubbed everything else — so no test ever spawns workmux or npm. */
function execWithStubs(record: string[][], stub: (command: string, args: readonly string[]) => ExecResult | null): Exec {
  return async (command, args, options) => {
    record.push([command, ...args])
    const stubbed = stub(command, args)
    if (stubbed !== null) return stubbed
    return realExec(command, args, options)
  }
}

const OK: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }

describe('workmuxAddArgv', () => {
  it('is the shape scripts/lane-agent.sh documents — the lab does not reinvent lane launching', () => {
    expect(workmuxAddArgv('fork-1-arm-1', { model: 'opus' })).toEqual([
      'add',
      'fork-1-arm-1',
      '-b',
      '-a',
      'bash scripts/lane-agent.sh opus',
    ])
  })

  it('omits the agent override when no model was varied — the arm runs the fleet default', () => {
    expect(workmuxAddArgv('fork-1-arm-1', {})).toEqual(['add', 'fork-1-arm-1', '-b'])
  })

  it('passes a prompt file straight through', () => {
    expect(workmuxAddArgv('h', { promptFile: '/tmp/p.md' })).toContain('-P')
    expect(workmuxAddArgv('h', { promptFile: '/tmp/p.md' })).toContain('/tmp/p.md')
  })
})

describe('findCheckpoint', () => {
  it('takes the lane\'s most recent checkpoint when none is named', async () => {
    await capture('parent-lane', 1_000_000)
    const second = await capture('parent-lane', 1_000_500)
    const found = await findCheckpoint({ parentWorktreePath: repoDir, lane: 'parent-lane', dataRoot })
    expect(found.checkpointId).toBe(second)
  })

  it('takes the named checkpoint, not the newest', async () => {
    const first = await capture('parent-lane', 1_000_000)
    await capture('parent-lane', 1_000_500)
    const found = await findCheckpoint({
      parentWorktreePath: repoDir,
      lane: 'parent-lane',
      checkpointId: first,
      dataRoot,
    })
    expect(found.checkpointId).toBe(first)
  })

  it('never returns another lane\'s checkpoint', async () => {
    await capture('other-lane', 1_000_000)
    await expect(
      findCheckpoint({ parentWorktreePath: repoDir, lane: 'parent-lane', dataRoot }),
    ).rejects.toThrow(/no fork\.checkpoint recorded for lane "parent-lane"/)
  })

  it('names the remedy when the lane has no checkpoints at all', async () => {
    await expect(
      findCheckpoint({ parentWorktreePath: repoDir, lane: 'parent-lane', dataRoot }),
    ).rejects.toThrow(/rhizomorph lab checkpoint parent-lane/)
  })

  it('refuses a checkpoint id that was never recorded', async () => {
    await capture()
    await expect(
      findCheckpoint({ parentWorktreePath: repoDir, lane: 'parent-lane', checkpointId: 'nope', dataRoot }),
    ).rejects.toThrow(/no checkpoint "nope"/)
  })
})

describe('dispatchFork', () => {
  it('restores n arms, each with its own worktree and its own session', async () => {
    await capture()
    const forkId = uniqueId('fork')

    const result = await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 3,
      forkId,
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    })

    expect(result.arms).toHaveLength(3)
    expect(result.arms.map((arm) => arm.arm)).toEqual([1, 2, 3])

    const worktrees = new Set(result.arms.map((arm) => arm.worktreePath))
    const sessions = new Set(result.arms.map((arm) => arm.session.filePath))
    expect(worktrees.size).toBe(3)
    expect(sessions.size).toBe(3)

    for (const arm of result.arms) {
      expect(arm.laneHandle).toBe(armLaneHandle(forkId, arm.arm))
      expect(arm.worktreePath.startsWith(labWorktreesRoot(dataRoot) + path.sep)).toBe(true)
      // The parent's in-flight edit came along, and the session names this tree.
      expect(await readFile(path.join(arm.worktreePath, 'tracked.txt'), 'utf8')).toBe('v2 in flight\n')
      const session = await readFile(arm.session.filePath, 'utf8')
      expect(session).toContain(arm.worktreePath)
      expect(session).not.toContain(`"cwd":"${repoDir}"`)
    }
  })

  it('records one valid fork.dispatched per arm, marking each lane synthetic', async () => {
    const checkpointId = await capture()
    const forkId = uniqueId('fork')

    const result = await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 2,
      forkId,
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    })

    const sessionDir = sessionDirFor(repoDir, dataRoot)
    const sessions = await listSessions(sessionDir)
    const file = sessions[sessions.length - 1]
    if (!file) throw new Error('expected a recorded session')
    const events = await readSessionEvents(path.join(sessionDir, file.fileName))
    const dispatched = events.filter((event) => event.type === 'fork.dispatched')

    expect(dispatched).toHaveLength(2)
    for (const event of dispatched) {
      expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
      expect(event.source).toBe('lab')
      expect(event.payload).toMatchObject({ forkId, parentLane: 'parent-lane', checkpointId })
      expect(event.payload.laneHandle).not.toBe('parent-lane')
    }
    expect(result.recordedTo).toBe(path.join(sessionDir, file.fileName))
  })

  it('records the treatment: the model verbatim and the prompt as a digest, not as text', async () => {
    await capture()
    const promptFile = path.join(root, 'prompt.md')
    await writeFile(promptFile, 'be brave\n')

    const result = await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 1,
      forkId: uniqueId('fork'),
      model: 'opus',
      promptFile,
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    })

    const treatment = result.arms[0]?.event.payload.treatment
    expect(treatment?.model).toBe('opus')
    expect(treatment?.promptDigest).toMatch(/^[0-9a-f]{64}$/)
    // The operator's words are not in the log.
    const recorded = await readFile(result.recordedTo, 'utf8')
    expect(recorded).not.toContain('be brave')
  })

  it('writes NOTHING outside the lab namespace when --launch was not given', async () => {
    await capture()
    const before = git(['status', '--porcelain'])
    const refsBefore = git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])
    const calls: string[][] = []

    await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 2,
      forkId: uniqueId('fork'),
      dataRoot,
      claudeProjectsRoot,
      install: false,
      now: () => 1_000_100,
      exec: execWithStubs(calls, () => null),
    })

    expect(calls.map((call) => call[0])).not.toContain('workmux')
    expect(git(['status', '--porcelain'])).toBe(before)
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe(refsBefore)
  })

  it('still reports the exact launcher command line it did not run', async () => {
    await capture()
    const result = await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 1,
      forkId: 'fork-fixed',
      model: 'sonnet',
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    })

    const arm = result.arms[0]
    expect(arm?.launched).toBe(false)
    expect(arm?.launcherArgv).toEqual([
      'workmux',
      'add',
      'fork-fixed-arm-1',
      '-b',
      '-a',
      'bash scripts/lane-agent.sh sonnet',
    ])
  })

  it('shells out to workmux add once per arm when --launch is given', async () => {
    await capture()
    const calls: string[][] = []

    const result = await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 3,
      forkId: 'fork-launch',
      launch: true,
      dataRoot,
      claudeProjectsRoot,
      install: false,
      now: () => 1_000_100,
      exec: execWithStubs(calls, (command) => (command === 'workmux' ? OK : null)),
    })

    const adds = calls.filter((call) => call[0] === 'workmux' && call[1] === 'add')
    expect(adds).toHaveLength(3)
    expect(adds.map((call) => call[2])).toEqual(['fork-launch-arm-1', 'fork-launch-arm-2', 'fork-launch-arm-3'])
    expect(result.arms.every((arm) => arm.launched)).toBe(true)
  })

  it('follows the agent: when workmux puts the arm elsewhere, the session is synthesized THERE, naming that tree', async () => {
    await capture()
    const workmuxTree = path.join(root, 'workmux-worktrees', 'fork-follow-arm-1')
    await mkdir(workmuxTree, { recursive: true })
    const calls: string[][] = []

    const result = await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 1,
      forkId: 'fork-follow',
      launch: true,
      dataRoot,
      claudeProjectsRoot,
      install: false,
      now: () => 1_000_100,
      exec: execWithStubs(calls, (command, args) => {
        if (command !== 'workmux') return null
        if (args[0] === 'path') return { ...OK, stdout: `${workmuxTree}\n` }
        return OK
      }),
    })

    const arm = result.arms[0]
    if (!arm) throw new Error('expected one arm')
    expect(arm.worktreePath).toBe(workmuxTree)
    expect(arm.launcherSession).not.toBeNull()

    const followed = await readFile(arm.launcherSession?.filePath ?? '', 'utf8')
    expect(followed).toContain(workmuxTree)
    expect(followed).not.toContain(repoDir)
    // And the event books the arm against the tree the agent actually runs in.
    expect(arm.event.payload.worktreePath).toBe(workmuxTree)
  })

  it('fails loudly when the launcher fails, rather than reporting a launch that did not happen', async () => {
    await capture()
    const calls: string[][] = []

    await expect(
      dispatchFork({
        parentLane: 'parent-lane',
        parentWorktreePath: repoDir,
        arms: 1,
        forkId: uniqueId('fork'),
        launch: true,
        dataRoot,
        claudeProjectsRoot,
        install: false,
        now: () => 1_000_100,
        exec: execWithStubs(calls, (command) =>
          command === 'workmux' ? { stdout: '', stderr: 'branch exists', code: 1, failed: true } : null,
        ),
      }),
    ).rejects.toThrow(/workmux add .* failed: branch exists/)
  })

  it('refuses a non-positive arm count', async () => {
    await capture()
    await expect(
      dispatchFork({
        parentLane: 'parent-lane',
        parentWorktreePath: repoDir,
        arms: 0,
        dataRoot,
        claudeProjectsRoot,
        exec: realExec,
        install: false,
      }),
    ).rejects.toThrow(/invalid arm count/)
  })

  it('refuses before restoring anything when the checkpoint digest no longer matches', async () => {
    const checkpointId = await capture()
    const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir))
    const [sessionName] = await readdir(projectDir)
    if (!sessionName) throw new Error('expected a parent session file')
    await writeFile(path.join(projectDir, sessionName), '{"tampered":true}\n')

    await expect(
      dispatchFork({
        parentLane: 'parent-lane',
        parentWorktreePath: repoDir,
        arms: 3,
        checkpointId,
        forkId: uniqueId('fork'),
        dataRoot,
        claudeProjectsRoot,
        exec: realExec,
        install: false,
        now: () => 1_000_100,
      }),
    ).rejects.toThrow(/truncated or replaced|digest mismatch/)

    expect(git(['worktree', 'list'])).not.toContain(labWorktreesRoot(dataRoot))
  })
})
