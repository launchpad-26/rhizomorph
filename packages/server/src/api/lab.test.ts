import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Exec, ExecResult } from '@rhizomorph/core'
import { createEventFactory, eventsToJsonl } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { runCli } from '../cli/index.js'
import { sessionFileName } from '../log/paths.js'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { exec as realExec } from '../server/exec.js'
import { SessionRecorder } from '../server/recorder.js'
import {
  LAB_CLI_LOCK_CEILING_MS,
  LabCliLockCeilingError,
  LaunchValidationError,
  MAX_ARMS,
  MODEL_GRAMMAR,
  estimateLaunchSpend,
  launchExperiment,
  parseSingleArmForkStdout,
} from './lab.js'
import { CAPABILITY_TOKEN_HEADER } from './security.js'
import { capabilityHeaders } from './test-support.js'

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

    const checkpoints = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/checkpoints' })
    expect(checkpoints.statusCode).toBe(200)
    expect(checkpoints.json()).toEqual({ checkpoints: [] })

    const experiments = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/experiments' })
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

    const response = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/checkpoints' })
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
    const response = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/checkpoints' })

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

    const response = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/experiments' })
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

    const response = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/experiments' })
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

    const response = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/estimate?lane=idle-lane&arms=3' })
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

    const response = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/estimate?lane=hot-lane&arms=3' })
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

    expect((await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/estimate?arms=3' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/estimate?lane=x&arms=0' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/estimate?lane=x&arms=abc' })).statusCode).toBe(400)
  })
})

