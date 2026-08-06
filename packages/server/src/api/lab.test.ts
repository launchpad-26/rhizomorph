import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Exec, ExecResult } from '@rhizomorph/core'
import { createEventFactory, eventsToJsonl } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { runCli } from '../cli/index.js'
import { sessionFileName } from '../log/paths.js'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { exec as realExec } from '../server/exec.js'
import { SessionRecorder } from '../server/recorder.js'
import { LaunchValidationError, estimateLaunchSpend, launchExperiment, parseSingleArmForkStdout } from './lab.js'

describe('GET /api/lab/checkpoints and /api/lab/experiments', () => {
  let repoPath: string
  let sessionDir: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-api-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-api-dir-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  it('reports no checkpoints and no experiments before the lab has ever run — an honest empty list, not an error', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const checkpoints = await app.inject({ method: 'GET', url: '/api/lab/checkpoints' })
    expect(checkpoints.statusCode).toBe(200)
    expect(checkpoints.json()).toEqual({ checkpoints: [] })

    const experiments = await app.inject({ method: 'GET', url: '/api/lab/experiments' })
    expect(experiments.statusCode).toBe(200)
    expect(experiments.json()).toEqual({ experiments: [] })
  })

  it('lists a checkpoint captured to disk in an earlier session', async () => {
    await mkdir(sessionDir, { recursive: true })
    const f = createEventFactory({ startTs: 1000 })
    f.forkCheckpoint({ lane: 'feature', checkpointId: 'ckpt-1', capturedBy: 'operator' })
    await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')

    const recorder = new SessionRecorder('2000', sessionFilePath(sessionDir, '2000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({ method: 'GET', url: '/api/lab/checkpoints' })
    expect(response.statusCode).toBe(200)
    const { checkpoints } = response.json() as { checkpoints: Array<Record<string, unknown>> }
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({
      lane: 'feature',
      checkpointId: 'ckpt-1',
      capturedBy: 'operator',
    })
  })

  it('reads a checkpoint straight from the live recorder buffer, never a stale disk read', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const f = createEventFactory({ startTs: 1000 })
    await recorder.record(f.forkCheckpoint({ lane: 'feature', checkpointId: 'ckpt-live' }))

    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })
    const response = await app.inject({ method: 'GET', url: '/api/lab/checkpoints' })

    const { checkpoints } = response.json() as { checkpoints: Array<{ checkpointId: string }> }
    expect(checkpoints.map((c) => c.checkpointId)).toEqual(['ckpt-live'])
  })

  it('groups arms by fork into one experiment each, sorted by arm number', async () => {
    await mkdir(sessionDir, { recursive: true })
    const f = createEventFactory({ startTs: 1000 })
    f.forkCheckpoint({ lane: 'feature', checkpointId: 'ckpt-1' })
    f.forkDispatched({
      forkId: 'fork-1',
      parentLane: 'feature',
      checkpointId: 'ckpt-1',
      arm: 2,
      treatment: { model: 'sonnet', promptDigest: null },
      laneHandle: 'fork-1-arm-2',
      worktreePath: '/data/lab/worktrees/fork-1-arm-2',
    })
    f.forkDispatched({
      forkId: 'fork-1',
      parentLane: 'feature',
      checkpointId: 'ckpt-1',
      arm: 1,
      treatment: { model: 'opus', promptDigest: 'a'.repeat(64) },
      laneHandle: 'fork-1-arm-1',
      worktreePath: '/data/lab/worktrees/fork-1-arm-1',
    })
    await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')

    const recorder = new SessionRecorder('2000', sessionFilePath(sessionDir, '2000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({ method: 'GET', url: '/api/lab/experiments' })
    expect(response.statusCode).toBe(200)
    const { experiments } = response.json() as {
      experiments: Array<{
        forkId: string
        parentLane: string
        checkpointId: string
        arms: Array<{ arm: number; treatment: { model: string | null; promptDigest: string | null } }>
      }>
    }

    expect(experiments).toHaveLength(1)
    const [experiment] = experiments
    expect(experiment?.forkId).toBe('fork-1')
    expect(experiment?.parentLane).toBe('feature')
    expect(experiment?.checkpointId).toBe('ckpt-1')
    expect(experiment?.arms.map((arm) => arm.arm)).toEqual([1, 2])
    expect(experiment?.arms[0]?.treatment).toEqual({ model: 'opus', promptDigest: 'a'.repeat(64) })
    expect(experiment?.arms[1]?.treatment).toEqual({ model: 'sonnet', promptDigest: null })
  })

  it('carries every recorded run of one arm, rather than collapsing repeats', async () => {
    await mkdir(sessionDir, { recursive: true })
    const f = createEventFactory({ startTs: 1000 })
    f.forkDispatched({
      forkId: 'fork-2',
      arm: 1,
      laneHandle: 'fork-2-arm-1',
      worktreePath: '/data/lab/worktrees/fork-2-arm-1',
    })
    f.forkDispatched({
      forkId: 'fork-2',
      arm: 1,
      laneHandle: 'fork-2-arm-1',
      worktreePath: '/data/lab/worktrees/fork-2-arm-1',
    })
    await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')

    const recorder = new SessionRecorder('2000', sessionFilePath(sessionDir, '2000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({ method: 'GET', url: '/api/lab/experiments' })
    const { experiments } = response.json() as { experiments: Array<{ arms: Array<{ runs: unknown[] }> }> }
    expect(experiments[0]?.arms).toHaveLength(1)
    expect(experiments[0]?.arms[0]?.runs).toHaveLength(2)
  })
})

describe('GET /api/lab/estimate (prd14 ruling 4 — an estimate never appears without its basis)', () => {
  let repoPath: string
  let sessionDir: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-estimate-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-estimate-dir-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  it('says the rate cannot be established for a lane with no recorded spend — never a fabricated or bare-zero number', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => 5_000_000 })

    const response = await app.inject({ method: 'GET', url: '/api/lab/estimate?lane=idle-lane&arms=3' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as Record<string, unknown>
    expect(body.available).toBe(false)
    expect(body.reason).toMatch(/idle-lane/)
    expect(body.costUsdPerHour).toBeUndefined()
    expect(body.estimatedTotalUsd).toBeUndefined()
  })

  it("derives the estimate from the forked lane's own recent rate, states the basis, and scales by arm count", async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const f = createEventFactory({ startTs: 5_000_000 - 10 * 60_000 })
    // $3.60 recorded inside the trailing hour -> $3.60/hr for THIS lane, over a 1-hour window.
    await recorder.record(f.llmCost({ lane: 'hot-lane', costUsd: 3.6, authoritative: true }))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => 5_000_000 })

    const response = await app.inject({ method: 'GET', url: '/api/lab/estimate?lane=hot-lane&arms=3' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as Record<string, number | boolean>
    expect(body.available).toBe(true)
    expect(body.windowMs).toBe(60 * 60_000)
    expect(body.costUsdPerHour).toBeCloseTo(3.6, 5)
    expect(body.estimatedTotalUsd).toBeCloseTo(3.6 * 3, 5)
  })

  it('400s without a lane or a positive integer arms count', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    expect((await app.inject({ method: 'GET', url: '/api/lab/estimate?arms=3' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/lab/estimate?lane=x&arms=0' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/lab/estimate?lane=x&arms=abc' })).statusCode).toBe(400)
  })
})

