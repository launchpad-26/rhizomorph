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
import {
  armLaneHandle,
  dispatchFork,
  FORK_EXEC_TIMEOUT_MS,
  FORK_LAUNCH_TIMEOUT_MS,
  findCheckpoint,
  LAUNCH_CEILING_LANES,
  MODEL_GRAMMAR,
  workmuxAddArgv,
} from './fork.js'
import { labWorktreesRoot } from './paths.js'
import { RESTORE_EXEC_TIMEOUT_MS } from './restore.js'

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

  /**
   * #234's second defect, at the exact line where it lands.
   *
   * `-a` is the ONE place in this repo where a caller-supplied value goes into
   * a string rather than an argv element, because `workmux add -a` takes the
   * agent's whole command line as one string and runs it through a shell in a
   * tmux pane. So `model` was, in effect, `eval`'d one hop downstream — which
   * is why auditing this repo's own `execFile` sites cleared the code.
   *
   * Two assertions per payload, deliberately: that the call is refused, AND
   * that the argv which would have carried it does not exist. The second is
   * the one that matters — a refusal that still returned a poisoned array for
   * some caller to use would be no fix at all.
   */
  describe('refuses a model no shell may safely be handed (#234)', () => {
    const PAYLOADS: ReadonlyArray<{ model: string; names: string }> = [
      { model: 'opus; touch /tmp/pwned', names: '";"' },
      { model: 'opus$(touch /tmp/pwned)', names: '"$"' },
      { model: 'opus`touch /tmp/pwned`', names: '"`"' },
      { model: 'opus && touch /tmp/pwned', names: 'a space' },
      { model: 'opus | sh', names: 'a space' },
      { model: 'opus\ntouch /tmp/pwned', names: '"\\n"' },
      { model: 'opus --dangerously-skip-permissions', names: 'a space' },
      { model: '$(id)', names: '"$"' },
      { model: 'opus\t; sh', names: '"\\t"' },
    ]

    it('throws, naming the offending character an operator can act on, and builds no argv at all', () => {
      for (const { model, names } of PAYLOADS) {
        let built: readonly string[] | undefined
        expect(
          () => {
            built = workmuxAddArgv('fork-1-arm-1', { model })
          },
          `${JSON.stringify(model)} was not refused, or was refused without naming ${names}`,
        ).toThrow(names)
        // Nothing came back — so no array anywhere carries the payload, which
        // is the property that actually matters. A refusal that still handed a
        // poisoned argv to some other caller would be no fix.
        expect(built, `${JSON.stringify(model)} produced an argv`).toBeUndefined()
      }
    })

    it('a legitimate model still produces exactly the documented argv, payload-free', () => {
      // The healthy shape, restated here so the refusals above are proven to
      // be discriminating rather than blanket.
      for (const model of ['sonnet', 'opus', 'haiku', 'claude-opus-5', 'claude-3-5-sonnet-20241022']) {
        const argv = workmuxAddArgv('fork-1-arm-1', { model })
        expect(argv).toEqual(['add', 'fork-1-arm-1', '-b', '-a', `bash scripts/lane-agent.sh ${model}`])
        expect(argv.join(' ')).not.toMatch(/[;$`|&\n]/)
      }
    })

    it('a bedrock-style id with dots and a colon is a legitimate model, not a payload', () => {
      const model = 'us.anthropic.claude-3-5-sonnet-20241022-v1:0'
      expect(workmuxAddArgv('h', { model })).toEqual(['add', 'h', '-b', '-a', `bash scripts/lane-agent.sh ${model}`])
    })

    /**
     * #405: this file pinned `MODEL_GRAMMAR` nowhere, so widening the
     * `fork.ts` copy alone — exactly what #234's open item contemplates for
     * Bedrock ARNs, which carry slashes — left every test here green while
     * the two copies drifted. The grammar is asserted against directly, not
     * only through `workmuxAddArgv`, so a change to the constant fails on the
     * constant rather than somewhere downstream of it.
     */
    it('is the exact grammar api/lab.ts declares, and it admits no slash', () => {
      expect(MODEL_GRAMMAR.source).toBe('^[A-Za-z0-9._:-]+$')

      // The Bedrock ARN shape the open item is about. It is refused today;
      // admitting it is a decision to be taken in both copies at once, and
      // `model-grammar-law.test.ts` is what makes that simultaneous.
      expect(MODEL_GRAMMAR.test('anthropic.claude-v2')).toBe(true)
      expect(MODEL_GRAMMAR.test('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2')).toBe(false)
      expect(() => workmuxAddArgv('h', { model: 'anthropic/claude-v2' })).toThrow('"/"')
    })
  })
})

/**
 * The guard makes two separate ordering claims, and they need two separate
 * tests — #405 found the single test that existed proving only the first.
 *
 * 1. It runs before `findCheckpoint`. Proved WITHOUT a seeded checkpoint: if
 *    the guard moved below the lookup, `findCheckpoint` would throw its own
 *    "no fork.checkpoint recorded" first and the `/refusing to launch/`
 *    assertion goes red.
 * 2. It runs before anything is RESTORED. That needs a seeded checkpoint, and
 *    is why the second test exists. With no checkpoint on disk, execution
 *    cannot reach the restore on either path, so `labWorktreesRoot` is absent
 *    whether the guard ran or not — the assertion that used to live in test 1
 *    could not tell the two apart and proved nothing (#405).
 */
describe('dispatchFork refuses a poisoned model before anything is restored (#234)', () => {
  const neverRuns: Exec = async (command, argv) => {
    throw new Error(`nothing should have been executed, but got: ${command} ${argv.join(' ')}`)
  }

  const poisoned = {
    parentLane: 'parent-lane',
    arms: 1,
    model: 'opus; touch /tmp/pwned',
    launch: true,
  } as const

  it('throws before the checkpoint is even looked up — nothing forked, nothing executed', async () => {
    // Deliberately no `capture()`: the refusal must beat the checkpoint
    // lookup, so the lookup must be capable of failing on its own.
    await expect(
      dispatchFork({ ...poisoned, parentWorktreePath: repoDir, exec: neverRuns, dataRoot, claudeProjectsRoot }),
    ).rejects.toThrow(/refusing to launch/)
  })

  it('restores nothing even when the checkpoint it would have used does exist', async () => {
    // The checkpoint is seeded, so `findCheckpoint` succeeds and the only
    // thing between the poisoned model and a restored worktree is the guard.
    //
    // The exec here RECORDS rather than throws, which is the whole point: a
    // throwing stub aborts the restore at its first git call, so the refusal
    // still arrives and every containment assertion passes vacuously — the
    // stub, not the guard, did the work. Letting git actually run means a
    // guard that fired too late leaves real evidence behind, and these
    // assertions are what fail.
    await capture()
    const calls: string[][] = []

    await expect(
      dispatchFork({
        ...poisoned,
        parentWorktreePath: repoDir,
        dataRoot,
        claudeProjectsRoot,
        install: false,
        exec: execWithStubs(calls, (command) => (command === 'workmux' ? OK : null)),
      }),
    ).rejects.toThrow(/refusing to launch/)

    expect(calls, 'the refusal came after something had already been run').toEqual([])
    await expect(readdir(labWorktreesRoot(dataRoot))).rejects.toThrow(/ENOENT/)
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

  it('restores arms × runs realities under ONE forkId, no two sharing a worktree or a handle (prd53 ruling 1)', async () => {
    await capture()
    const forkId = uniqueId('fork')

    const result = await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 2,
      runs: 2,
      forkId,
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    })

    expect(result.runs).toBe(2)
    expect(result.arms.map((d) => [d.arm, d.run])).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]])
    expect(new Set(result.arms.map((d) => d.worktreePath)).size).toBe(4)
    expect(new Set(result.arms.map((d) => d.laneHandle)).size).toBe(4)
    for (const d of result.arms) {
      expect(d.event.payload.forkId).toBe(forkId)
      expect(d.event.payload.run).toBe(d.run)
      expect(d.laneHandle).toBe(armLaneHandle(forkId, d.arm, d.run))
    }
    // Run 1 keeps the pre-prd53 spelling; only the second run carries its number.
    expect(result.arms[0]?.laneHandle).toBe(`${forkId}-arm-1`)
    expect(result.arms[1]?.laneHandle).toBe(`${forkId}-arm-1-run-2`)
  })

  it('dispatches arm k of an existing fork when told which arm it is — how one launch becomes one experiment', async () => {
    await capture()
    const forkId = uniqueId('fork')
    const common = {
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 1,
      forkId,
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    }

    const first = await dispatchFork({ ...common, armNumber: 1 })
    const second = await dispatchFork({ ...common, armNumber: 2, model: 'opus' })

    expect(first.forkId).toBe(forkId)
    expect(second.forkId).toBe(forkId)
    expect(first.arms.map((d) => d.arm)).toEqual([1])
    expect(second.arms.map((d) => d.arm)).toEqual([2])
    expect(second.arms[0]?.laneHandle).toBe(`${forkId}-arm-2`)
    expect(second.arms[0]?.event.payload.treatment.model).toBe('opus')
  })

  it('refuses arms × runs above the launch ceiling by name and override, before anything is restored (prd53 ruling 6)', async () => {
    await capture()
    expect(LAUNCH_CEILING_LANES).toBe(8)

    await expect(
      dispatchFork({
        parentLane: 'parent-lane',
        parentWorktreePath: repoDir,
        arms: 3,
        runs: 3,
        dataRoot,
        claudeProjectsRoot,
        exec: realExec,
        install: false,
      }),
    ).rejects.toThrow(/9 spending lane\(s\) .* the launch ceiling is 8 \(the default\) — pass --ceiling-override 9/)
    await expect(readdir(labWorktreesRoot(dataRoot))).rejects.toThrow(/ENOENT/)

    // An override that is still too low is refused the same way, naming the override as the ceiling.
    await expect(
      dispatchFork({
        parentLane: 'parent-lane',
        parentWorktreePath: repoDir,
        arms: 3,
        runs: 3,
        ceilingOverride: 8,
        dataRoot,
        claudeProjectsRoot,
        exec: realExec,
        install: false,
      }),
    ).rejects.toThrow(/the launch ceiling is 8 \(your override\)/)
  })

  it('a declared override lets the dispatch through and is recorded on EVERY fork.dispatched; none is recorded when the default held', async () => {
    await capture()
    const forkId = uniqueId('fork')

    const overridden = await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 1,
      runs: 2,
      ceilingOverride: 2,
      forkId,
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    })
    expect(overridden.arms.map((d) => d.event.payload.ceilingOverride)).toEqual([2, 2])

    const plain = await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 1,
      forkId: uniqueId('fork'),
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    })
    expect(plain.arms[0]?.event.payload).not.toHaveProperty('ceilingOverride')
  })

  it('records the proposal an experiment came from on EVERY arm, and leaves the key off entirely when a hand chose it (prd55 ruling 4)', async () => {
    await capture()

    const proposed = await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 1,
      runs: 2,
      proposalId: 'proposal-1',
      forkId: uniqueId('fork'),
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    })
    expect(proposed.arms.map((d) => d.event.payload.proposalId)).toEqual(['proposal-1', 'proposal-1'])

    // Absent, and ABSENT — not an empty string and not a null. The record has
    // to be able to say "nobody proposed this" without it reading like a
    // proposal that went missing.
    const byHand = await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 1,
      forkId: uniqueId('fork'),
      dataRoot,
      claudeProjectsRoot,
      exec: realExec,
      install: false,
      now: () => 1_000_100,
    })
    expect(byHand.arms[0]?.event.payload).not.toHaveProperty('proposalId')
  })

  it('refuses a zero, negative or fractional run count or arm number before anything is restored', async () => {
    await capture()
    for (const bad of [{ runs: 0 }, { runs: -1 }, { runs: 1.5 }, { armNumber: 0 }, { armNumber: 2.5 }]) {
      await expect(
        dispatchFork({
          parentLane: 'parent-lane',
          parentWorktreePath: repoDir,
          arms: 1,
          dataRoot,
          claudeProjectsRoot,
          exec: realExec,
          install: false,
          ...bad,
        }),
      ).rejects.toThrow(/invalid (run count|arm number)/)
    }
    await expect(readdir(labWorktreesRoot(dataRoot))).rejects.toThrow(/ENOENT/)
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

  it('an injected never-settling workmux launch rejects with a timeout rather than hanging (#8)', async () => {
    await capture()

    // The shape a real `exec` produces once its native timeout kills the
    // child (`failed: true`, `code: null`, no stderr — see
    // `describeExecFailure`, `server/exec.ts`), settling ONLY once
    // `options.timeoutMs` is set. Left unbounded this would hang forever,
    // exactly like a stuck `workmux add`; if `dispatchFork` did not route it
    // through `withTimeout`, this test would hang until its own timeout.
    const neverSettlingWorkmux: Exec = (command, args, options) => {
      if (command !== 'workmux') return realExec(command, args, options)
      if (options?.timeoutMs === undefined) return new Promise(() => {})
      return Promise.resolve({ stdout: '', stderr: '', code: null, failed: true })
    }

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
        exec: neverSettlingWorkmux,
      }),
    ).rejects.toThrow(/workmux add .* failed/)
  }, 2000)

  it('gives the restore its RESTORE_EXEC_TIMEOUT_MS ceiling through dispatchFork, not FORK_EXEC_TIMEOUT_MS (#123 review, Blocking 1 / #109)', async () => {
    // `withTimeout` always overrides `timeoutMs` — so whichever wrap sits
    // CLOSEST to the raw exec wins the value a subprocess actually sees.
    // `dispatchFork` used to wrap with `FORK_EXEC_TIMEOUT_MS` (5s) BEFORE
    // handing the exec down to `restoreCheckpoint`, which fixed every
    // restore call — including `npm install` — to 5s regardless of
    // `RESTORE_EXEC_TIMEOUT_MS` (120s). This goes through `dispatchFork`
    // itself, not `restoreWorkspace` directly, because the composition is
    // exactly what a direct call cannot exercise.
    await writeFile(
      path.join(repoDir, 'package.json'),
      `${JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }, null, 2)}\n`,
    )
    git(['add', 'package.json'])
    git(['commit', '-m', 'add package.json'])

    const seen: Array<{ command: string; args: readonly string[]; timeoutMs: number | undefined }> = []
    await capture()

    await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 1,
      forkId: uniqueId('fork'),
      dataRoot,
      claudeProjectsRoot,
      install: true,
      now: () => 1_000_100,
      exec: async (command, args, options) => {
        seen.push({ command, args, timeoutMs: options?.timeoutMs })
        if (command === 'npm') return { stdout: '', stderr: '', code: 0, failed: false }
        return realExec(command, args, options)
      },
    })

    // Matched on argv, not just on the binary: `dispatchFork` may grow a git
    // call of its own (5s-bounded, correctly) before the restore, and a bare
    // `command === 'git'` would then silently assert against THAT call
    // instead of the one this test is about.
    const npmCall = seen.find((call) => call.command === 'npm' && call.args[0] === 'install')
    const gitWorktreeAdd = seen.find((call) => call.command === 'git' && call.args[0] === 'worktree')
    expect(npmCall?.timeoutMs, 'npm install was not spawned').toBe(RESTORE_EXEC_TIMEOUT_MS)
    expect(gitWorktreeAdd?.timeoutMs, 'git worktree add was not spawned').toBe(RESTORE_EXEC_TIMEOUT_MS)
  })

  /**
   * #123's review pinned every `workmux` call to `FORK_EXEC_TIMEOUT_MS` — true
   * until #408: `workmux add` runs `.workmux.yaml`'s setup (`npm ci`), so a 5s
   * plumbing ceiling killed it mid-install on a cold cache (two panel launches,
   * both `exit null` at arm 1). The law now has two halves, proved
   * independently by reading each subprocess's OWN recorded `timeoutMs` off
   * the injected exec — never inferred from which constant the source
   * mentions — so a mutation that swaps which ceiling wraps which call site
   * fails on a NAMED call, not just "some workmux call was wrong".
   */
  it('gives `workmux add` FORK_LAUNCH_TIMEOUT_MS (it runs the setup) and keeps `workmux path` at the narrower FORK_EXEC_TIMEOUT_MS (plumbing) (#408)', async () => {
    await capture()
    const seen: Array<{ command: string; args: readonly string[]; timeoutMs: number | undefined }> = []

    await dispatchFork({
      parentLane: 'parent-lane',
      parentWorktreePath: repoDir,
      arms: 1,
      forkId: uniqueId('fork'),
      dataRoot,
      claudeProjectsRoot,
      install: false,
      launch: true,
      now: () => 1_000_100,
      exec: async (command, args, options) => {
        seen.push({ command, args, timeoutMs: options?.timeoutMs })
        if (command === 'workmux') return { stdout: '', stderr: '', code: 0, failed: false }
        return realExec(command, args, options)
      },
    })

    const addCall = seen.find((call) => call.command === 'workmux' && call.args[0] === 'add')
    const pathCall = seen.find((call) => call.command === 'workmux' && call.args[0] === 'path')
    expect(addCall?.timeoutMs, 'workmux add was not spawned').toBe(FORK_LAUNCH_TIMEOUT_MS)
    expect(pathCall?.timeoutMs, 'workmux path was not spawned').toBe(FORK_EXEC_TIMEOUT_MS)
    // Pinned as distinct numbers, dispatch's above plumbing's — a law that
    // could pass with the two ceilings equal would not be the law #408 asks for.
    expect(FORK_LAUNCH_TIMEOUT_MS).toBeGreaterThan(FORK_EXEC_TIMEOUT_MS)
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
