import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Exec, ExecResult } from '@rhizomorph/core'
import {
  CONFOUND_VOICE,
  COUNTERFACTUAL_CLAUSE,
  canRankArms,
  canSummariseArm,
  MIN_COMPLETED_RUNS_TO_SUMMARISE,
} from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { exec as realExec } from '../server/exec.js'
import { captureCheckpoint } from './checkpoint.js'
import {
  COMPARE_EXEC_TIMEOUT_MS,
  COMPARE_VERIFY_TIMEOUT_MS,
  compareFork,
  type ForkComparison,
  MIN_ARMS_TO_RANK,
  renderComparison,
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

/** Captures a checkpoint and dispatches `arms` restored arms (each with `runs` runs) from it. Returns the forkId. */
async function forkWith(arms: number, runs = 1): Promise<string> {
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
    runs,
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

  it('three runs of ONE arm are three rows and not rankable — arms gate a cross-arm claim, never the row count (prd53 ruling 2)', async () => {
    const forkId = await forkWith(1, 3)

    const comparison = await compareFork({ forkId, parentWorktreePath: repoDir, dataRoot, skipVerify: true, exec: realExec })

    expect(comparison.arms).toHaveLength(3)
    expect(comparison.arms.map((row) => [row.arm, row.run])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ])
    expect(comparison.armCount).toBe(1)
    expect(comparison.rankable).toBe(false)
    expect(comparison.rankable).toBe(canRankArms(comparison.armCount))
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
    run: 1,
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
    armCount: count,
    rankable: canRankArms(count),
    verifyCommand: 'npm test',
    ...overrides,
  }
}

/** One arm, `runs` rows of it — `measured` of them verified, the rest not run. */
function oneArmWithRuns(runs: number, measured: number): ForkComparison {
  const rows = Array.from({ length: runs }, (_unused, index) => ({
    arm: 1,
    run: index + 1,
    laneHandle: index === 0 ? 'fork-x-arm-1' : `fork-x-arm-1-run-${index + 1}`,
    worktreePath: index === 0 ? '/data/lab/worktrees/fork-x-arm-1' : `/data/lab/worktrees/fork-x-arm-1-run-${index + 1}`,
    model: 'opus',
    promptDigest: 'a'.repeat(64),
    verified: (index < measured ? 'pass' : 'not-run') as VerifiedOutcome,
    verifiedDetail: index < measured ? null : '--no-verify',
    costUsd: 0.1 * (index + 1),
    durationMs: 1000 * (index + 1),
    commits: 1,
  }))
  return {
    forkId: 'fork-x',
    parentLane: 'parent-lane',
    checkpointId: 'ckpt-x',
    arms: rows,
    armCount: 1,
    rankable: canRankArms(1),
    verifyCommand: 'npm test',
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

  it('speaks the confound clause, in core\'s words, when arms differ in model AND brief — and stays silent when only one varies (prd53 ruling 2)', () => {
    // The fixture's arm 1 is a control (null model, no prompt) beside opus
    // arms with a prompt: both dimensions vary.
    expect(renderComparison(comparisonOf(3))).toContain(CONFOUND_VOICE)
    expect(renderComparison(comparisonOf(2))).toContain(CONFOUND_VOICE)

    const modelOnly = comparisonOf(3)
    for (const [index, row] of modelOnly.arms.entries()) {
      row.model = index === 0 ? 'sonnet' : 'opus'
      row.promptDigest = 'a'.repeat(64)
    }
    expect(renderComparison(modelOnly)).not.toContain(CONFOUND_VOICE)
    expect(renderComparison(modelOnly)).not.toContain('cannot be attributed')
  })

  it('below the floor it states the counterfactual clause — one observation, not a distribution', () => {
    expect(renderComparison(comparisonOf(2))).toContain(COUNTERFACTUAL_CLAUSE)
    expect(renderComparison(comparisonOf(3))).not.toContain(COUNTERFACTUAL_CLAUSE)
  })

  it('once an arm holds more than one run, each arm gets core\'s summary verdict over its MEASURED runs', () => {
    const enough = renderComparison(oneArmWithRuns(3, 3))
    expect(enough).toContain('arm 1: 3 run(s), 3 measured — a summary may be stated')
    expect(enough).toContain('1 arm(s), 3 run(s) of lane')

    const short = renderComparison(oneArmWithRuns(3, 2))
    expect(short).toContain(`arm 1: 3 run(s), 2 measured — no summary — ${COUNTERFACTUAL_CLAUSE}`)
    expect(short).toContain(`needs ${MIN_COMPLETED_RUNS_TO_SUMMARISE} measured`)

    // A single-run fork prints no per-arm lines at all — its output is what it always was.
    expect(renderComparison(comparisonOf(3))).not.toContain('measured —')
  })
})

describe('the floor has exactly one implementation (prd53 ruling 2)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const compareSource = readFileSync(path.join(here, 'compare.ts'), 'utf8')
  const summariseSource = readFileSync(path.resolve(here, '../../../web/src/lab/compare/summarise.ts'), 'utf8')

  it('both surfaces import the floor from core — the CLI table and the console summariser', () => {
    expect(compareSource).toMatch(/import \{[^}]*\bcanRankArms\b[^}]*\} from '@rhizomorph\/core'/s)
    expect(compareSource).toMatch(/import \{[^}]*\bcanSummariseArm\b[^}]*\} from '@rhizomorph\/core'/s)
    expect(summariseSource).toMatch(/import \{[^}]*\bcanSummariseArm\b[^}]*\} from '@rhizomorph\/core'/s)
  })

  it('neither surface restates the number locally — no `MIN_… = 3`, no `.length < 3` — the mutation this law exists to catch', () => {
    for (const [name, source] of [
      ['compare.ts', compareSource],
      ['summarise.ts', summariseSource],
    ] as const) {
      expect(source, `${name} defines a local floor constant`).not.toMatch(/MIN_[A-Z_]*(?:RANK|SUMMARISE)[A-Z_]*\s*=\s*\d/)
      expect(source, `${name} compares a length against a literal floor`).not.toMatch(/\.length\s*(?:<|>=|>|<=|===)\s*3\b/)
    }
  })

  it('the two consumers walk the same truth table — the fixture summarise.test.ts walks, verdict for verdict', () => {
    for (let completed = 0; completed <= MIN_COMPLETED_RUNS_TO_SUMMARISE + 1; completed += 1) {
      const table = renderComparison(oneArmWithRuns(MIN_COMPLETED_RUNS_TO_SUMMARISE + 1, completed))
      expect(table.includes('a summary may be stated'), `completed=${completed}`).toBe(canSummariseArm(completed))
    }
  })
})