describe('estimateLaunchSpend unit shape', () => {
  it('is exercised end to end above via the route — this just pins the exported name stays a function', () => {
    expect(typeof estimateLaunchSpend).toBe('function')
  })
})

describe('parseSingleArmForkStdout', () => {
  it("reads forkId, checkpointId, laneHandle, worktreePath and 'launched' from a real single-arm dispatch's stdout", () => {
    const stdout = [
      'fork fork-abc123 — 1 arm(s) of lane "feature" restored from checkpoint ckpt-1',
      '  arm 1  fork-abc123-arm-1',
      '    worktree  /data/lab/worktrees/fork-abc123-arm-1',
      '    session   /home/x/.claude/projects/y/z.jsonl (12 lines, 3 paths rewritten to this tree)',
      '    launch    ran: workmux add fork-abc123-arm-1 -b -a "bash scripts/lane-agent.sh opus"',
      '',
      'Compare them with: rhizomorph lab compare fork-abc123 --path /repo',
    ].join('\n')

    expect(parseSingleArmForkStdout(stdout)).toEqual({
      forkId: 'fork-abc123',
      checkpointId: 'ckpt-1',
      laneHandle: 'fork-abc123-arm-1',
      worktreePath: '/data/lab/worktrees/fork-abc123-arm-1',
      launched: true,
    })
  })

  it("reads launched:false from the CLI's 'not run' wording (--launch omitted)", () => {
    const stdout = [
      'fork fork-xyz — 1 arm(s) of lane "feature" restored from checkpoint ckpt-1',
      '  arm 1  fork-xyz-arm-1',
      '    worktree  /data/lab/worktrees/fork-xyz-arm-1',
      '    session   /home/x/.claude/projects/y/z.jsonl (0 lines, 0 paths rewritten to this tree)',
      '    launch    not run — run it yourself: workmux add fork-xyz-arm-1 -b',
    ].join('\n')

    expect(parseSingleArmForkStdout(stdout)?.launched).toBe(false)
  })

  it('returns null on unrecognised output rather than guessing at a shape', () => {
    expect(parseSingleArmForkStdout('not the shape we expect')).toBeNull()
    expect(parseSingleArmForkStdout('')).toBeNull()
  })
})

