import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, ExecResult } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { exec as realExec } from '../server/exec.js'
import { captureCheckpoint } from './checkpoint.js'
import {
  compareFork,
  COMPARE_EXEC_TIMEOUT_MS,
  COMPARE_VERIFY_TIMEOUT_MS,
  MIN_ARMS_TO_RANK,
  renderComparison,
  type ForkComparison,
  type VerifiedOutcome,
} from './compare.js'
import { dispatchFork } from './fork.js'

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

const OK: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-compare-test-'))
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

  const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir))
  await mkdir(projectDir, { recursive: true })
  const sessionId = randomUUID()
  await writeFile(
    path.join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', sessionId, cwd: repoDir })}\n`,
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Captures a checkpoint and dispatches `arms` restored arms from it. Returns the forkId. */
async function forkWith(arms: number): Promise<string> {
  await captureCheckpoint({
    lane: 'parent-lane',
    worktreePath: repoDir,
    capturedBy: 'operator',
    exec: realExec,
    dataRoot,
    claudeProjectsRoot,
    now: () => 1_000_000,
    checkpointId: uniqueId('ckpt'),
  })
  const forkId = uniqueId('fork')
  await dispatchFork({
    parentLane: 'parent-lane',
    parentWorktreePath: repoDir,
    arms,
    forkId,
    model: 'opus',
    dataRoot,
    claudeProjectsRoot,
    exec: realExec,
    install: false,
    now: () => 1_000_100,
  })
  return forkId
}

/** Real git, a scripted verify command. */
function execWithVerify(verdicts: Record<string, ExecResult>): Exec {
  return async (command, args, options) => {
    if (command === 'fake-gate') {
      return verdicts[String(options?.cwd ?? '')] ?? OK
    }
    return realExec(command, args, options)
  }
}

/**
 * Real git, a verify command that never settles unless `options.timeoutMs`
 * is set — the shape a real `exec` produces once its native timeout kills
 * the child (`failed: true`, `code: null`, no stderr — see
 * `describeExecFailure`, `server/exec.ts`). Left unbounded this would hang
 * forever, exactly like a stuck gate command; if `compareFork` did not route
 * it through `withTimeout`, this test would hang until its own timeout.
 */
function neverSettlingUnlessBoundedVerify(command: string): Exec {
  return (cmd, args, options) => {
    if (cmd !== command) return realExec(cmd, args, options)
    if (options?.timeoutMs === undefined) return new Promise(() => {})
    return Promise.resolve({ stdout: '', stderr: '', code: null, failed: true })
  }
}

describe('compareFork', () => {
  it('reports one row per arm, in arm order, with the treatment the log recorded', async () => {
    const forkId = await forkWith(3)

    const comparison = await compareFork({
      forkId,
      parentWorktreePath: repoDir,
      dataRoot,
      skipVerify: true,
      exec: realExec,
    })

    expect(comparison.arms.map((arm) => arm.arm)).toEqual([1, 2, 3])
    expect(comparison.parentLane).toBe('parent-lane')
    for (const arm of comparison.arms) {
      expect(arm.model).toBe('opus')
      expect(arm.verified).toBe('not-run')
    }
  })

  it('runs the gate command in each arm\'s own worktree and reports pass/fail honestly', async () => {
    const forkId = await forkWith(3)
    const listing = await compareFork({ forkId, parentWorktreePath: repoDir, dataRoot, skipVerify: true, exec: realExec })
    const [first, second, third] = listing.arms
    if (!first || !second || !third) throw new Error('expected three arms')

    const comparison = await compareFork({
      forkId,
      parentWorktreePath: repoDir,
      dataRoot,
      verifyCommand: 'fake-gate --ci',
      exec: execWithVerify({
        [first.worktreePath]: OK,
        [second.worktreePath]: { stdout: '', stderr: '3 tests failed\nstack…', code: 1, failed: true },
        [third.worktreePath]: OK,
      }),
    })

    expect(comparison.arms.map((arm) => arm.verified)).toEqual(['pass', 'fail', 'pass'])
    expect(comparison.arms[1]?.verifiedDetail).toBe('3 tests failed')
  })

  it('calls a missing gate binary "not-run", never "fail" — a tooling gap is not the arm\'s result', async () => {
    const forkId = await forkWith(3)

    // An ABSOLUTE path under this test's own root, never a bare name. `execvp`
    // searches $PATH only for a command with no slash in it, and a miss is the
    // one outcome that walks *every* entry before failing — so a bare name
    // prices this test at (entries in $PATH) x (per-entry latency), neither of
    // which it controls. That is what timed it out under concurrency (#497):
    // once per arm, on a box whose $PATH was mostly directories on a foreign
    // filesystem that slows down under load. This root is `mkdtemp`'d by
    // `beforeEach` and holds no binary, so it is still a real spawn and a real
    // ENOENT out of the real `exec` — just one that stats a single path.
    // Keeping it inside the root also makes "missing" true by construction
    // rather than an assumption about what the host has installed.
    const missingGate = path.join(root, 'no-such-gate-binary')

    const comparison = await compareFork({
      forkId,
      parentWorktreePath: repoDir,
      dataRoot,
      verifyCommand: missingGate,
      exec: realExec,
    })

    for (const arm of comparison.arms) {
      expect(arm.verified).toBe('not-run')
      // Not-run *because the binary could not be spawned* — `--no-verify` also
      // reports 'not-run', so the outcome alone cannot tell a tooling gap from
      // a skipped gate. The detail is what distinguishes them.
      expect(arm.verifiedDetail).toContain('ENOENT')
    }
  })

  it('counts the commits an arm made on top of its restored snapshot', async () => {
    const forkId = await forkWith(2)
    const listing = await compareFork({ forkId, parentWorktreePath: repoDir, dataRoot, skipVerify: true, exec: realExec })
    const first = listing.arms[0]
    if (!first) throw new Error('expected an arm')

    // Arm 1 does two commits of work; arm 2 does none.
    for (const n of [1, 2]) {
      await writeFile(path.join(first.worktreePath, `work-${n}.txt`), `${n}\n`)
      git(['add', '.'], first.worktreePath)
      git(['commit', '-m', `work ${n}`], first.worktreePath)
    }

    const comparison = await compareFork({ forkId, parentWorktreePath: repoDir, dataRoot, skipVerify: true, exec: realExec })
    expect(comparison.arms[0]?.commits).toBe(2)
    expect(comparison.arms[1]?.commits).toBe(0)
  })

  it('refuses an unknown fork id, naming what to do about it', async () => {
    await forkWith(1)
    await expect(
      compareFork({ forkId: 'no-such-fork', parentWorktreePath: repoDir, dataRoot, skipVerify: true, exec: realExec }),
    ).rejects.toThrow(/no fork "no-such-fork" recorded/)
  })

  it('marks a fork rankable only at three arms or more', async () => {
    const twoArms = await forkWith(2)
    const threeArms = await forkWith(3)

    const two = await compareFork({ forkId: twoArms, parentWorktreePath: repoDir, dataRoot, skipVerify: true, exec: realExec })
    const three = await compareFork({ forkId: threeArms, parentWorktreePath: repoDir, dataRoot, skipVerify: true, exec: realExec })

    expect(two.rankable).toBe(false)
    expect(three.rankable).toBe(true)
    expect(MIN_ARMS_TO_RANK).toBe(3)
  })

  it('an injected never-settling verify command makes compareFork report a timeout rather than hang (#8)', async () => {
    const forkId = await forkWith(3)

    const comparison = await compareFork({
      forkId,
      parentWorktreePath: repoDir,
      dataRoot,
      verifyCommand: 'fake-gate --ci',
      exec: neverSettlingUnlessBoundedVerify('fake-gate'),
    })

    for (const arm of comparison.arms) {
      expect(arm.verified).toBe('fail')
      // Not `'exit null'` — that spelling cannot tell "a hung command was
      // correctly killed" from "every real command is killed" (PR #123
      // review, Blocking 2), which is exactly the shape this test's mock
      // produces (`code: null`, no stderr, no stdout). `describeExecFailure`
      // names the timeout instead.
      expect(arm.verifiedDetail).toBe('killed with no exit code — the exec timeout')
    }
  }, 2000)

  it('gives the verify command COMPARE_VERIFY_TIMEOUT_MS, not the 5s git-plumbing COMPARE_EXEC_TIMEOUT_MS (#123 review, Blocking 2)', async () => {
    const forkId = await forkWith(1)
    const seen: Array<{ command: string; args: readonly string[]; timeoutMs: number | undefined }> = []

    await compareFork({
      forkId,
      parentWorktreePath: repoDir,
      dataRoot,
      verifyCommand: 'fake-gate --ci',
      exec: async (command, args, options) => {
        seen.push({ command, args, timeoutMs: options?.timeoutMs })
        if (command === 'fake-gate') return OK
        return realExec(command, args, options)
      },
    })

    // Both really were spawned, so this cannot pass vacuously.
    const verifyCall = seen.find((call) => call.command === 'fake-gate')
    const gitCall = seen.find((call) => call.command === 'git' && call.args[0] === 'rev-list')
    expect(verifyCall?.timeoutMs, 'the verify command was not spawned').toBe(COMPARE_VERIFY_TIMEOUT_MS)
    expect(gitCall?.timeoutMs, 'the git plumbing call was not spawned').toBe(COMPARE_EXEC_TIMEOUT_MS)
  })
})

// --- the table (prd12 rulings 4 and 6) ---------------------------------------------

function comparisonOf(count: number, overrides: Partial<ForkComparison> = {}): ForkComparison {
  const arms = Array.from({ length: count }, (_unused, index) => ({
    arm: index + 1,
    laneHandle: `fork-x-arm-${index + 1}`,
    worktreePath: `/data/lab/worktrees/fork-x/arm-${index + 1}`,
    model: index === 0 ? null : 'opus',
    promptDigest: index === 0 ? null : 'a'.repeat(64),
    verified: (index === 1 ? 'fail' : 'pass') as VerifiedOutcome,
    verifiedDetail: index === 1 ? '1 test failed' : null,
    costUsd: 0.25 * (index + 1),
    durationMs: 60_000 * (index + 1),
    commits: index + 1,
  }))
  return {
    forkId: 'fork-x',
    parentLane: 'parent-lane',
    checkpointId: 'ckpt-x',
    arms,
    rankable: count >= MIN_ARMS_TO_RANK,
    verifyCommand: 'npm test',
    ...overrides,
  }
}

describe('renderComparison (prd12 ruling 6 — a table, not a visualization)', () => {
  it('prints every column the ruling names, one row per arm', () => {
    const table = renderComparison(comparisonOf(3))
    for (const heading of ['arm', 'lane', 'treatment', 'verified', 'cost', 'duration', 'commits']) {
      expect(table).toContain(heading)
    }
    expect(table).toContain('fork-x-arm-1')
    expect(table).toContain('fork-x-arm-2')
    expect(table).toContain('fork-x-arm-3')
    expect(table).toContain('$0.2500')
    expect(table).toContain('1m00s')
  })

  it('keeps rows in arm order even when a later arm is cheaper — a sorted table is a ranking', () => {
    const comparison = comparisonOf(3)
    const third = comparison.arms[2]
    if (third) third.costUsd = 0.0001
    const rows = renderComparison(comparison)
      .split('\n')
      .filter((line) => /^\d/.test(line))
    expect(rows.map((row) => row.trim()[0])).toEqual(['1', '2', '3'])
  })

  it('names no winner at three arms — it reports a distribution instead', () => {
    const table = renderComparison(comparisonOf(3))
    expect(table).toContain('distribution over 3 arms')
    expect(table).toContain('verified 2/3')
    expect(table).toContain('min')
    expect(table).toContain('median')
    expect(table).toContain('max')
    expect(table).toContain('no winner is named')
    expect(table.toLowerCase()).not.toContain('winner:')
    expect(table.toLowerCase()).not.toContain('best')
  })

  it('REFUSES to rank below three arms, printing the runs and saying why', () => {
    const table = renderComparison(comparisonOf(2))
    expect(table).toContain('fork-x-arm-1')
    expect(table).toContain('fork-x-arm-2')
    expect(table).toContain('runs only')
    expect(table).toContain(`Ranking needs n >= ${MIN_ARMS_TO_RANK}`)
    expect(table).not.toContain('distribution over')
  })

  it('refuses to rank a single arm too', () => {
    const table = renderComparison(comparisonOf(1))
    expect(table).toContain('runs only')
    expect(table).not.toContain('distribution over')
  })

  it('shows an unmeasured cost or duration as a dash, never as zero', () => {
    const comparison = comparisonOf(3)
    const first = comparison.arms[0]
    if (first) {
      first.costUsd = null
      first.durationMs = null
      first.commits = null
    }
    const table = renderComparison(comparison)
    expect(table).toContain('—')
    expect(table).not.toContain('$0.0000')
  })

  it('says how many arms went unjudged rather than counting them as failures', () => {
    const comparison = comparisonOf(3)
    const third = comparison.arms[2]
    if (third) {
      third.verified = 'not-run'
      third.verifiedDetail = '--no-verify'
    }
    const table = renderComparison(comparison)
    expect(table).toContain('verified 1/2')
    expect(table).toContain('(1 not run)')
  })
})