describe('estimateLaunchSpend unit shape', () => {
  it('is exercised end to end above via the route — this just pins the exported name stays a function', () => {
    expect(typeof estimateLaunchSpend).toBe('function')
  })

  // #246 — before `buildFleet` moved to `@rhizomorph/core`, this file could not
  // import it (server may not depend on web) and re-derived one lane's spend
  // rate with its own `reduceAll` + `selectSpendRateByLane` instead of asking
  // the one fleet object buildFleet already answers the same question for
  // (`Burn.costUsdPerHour`). A grep-style pin, legible by eye like this
  // package's other namespace/law tests: the re-fold must not come back.
  it('reads the launch estimate off buildFleet, never re-folding with its own selectSpendRateByLane call', () => {
    const source = readFileSync(fileURLToPath(new URL('./lab.ts', import.meta.url)), 'utf8')
    expect(source).toMatch(/\bbuildFleet\(/)
    // Source-text grep, comments included (review of #499, item 4): a doc
    // comment merely NAMING the old selector reds this pin — deliberate, the
    // cheap spelling of "the re-fold stays gone", priced against the false
    // red being a one-word rewording. lab.ts's own comments already say
    // "its own spend-rate selector call" for exactly this reason.
    expect(source).not.toMatch(/\bselectSpendRateByLane\b/)
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

  /**
   * prd41 ruling 4 — the arm-count ceiling, at the entry point: refused
   * before anything is dispatched. `exec` fails the test if anything is
   * executed, the same proof `MODEL_GRAMMAR`'s refusal above already uses.
   */
  it(`refuses more than MAX_ARMS (${MAX_ARMS}) arms before touching the laboratory at all`, async () => {
    const neverRuns: Exec = async (command, argv) => {
      throw new Error(`nothing should have been executed, but got: ${command} ${argv.join(' ')}`)
    }
    const arms = Array.from({ length: MAX_ARMS + 1 }, () => ({}))

    await expect(
      launchExperiment({ lane: 'x', checkpointId: 'y', arms }, { repoPath: repoDir, exec: neverRuns }),
    ).rejects.toThrow(new RegExp(`may not exceed ${MAX_ARMS}`))
  })

  /** The other side of the ceiling: exactly MAX_ARMS is not refused. */
  it(`dispatches exactly MAX_ARMS (${MAX_ARMS}) arms — the ceiling itself is accepted`, async () => {
    const checkpointId = await seedCheckpoint('lane-ceiling', () => 1_000_000)
    const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))
    const arms = Array.from({ length: MAX_ARMS }, () => ({ model: 'opus' }))

    const result = await launchExperiment(
      { lane: 'lane-ceiling', checkpointId, arms },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )

    expect(result.failed).toBeNull()
    expect(result.arms).toHaveLength(MAX_ARMS)
  })

  /**
   * `withLabCliLock`'s module-level queue outlives any one test — a genuinely
   * never-settling `exec` would leave every LATER test in this file (and the
   * route describe block below) queued forever behind it. This gate stays
   * pending for exactly as long as the test needs it wedged, and is always
   * released (and drained) before the test returns, so the lock is clear for
   * whatever runs next.
   */
  function hangingExecGate(): { exec: Exec; release: () => void } {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const exec: Exec = async () => {
      await gate
      return OK
    }
    return { exec, release }
  }

  /**
   * prd41 ruling 2 — the lock ceiling. A first launch's `exec` does not
   * resolve, so `withLabCliLock` does not clear; a second launch queued
   * behind it must refuse once it has waited past the ceiling, not hang
   * forever. `lockCeilingMs` is a test seam (production takes the default);
   * `vi.useFakeTimers` fires that ceiling deterministically, mirroring
   * `poll-loop.test.ts`'s own watchdog tests rather than a real wait.
   */
  it('a second launch queued behind a wedged lock refuses with LabCliLockCeilingError, naming what it waited on, rather than hanging', async () => {
    vi.useFakeTimers()
    try {
      const checkpointId = await seedCheckpoint('lane-wedged', () => 1_000_000)
      const { exec: hangingExec, release } = hangingExecGate()

      const first = launchExperiment(
        { lane: 'lane-wedged', checkpointId, arms: [{ model: 'opus' }] },
        { repoPath: repoDir, exec: hangingExec, dataRoot, claudeProjectsRoot, now: () => 2_000_000, lockCeilingMs: 30_000 },
      )
      // Let `first` actually take the lock (its own `withLabCliLock` call
      // resolves an already-settled `previous` via a microtask) before
      // `second` reads what it's waiting on — otherwise `second` can be
      // constructed in the same tick, before `first` has claimed the label.
      await Promise.resolve()
      await Promise.resolve()

      try {
        const second = launchExperiment(
          { lane: 'lane-wedged', checkpointId, arms: [{ model: 'sonnet' }] },
          { repoPath: repoDir, exec: hangingExec, dataRoot, claudeProjectsRoot, now: () => 2_000_000, lockCeilingMs: 30_000 },
        )
        const assertion = expect(second).rejects.toThrow(LabCliLockCeilingError)
        await vi.advanceTimersByTimeAsync(30_000)
        await assertion

        // Naming what it waited on: the first arm's own diagnostic label.
        await expect(second).rejects.toThrow(/arm 1 for lane "lane-wedged"/)
      } finally {
        // Let the wedged call (and anything still queued behind it) actually
        // finish, so the module-level lock is clear before the next test runs.
        release()
        await first.catch(() => {})
      }
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * The other half of "refuse, never queue" (prd41 ruling 2): a caller that
   * gave up must never reach `exec` at all once its own turn arrives, even
   * after the holder it was waiting on eventually clears. The test above only
   * asserts `second`'s own promise rejects — that rejection is guaranteed by
   * `Promise.race` regardless of whether `withLabCliLock` still runs `fn` for
   * `second` afterward. This counts real invocations of the underlying `exec`
   * instead, which is what would actually change if `withLabCliLock`'s
   * `gaveUp` guard were removed: a refused caller's own `runLabCliOnce` would
   * still run once the queue reaches its turn, spending real money nobody was
   * watching for — the exact failure prd41 ruling 2 exists to close.
   */
  it(
    'a caller that gave up never reaches exec, even after the holder it waited on finally clears',
    async () => {
      const checkpointId = await seedCheckpoint('lane-wedged-noop', () => 1_000_000)

      // `first` and `second` each get their OWN exec/counter — `first`
      // legitimately makes several exec calls once unblocked (git, npm,
      // workmux, ...), so a single shared counter can't tell "first kept
      // going" apart from "second ran too." Only `secondExecCalls` matters.
      let firstExecCalls = 0
      let releaseFirst = () => {}
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const firstExec: Exec = async () => {
        firstExecCalls += 1
        await firstGate
        return OK
      }

      let secondExecCalls = 0
      const secondExec: Exec = async () => {
        secondExecCalls += 1
        return OK
      }

      const first = launchExperiment(
        { lane: 'lane-wedged-noop', checkpointId, arms: [{ model: 'opus' }] },
        { repoPath: repoDir, exec: firstExec, dataRoot, claudeProjectsRoot, now: () => 2_000_000, lockCeilingMs: 100 },
      )

      // Real, generously-bounded wait — NOT fake-timer ticks — for `first` to
      // actually reach its first exec call and hang there. Getting there
      // involves real subprocess/filesystem work (checkpoint resolution, git
      // worktree add) whose duration varies with machine load; a fixed
      // fake-timer tick count is not a reliable proxy for "enough real time
      // has passed" and was measured flaky under CI load (#10's own PR CI).
      const reachedExecDeadline = Date.now() + 10_000
      while (firstExecCalls === 0 && Date.now() < reachedExecDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(firstExecCalls).toBeGreaterThan(0)

      // Fake timers are scoped tightly to JUST the ceiling race below — a
      // fast, deterministic 100ms of simulated time with no real I/O
      // dependency — so a hang here can't leak fake timers into later tests
      // in this file the way the unscoped version once did.
      vi.useFakeTimers()
      try {
        // A small, real lock ceiling (100ms) — far below the 5000ms per-exec
        // `withTimeout` ceiling #8 wires into this same call chain
        // (`fork.ts`'s `FORK_EXEC_TIMEOUT_MS`). A 30s ceiling here would let
        // that unrelated, shorter, per-exec timeout fire first once fake time
        // is advanced past it, unwinding `first`'s hang on its own and
        // confounding what this test means to isolate: `withLabCliLock`'s
        // OWN ceiling, not the exec-level one.
        const second = launchExperiment(
          { lane: 'lane-wedged-noop', checkpointId, arms: [{ model: 'sonnet' }] },
          { repoPath: repoDir, exec: secondExec, dataRoot, claudeProjectsRoot, now: () => 2_000_000, lockCeilingMs: 100 },
        )
        const assertion = expect(second).rejects.toThrow(LabCliLockCeilingError)
        await vi.advanceTimersByTimeAsync(100)
        await assertion
      } finally {
        vi.useRealTimers()
      }

      // `second` gave up without ever reaching its own exec.
      expect(secondExecCalls).toBe(0)

      // Let `first` clear (and anything genuinely still queued behind it) —
      // a caller that already gave up must not run now that its turn has
      // actually arrived, which is exactly what a missing `gaveUp` guard in
      // `withLabCliLock` would let happen. `first` itself may keep calling
      // its own exec freely now — irrelevant to what this checks. Real,
      // generously-bounded wait again, for the same reason as above.
      releaseFirst()
      await first.catch(() => {})
      // A short real delay for anything chained behind `first`'s own
      // settlement (the queue's `.then` reassignment) to actually run —
      // not a fixed multi-second sleep, since `first` has already settled
      // by this point and nothing further here depends on real subprocess
      // I/O.
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(secondExecCalls).toBe(0)
    },
    20_000,
  )

  /**
   * The same scenario, over the actual route this ceiling protects — a real
   * `POST /api/lab/launch` must 503 rather than hang. The route has no seam
   * to inject a hung `exec` of its own, so the occupying call reaches the lab
   * CLI lock directly (it is process-wide, not per-request) — the same lock
   * `registerLabRoutes` below serialises every launch through. The queued
   * HTTP request never has its own `exec` reached at all: it gives up before
   * its turn arrives, which is the whole point of "refuse, never queue."
   */
  it('a second POST /api/lab/launch 503s rather than hangs behind a wedged lock (prd41 ruling 2)', async () => {
    vi.useFakeTimers()
    const sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-lock-route-dir-'))
    try {
      const checkpointId = await seedCheckpoint('lane-wedged-route', () => 1_000_000)
      const { exec: hangingExec, release } = hangingExecGate()

      const occupying = launchExperiment(
        { lane: 'lane-wedged-route', checkpointId, arms: [{ model: 'opus' }] },
        { repoPath: repoDir, exec: hangingExec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
      )

      try {
        const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
        const app = buildApp({ repoPath: repoDir, repoName: 'repo', sessionDir, recorder })

        const responsePromise = app.inject({
          method: 'POST',
          url: '/api/lab/launch',
          headers: { [CAPABILITY_TOKEN_HEADER]: app.capabilityToken },
          payload: { lane: 'lane-wedged-route', checkpointId, arms: [{ model: 'sonnet' }] },
        })

        await vi.advanceTimersByTimeAsync(LAB_CLI_LOCK_CEILING_MS)
        const response = await responsePromise

        expect(response.statusCode).toBe(503)
        const { error } = response.json() as { error: string }
        expect(error).toMatch(/arm 1 for lane "lane-wedged-route"/)
      } finally {
        release()
        await occupying.catch(() => {})
      }
    } finally {
      vi.useRealTimers()
      await rm(sessionDir, { recursive: true, force: true })
    }
  })

  /**
   * #234's second defect, at the entry point rather than over HTTP: the
   * refusal must be a `LaunchValidationError` (which the route renders as a
   * 400) and it must arrive before `runCli` is reached, so no worktree is
   * forked and no money is spent on a request that was never going to be
   * honoured. `exec` is deliberately one that fails the test if it is called
   * at all — the assertion is "nothing ran", not merely "it threw".
   */
  it('refuses a model carrying shell metacharacters before the laboratory runs at all', async () => {
    const neverRuns: Exec = async (command, argv) => {
      throw new Error(`nothing should have been executed, but got: ${command} ${argv.join(' ')}`)
    }

    for (const model of [
      'opus; touch /tmp/pwned',
      'opus$(touch /tmp/pwned)',
      'opus`touch /tmp/pwned`',
      'opus --dangerously-skip-permissions',
      'opus\ntouch /tmp/pwned',
    ]) {
      await expect(
        launchExperiment(
          { lane: 'lane-a', checkpointId: 'ckpt-1', arms: [{ model }] },
          { repoPath: repoDir, exec: neverRuns, dataRoot, claudeProjectsRoot },
        ),
        `${JSON.stringify(model)} was not refused`,
      ).rejects.toThrow(LaunchValidationError)
    }
  })

  /**
   * The `model` grammar's sibling defect: `lane` is the ONE caller-supplied
   * argv POSITIONAL on this path, and `parseFlags` reads any `-`-prefixed
   * positional as a flag. Before the fix, `lane: "--model"` made `--path` the
   * model value and left `--path` unset, so the fork resolved its parent
   * worktree from the CLI's default instead of the server's repo and the arm
   * ran a model the operator never chose.
   *
   * Two layers, like the model: `--` in the argv makes it structurally
   * unparseable as a flag, and the boundary refuses a leading `-` outright
   * for `--help`/`-h`, which `parseLabForkArgs` scans for before `parseFlags`
   * ever runs. `exec` fails the test if anything is executed.
   */
  it('refuses a lane that would be read as a flag, before the laboratory runs at all', async () => {
    const neverRuns: Exec = async (command, argv) => {
      throw new Error(`nothing should have been executed, but got: ${command} ${argv.join(' ')}`)
    }

    for (const lane of ['--model', '--path', '--launch', '--arms', '--help', '-h', '-x']) {
      await expect(
        launchExperiment(
          { lane, checkpointId: 'ckpt-1', arms: [{ model: 'opus' }] },
          { repoPath: repoDir, exec: neverRuns, dataRoot, claudeProjectsRoot },
        ),
        `lane ${JSON.stringify(lane)} was not refused`,
      ).rejects.toThrow(LaunchValidationError)
    }
  })

  /**
   * The structural half, proven rather than asserted about: a lane whose text
   * looks nothing like a flag but which the CLI must still receive verbatim.
   * A lane containing `/` and `.` is ordinary (worktree handles mirror branch
   * names), so this also pins that the fix constrains only the FIRST
   * character and did not quietly narrow what a lane may be called.
   */
  it('passes an ordinary lane through verbatim, slashes and dots included', async () => {
    const lane = 'feature/some.thing_v2'
    const checkpointId = await seedCheckpoint(lane, () => 1_000_000)
    const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))

    const result = await launchExperiment(
      { lane, checkpointId, arms: [{ model: 'sonnet' }] },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )

    expect(result.failed).toBeNull()
    expect(result.parentLane).toBe(lane)
    expect(result.arms).toHaveLength(1)
  })

  it('an arm whose model is only whitespace is "no model", not a violation — the fleet default, honestly', async () => {
    const checkpointId = await seedCheckpoint('lane-blank', () => 1_000_000)
    const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))

    const result = await launchExperiment(
      { lane: 'lane-blank', checkpointId, arms: [{ model: '   ' }] },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )

    expect(result.failed).toBeNull()
    expect(result.arms[0]?.model).toBeNull()
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

  /**
   * #10: `runLabCliOnce` used to replace `process.stderr.write` for the whole
   * duration of the CLI call, process-wide — so a `console.error` from
   * anything else running concurrently (another request, a background loop,
   * #239's degrade reporting) landed in the buffer this route builds
   * `failed.error` from, and never reached the operator's real stderr at all.
   * Stubs `workmux` to hang until this test writes an unrelated
   * `console.error`, THEN fail — reproducing a slow fork with something else
   * writing to stderr mid-flight. Both halves must hold: the outside write
   * reaches the real stream, and it never leaks into this arm's own failure.
   *
   * Writes `process.stderr.write` directly rather than through
   * `console.error` — vitest's own reporter intercepts `console.*` before it
   * ever reaches `process.stderr.write`, which would make this assert nothing
   * about the code under test either way; `console.error` (like every
   * lab-subcommand error path in `cli/index.ts`) is itself just a caller of
   * `process.stderr.write`, which is the actual seam this issue is about.
   */
  it('a console.error raised outside the lab during a stubbed slow fork reaches real stderr and is absent from failed.error', async () => {
    const checkpointId = await seedCheckpoint('lane-outside-stderr', () => 1_000_000)

    let markWorkmuxStarted: () => void = () => {}
    const workmuxStarted = new Promise<void>((resolve) => {
      markWorkmuxStarted = resolve
    })
    let releaseWorkmux: () => void = () => {}
    const workmuxGate = new Promise<void>((resolve) => {
      releaseWorkmux = resolve
    })

    const exec: Exec = async (command, args, execOptions) => {
      if (command !== 'workmux') return realExec(command, args, execOptions)
      markWorkmuxStarted()
      await workmuxGate
      return { stdout: '', stderr: 'workmux: tmux server not running', code: 1, failed: true }
    }

    const realWrites: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      realWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return (originalWrite as unknown as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write

    try {
      const launchPromise = launchExperiment(
        { lane: 'lane-outside-stderr', checkpointId, arms: [{ model: 'opus' }] },
        { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
      )

      // Wait until the "fork" is genuinely mid-flight (blocked on workmux)
      // before the outside write happens, and only then let it fail.
      await workmuxStarted
      process.stderr.write('OUTSIDE-STDERR-MARKER: an unrelated write during the slow fork\n')
      releaseWorkmux()

      const result = await launchPromise

      expect(result.failed?.arm).toBe(1)
      expect(result.failed?.error).toMatch(/tmux server not running/)
      expect(result.failed?.error).not.toMatch(/OUTSIDE-STDERR-MARKER/)
      expect(realWrites.some((chunk) => chunk.includes('OUTSIDE-STDERR-MARKER'))).toBe(true)
    } finally {
      process.stderr.write = originalWrite
    }
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

  /** The header a caller who was actually served the dashboard page would carry (ADR-0012). */
  function authorised(app: ReturnType<typeof buildApp>): Record<string, string> {
    return { [CAPABILITY_TOKEN_HEADER]: app.capabilityToken }
  }

  /**
   * #234's first defect, on the route that matters most. This one forks a
   * worktree and dispatches a live agent that spends real money, and the
   * app-wide guard deliberately admits a request with no `Origin`
   * (`server/mutation-guard.ts`) — so a bare `curl` from any local process
   * reached it.
   *
   * The tokenless case asserts more than the status: `launchExperiment` is
   * never entered at all. A 401 arriving after a worktree was already forked
   * would be a gate in name only. `readOnly` is left off deliberately here —
   * the refusal must come from the token, not from a server that had nothing
   * to fork anyway.
   */
  describe('requires the capability token (#234)', () => {
    it('refuses a tokenless launch — the bare curl this issue is about — before the laboratory is touched', async () => {
      const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

      const response = await app.inject({
        method: 'POST',
        url: '/api/lab/launch',
        payload: { lane: 'x', checkpointId: 'y', arms: [{ model: 'opus' }] },
      })

      expect(response.statusCode).toBe(401)
      expect((response.json() as { error: string }).error).toContain(CAPABILITY_TOKEN_HEADER)
      // Nothing was dispatched and nothing was recorded — the handler never ran.
      expect(recorder.eventsSoFar()).toEqual([])
    })

    it('refuses a wrong token just as flatly — a guess is not a capability', async () => {
      const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

      const response = await app.inject({
        method: 'POST',
        url: '/api/lab/launch',
        headers: { [CAPABILITY_TOKEN_HEADER]: 'not-the-real-token' },
        payload: { lane: 'x', checkpointId: 'y', arms: [{ model: 'opus' }] },
      })

      expect(response.statusCode).toBe(401)
      expect(recorder.eventsSoFar()).toEqual([])
    })

    it('lets the correctly-tokened request reach the handler — the gate is a gate, not a wall', async () => {
      const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

      // A tokened request with a malformed payload reaches the handler and is
      // answered by the handler's OWN validation — a 400, not a 401. That is
      // what proves the token was accepted rather than the request refused
      // for some other reason.
      const response = await app.inject({
        method: 'POST',
        url: '/api/lab/launch',
        headers: authorised(app),
        payload: { lane: '', checkpointId: 'x', arms: [{}] },
      })

      expect(response.statusCode).toBe(400)
      expect((response.json() as { error: string }).error).toMatch(/lane/)
    })
  })

  it('400s a malformed body before ever touching the laboratory', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({
      method: 'POST',
      url: '/api/lab/launch',
      headers: authorised(app),
      payload: { lane: '', checkpointId: 'x', arms: [{}] },
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: string }).error).toMatch(/lane/)
  })

  /**
   * #234's second defect, at the boundary. The payloads below are the ones
   * that mattered: each ends up inside
   * `` `bash scripts/lane-agent.sh ${model}` ``, a STRING workmux hands to a
   * shell in a tmux pane, so each would have run a second command as the
   * operator. The refusal is a 400 that names the offending character, and it
   * happens in `parseLaunchRequestBody` — before `runCli`, before
   * `dispatchFork`, before `workmuxAddArgv` exists to be called.
   */
  it('400s a model carrying shell metacharacters, naming the character, and dispatches nothing', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const payloads: ReadonlyArray<{ model: string; names: string }> = [
      { model: 'sonnet; touch /tmp/pwned', names: ';' },
      { model: 'sonnet$(touch /tmp/pwned)', names: '$' },
      { model: 'sonnet`touch /tmp/pwned`', names: '`' },
      { model: 'sonnet --dangerously-skip-permissions', names: 'a space' },
      { model: 'sonnet\ntouch /tmp/pwned', names: '\\n' },
      { model: 'sonnet && touch /tmp/pwned', names: 'a space' },
      { model: 'sonnet | sh', names: 'a space' },
      { model: '$(id)', names: '$' },
    ]

    for (const { model, names } of payloads) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/lab/launch',
        headers: authorised(app),
        payload: { lane: 'x', checkpointId: 'y', arms: [{ model }] },
      })

      expect(response.statusCode, `model ${JSON.stringify(model)} was not refused`).toBe(400)
      const { error } = response.json() as { error: string }
      expect(error, `refusal for ${JSON.stringify(model)} does not name the offender`).toContain(names)
      expect(error).toMatch(/letters, digits/)
    }

    // Every one of them was refused at the boundary: nothing reached the
    // laboratory, so nothing was dispatched and nothing was recorded.
    expect(recorder.eventsSoFar()).toEqual([])
  })

  it('400s a lane that would be read as a flag, naming the lane and why', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({
      method: 'POST',
      url: '/api/lab/launch',
      headers: authorised(app),
      payload: { lane: '--model', checkpointId: 'ckpt-1', arms: [{ model: 'opus' }] },
    })

    expect(response.statusCode).toBe(400)
    const { error } = response.json() as { error: string }
    expect(error).toMatch(/"lane" may not begin with "-"/)
    expect(error).toContain('--model')
    expect(recorder.eventsSoFar()).toEqual([])
  })

  it('400s a flag-shaped checkpointId and a flag-shaped model — every value that reaches argv, not just the lane', async () => {
    // The lane guard alone left two other argv-bound fields open. Both reach
    // `parseLabForkArgs`'s raw --help pre-scan, which runs BEFORE the `--`
    // separator protects anything, so `-h` there prints the fork command's
    // help and exits 0 — surfacing as "could not read the dispatch result"
    // rather than as a validation error an operator can act on.
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const cases: Array<{ payload: Record<string, unknown>; matches: RegExp }> = [
      {
        payload: { lane: 'dev-1', checkpointId: '--help', arms: [{ model: 'opus' }] },
        matches: /"checkpointId" may not begin with "-"/,
      },
      {
        payload: { lane: 'dev-1', checkpointId: 'ckpt-1', arms: [{ model: '-h' }] },
        matches: /arm 1's "model" may not begin with "-"/,
      },
    ]

    for (const { payload, matches } of cases) {
      const response = await app.inject({ method: 'POST', url: '/api/lab/launch', headers: authorised(app), payload })
      expect(response.statusCode).toBe(400)
      expect((response.json() as { error: string }).error).toMatch(matches)
    }
    expect(recorder.eventsSoFar()).toEqual([])
  })

  it('still accepts a model whose name merely CONTAINS a dash — the guard is the first character only', async () => {
    // Not vacuously strict: `-` is legal inside a model name, which is why
    // MODEL_GRAMMAR admits it and why this guard constrains position rather
    // than presence. A guard that rejected `claude-opus-5` would be worse
    // than the hole it closes.
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({
      method: 'POST',
      url: '/api/lab/launch',
      headers: authorised(app),
      payload: { lane: 'dev-1', checkpointId: 'ckpt-1', arms: [{ model: 'claude-opus-5' }] },
    })

    // Whatever happens downstream, it must NOT be the flag-shaped refusal.
    if (response.statusCode === 400) {
      expect((response.json() as { error: string }).error).not.toMatch(/may not begin with "-"/)
    }
  })

  it('409s when this server is replaying a record instead of watching a repo — there is nothing live to fork', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, readOnly: true })

    const response = await app.inject({
      method: 'POST',
      url: '/api/lab/launch',
      headers: authorised(app),
      payload: { lane: 'x', checkpointId: 'y', arms: [{ model: 'opus' }] },
    })
    expect(response.statusCode).toBe(409)
  })
})