describe('launchExperiment (prd14 ruling 2/4 — free-form arms, one dispatch per arm, real spend)', () => {
  let root: string
  let repoDir: string
  let dataRoot: string
  let claudeProjectsRoot: string

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
  }

  /** Real git, stubbed everything else — mirrors `lab/fork.test.ts`'s own `execWithStubs`: no test ever spawns workmux for real. */
  function execWithStubs(stub: (command: string, args: readonly string[]) => ExecResult | null): Exec {
    return async (command, args, options) => {
      const stubbed = stub(command, args)
      if (stubbed !== null) return stubbed
      return realExec(command, args, options)
    }
  }

  const OK: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-launch-unit-'))
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
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v2 dirty\n')

    const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir))
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      path.join(projectDir, `${randomUUID()}.jsonl`),
      `${JSON.stringify({ type: 'user', sessionId: randomUUID(), cwd: repoDir, message: 'go' })}\n`,
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** Thrown by the test's own `exit` stub to unwind `runCli` without touching the real process — mirrors `cli/index.test.ts`. */
  class CliDone {
    constructor(readonly code: number) {}
  }

  async function seedCheckpoint(lane: string, now: () => number): Promise<string> {
    const logLines: string[] = []
    const log = {
      log: (message?: unknown) => logLines.push(message === undefined ? '' : String(message)),
      warn: (message?: unknown) => logLines.push(message === undefined ? '' : String(message)),
    }
    let code = 0
    const exit = (c: number): never => {
      code = c
      throw new CliDone(c)
    }
    try {
      await runCli(['lab', 'checkpoint', lane, '--path', repoDir], {
        exec: realExec,
        dataRoot,
        claudeProjectsRoot,
        now,
        log,
        exit,
      })
    } catch (err) {
      if (!(err instanceof CliDone)) throw err
    }
    expect(code).toBe(0)
    const match = /^checkpoint (\S+) captured for lane/m.exec(logLines.join('\n'))
    const checkpointId = match?.[1]
    if (checkpointId === undefined) throw new Error(`could not seed a checkpoint — CLI said: ${logLines.join('\n')}`)
    return checkpointId
  }

  it('rejects a malformed request before touching the laboratory at all', async () => {
    await expect(launchExperiment({}, { repoPath: repoDir })).rejects.toThrow(LaunchValidationError)
    await expect(
      launchExperiment({ lane: '', checkpointId: 'x', arms: [{}] }, { repoPath: repoDir }),
    ).rejects.toThrow(/lane/)
    await expect(
      launchExperiment({ lane: 'x', checkpointId: '', arms: [{}] }, { repoPath: repoDir }),
    ).rejects.toThrow(/checkpointId/)
    await expect(launchExperiment({ lane: 'x', checkpointId: 'x', arms: [] }, { repoPath: repoDir })).rejects.toThrow(
      /arms/,
    )
    await expect(
      launchExperiment({ lane: 'x', checkpointId: 'x', arms: [{ model: 42 }] }, { repoPath: repoDir }),
    ).rejects.toThrow(/model/)
  })

  it('dispatches a single arm with its own model and brief, and reports it as launched', async () => {
    const checkpointId = await seedCheckpoint('lane-a', () => 1_000_000)
    const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))

    const result = await launchExperiment(
      { lane: 'lane-a', checkpointId, arms: [{ model: 'opus', brief: 'try the aggressive refactor' }] },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )

    expect(result.failed).toBeNull()
    expect(result.parentLane).toBe('lane-a')
    expect(result.checkpointId).toBe(checkpointId)
    expect(result.arms).toHaveLength(1)
    const [arm] = result.arms
    expect(arm?.arm).toBe(1)
    expect(arm?.model).toBe('opus')
    expect(arm?.briefProvided).toBe(true)
    expect(arm?.launched).toBe(true)
    expect(arm?.forkId).toMatch(/^fork-/)
    expect(arm?.worktreePath.startsWith(path.join(dataRoot, 'lab', 'worktrees'))).toBe(true)
  })

  it('an arm with neither model nor brief inherits the fleet default, honestly — null, never a guess', async () => {
    const checkpointId = await seedCheckpoint('lane-c', () => 1_000_000)
    const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))

    const result = await launchExperiment(
      { lane: 'lane-c', checkpointId, arms: [{}] },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )

    expect(result.failed).toBeNull()
    expect(result.arms[0]?.model).toBeNull()
    expect(result.arms[0]?.briefProvided).toBe(false)
  })

  it('dispatches free-form arms independently — each keeps its OWN model and brief, never one shared knob (ruling 2)', async () => {
    const checkpointId = await seedCheckpoint('lane-b', () => 1_000_000)
    const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))

    const result = await launchExperiment(
      {
        lane: 'lane-b',
        checkpointId,
        arms: [
          { model: 'opus', brief: 'brief X' },
          { model: 'sonnet', brief: 'brief Y' },
          { model: 'opus', brief: 'brief Y' },
        ],
      },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )

    expect(result.failed).toBeNull()
    expect(result.arms).toHaveLength(3)
    expect(result.arms.map((a) => a.arm)).toEqual([1, 2, 3])
    expect(result.arms.map((a) => a.model)).toEqual(['opus', 'sonnet', 'opus'])
    expect(result.arms.map((a) => a.briefProvided)).toEqual([true, true, true])
    // Each arm is its own independently-restored reality — never sharing a worktree or a fork id.
    expect(new Set(result.arms.map((a) => a.forkId)).size).toBe(3)
    expect(new Set(result.arms.map((a) => a.worktreePath)).size).toBe(3)
  })

  it("stops at the first failing arm and keeps what already dispatched — a fork's spend is real and is never discarded (prd12 ruling 3)", async () => {
    const checkpointId = await seedCheckpoint('lane-d', () => 1_000_000)
    let workmuxCalls = 0
    const exec = execWithStubs((command) => {
      if (command !== 'workmux') return null
      workmuxCalls += 1
      return workmuxCalls === 1 ? OK : { stdout: '', stderr: 'workmux: tmux server not running', code: 1, failed: true }
    })

    const result = await launchExperiment(
      { lane: 'lane-d', checkpointId, arms: [{ model: 'opus' }, { model: 'sonnet' }, { model: 'haiku' }] },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )

    expect(result.arms).toHaveLength(1)
    expect(result.arms[0]?.model).toBe('opus')
    expect(result.failed?.arm).toBe(2)
    expect(result.failed?.error).toMatch(/tmux server not running/)
  })

  it('a lane with no checkpoint at all fails the first arm outright, and dispatches nothing', async () => {
    const exec = execWithStubs(() => null)

    const result = await launchExperiment(
      { lane: 'never-checkpointed', checkpointId: 'nope', arms: [{}] },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )

    expect(result.arms).toHaveLength(0)
    expect(result.failed?.arm).toBe(1)
    expect(result.failed?.error).toMatch(/no checkpoint "nope"/)
  })
})