/**
 * THE MODEL GRAMMAR (#234's second defect), as a unit.
 *
 * The route test above proves the refusal reaches an HTTP caller. This proves
 * the grammar itself is the right grammar — which is the half that can quietly
 * be wrong in the other direction. A grammar that rejects a model this repo
 * actually dispatches is a worse bug than the injection it closes: it would
 * break every launch, and it would look like a lab failure rather than a
 * validation one.
 */
describe('the model grammar admits every model this repo really dispatches (#234)', () => {
  it('passes the fleet default and every model spelled anywhere in this repo or its config', () => {
    const real = [
      // `.workmux.yaml`'s `agent:` line, and `scripts/lane-agent.sh`'s own default.
      'sonnet',
      // Spelled in this file's own fixtures and in `web/src/lab/launch/`.
      'opus',
      'haiku',
      // Full API model ids, both generations.
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-3-5-sonnet-20241022',
      'claude-haiku-4-5-20251001',
      // A bedrock-style id — dots and a colon, the two characters most likely
      // to be left out of a hastily-written grammar.
      'us.anthropic.claude-3-5-sonnet-20241022-v1:0',
      // An underscore, for the same reason.
      'some_internal_model',
    ]
    for (const model of real) {
      expect(MODEL_GRAMMAR.test(model), `${model} is a legitimate model and must not be refused`).toBe(true)
    }
  })

  it('refuses every character a shell would act on', () => {
    for (const model of [
      'a;b',
      'a b',
      'a|b',
      'a&b',
      'a$b',
      'a`b',
      'a(b',
      'a)b',
      'a>b',
      'a<b',
      'a\nb',
      'a\rb',
      'a\tb',
      "a'b",
      'a"b',
      'a\\b',
      'a*b',
      'a#b',
      'a!b',
      'a{b',
      'a/b',
      '',
    ]) {
      expect(MODEL_GRAMMAR.test(model), `${JSON.stringify(model)} must be refused`).toBe(false)
    }
  })

  it('is anchored at both ends — a payload after a legitimate prefix is still a payload', () => {
    expect(MODEL_GRAMMAR.test('sonnet\nrm -rf /')).toBe(false)
    expect(MODEL_GRAMMAR.test('rm -rf /\nsonnet')).toBe(false)
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

  /**
   * `setInterval`/`setImmediate` are the two primitives capable of firing on
   * their own schedule, independent of any one request — a repeating timer or
   * a reentrant microtask loop is what "a clock of its own" means here.
   * `setTimeout` is checked separately, immediately below: prd41 ruling 2
   * gave this file exactly one, and it is request-scoped (the lock ceiling),
   * not a clock — pinning it that way is more precise than banning the
   * primitive outright.
   */
  it('api/lab.ts has no clock of its own — no repeating or reentrant trigger fires without an incoming request', () => {
    const source = readFileSync(LAB_ROUTE_FILE, 'utf8')
    expect(/\b(setInterval|setImmediate)\s*\(/.test(source)).toBe(false)
  })

  it('that detector bites — a scheduled launch would be caught', () => {
    expect(/\b(setInterval|setImmediate)\s*\(/.test('setInterval(() => launchExperiment(x, y), 60_000)')).toBe(true)
  })

  /**
   * prd41 ruling 2's lock ceiling is the one `setTimeout` this file has —
   * pinned to exactly one, and proven request-scoped rather than a clock:
   * its callback only rejects an already-outstanding promise
   * (`withLabCliLock`'s `ceilingReached`), it never calls `launchExperiment`,
   * `runLabCliOnce` or `runCli`, and nothing rearms it. A future `setTimeout`
   * added anywhere else in this file reds this pin rather than silently
   * widening what "no clock of its own" actually covers.
   */
  it("the lock ceiling's setTimeout is the only one in this file, and its callback never reaches the launch entry point or the CLI invoker", () => {
    const source = readFileSync(LAB_ROUTE_FILE, 'utf8')
    const calls = source.match(/\bsetTimeout\s*\(/g) ?? []
    expect(calls).toHaveLength(1)

    const start = source.indexOf('ceilingTimer = setTimeout(')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('}, ceilingMs)', start)
    expect(end).toBeGreaterThan(start)
    const callback = source.slice(start, end)

    expect(LAUNCH_ENTRY_RE.test(callback)).toBe(false)
    expect(/\brunLabCliOnce\b|\brunCli\s*\(/.test(callback)).toBe(false)
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