describe('POST /api/lab/launch (route wiring — validation and the read-only refusal never touch the laboratory)', () => {
  let repoPath: string
  let sessionDir: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-launch-route-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-launch-route-dir-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  it('400s a malformed body before ever touching the laboratory', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({
      method: 'POST',
      url: '/api/lab/launch',
      payload: { lane: '', checkpointId: 'x', arms: [{}] },
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: string }).error).toMatch(/lane/)
  })

  it('409s when this server is replaying a record instead of watching a repo — there is nothing live to fork', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, readOnly: true })

    const response = await app.inject({
      method: 'POST',
      url: '/api/lab/launch',
      payload: { lane: 'x', checkpointId: 'y', arms: [{ model: 'opus' }] },
    })
    expect(response.statusCode).toBe(409)
  })
})

describe("the lab launch path is reachable only from an explicit request (prd12 ruling 1's UI-button exception; prd14 direction)", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url))
  const SERVER_SRC = path.resolve(HERE, '..')
  const LAB_ROUTE_FILE = path.join(HERE, 'lab.ts')
  const LAB_ROUTE_TEST_FILE = path.join(HERE, 'lab.test.ts')

  function walkSourceFiles(dir: string): string[] {
    const out: string[] = []
    const visit = (current: string) => {
      let entries: string[]
      try {
        entries = readdirSync(current)
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist') continue
        const full = path.join(current, entry)
        if (statSync(full).isDirectory()) {
          visit(full)
          continue
        }
        if (/\.(ts|tsx)$/.test(full)) out.push(full)
      }
    }
    visit(dir)
    return out
  }

  const LAUNCH_ENTRY_RE = /\blaunchExperiment\b/

  it('api/lab.ts has no clock of its own — the launch route never fires without an incoming request', () => {
    const source = readFileSync(LAB_ROUTE_FILE, 'utf8')
    expect(/\b(setInterval|setTimeout|setImmediate)\s*\(/.test(source)).toBe(false)
  })

  it('that detector bites — a scheduled launch would be caught', () => {
    expect(
      /\b(setInterval|setTimeout|setImmediate)\s*\(/.test('setInterval(() => launchExperiment(x, y), 60_000)'),
    ).toBe(true)
  })

  it('no collector and no poll loop names the launch entry point — stated by name, not left to the sweep', () => {
    const shouldNeverLaunch = [
      path.join(SERVER_SRC, 'server', 'poll-loop.ts'),
      path.join(SERVER_SRC, 'collectors', 'sessionlog', 'collector.ts'),
      path.join(SERVER_SRC, 'collectors', 'git', 'git-collector.ts'),
    ]
    for (const file of shouldNeverLaunch) {
      expect(LAUNCH_ENTRY_RE.test(readFileSync(file, 'utf8')), `${file} reaches the launch entry point`).toBe(false)
    }
  })

  it('no source file outside api/lab.ts (and its own test) names the launch entry point at all', () => {
    const violations: string[] = []
    for (const file of walkSourceFiles(SERVER_SRC)) {
      const resolved = path.resolve(file)
      if (resolved === path.resolve(LAB_ROUTE_FILE) || resolved === path.resolve(LAB_ROUTE_TEST_FILE)) continue
      if (LAUNCH_ENTRY_RE.test(readFileSync(file, 'utf8'))) violations.push(path.relative(SERVER_SRC, file))
    }
    expect(violations).toEqual([])
  })

  it('the launch route is wired on POST, never GET — a GET is triggerable by anything with network access; a POST behind a confirm dialog is not', () => {
    const source = readFileSync(LAB_ROUTE_FILE, 'utf8')
    expect(source).toMatch(/app\.post\('\/api\/lab\/launch'/)
    expect(source).not.toMatch(/app\.get\('\/api\/lab\/launch'/)
  })
})
