import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Exec, ExecResult, RhizomorphEvent } from '@rhizomorph/core'
import {
  armKey,
  createEventFactory,
  createIdFactory,
  eventsToJsonl,
  RD_MULTI_DIMENSION_REFUSAL,
  reduceAll,
} from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../cli/index.js'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
import { sessionDirFor, sessionFileName } from '../log/paths.js'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { exec as realExec } from '../server/exec.js'
import { SessionRecorder } from '../server/recorder.js'
import {
  estimateLaunchSpend,
  LAB_CLI_LOCK_CEILING_MS,
  LAUNCH_CEILING_LANES,
  LabCliLockCeilingError,
  LaunchValidationError,
  launchExperiment,
  MeasureUnknownForkError,
  MeasureValidationError,
  MODEL_GRAMMAR,
  measureExperiment,
  parseForkStdout,
  runRdExperiment,
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
    // prd53 S1: the byte facts the axis places a marker by. The fixture's session
    // file does not exist on this machine, so its length is null — the degraded
    // state, reported rather than guessed.
    expect(checkpoints[0]).toMatchObject({ eventIndex: 12, sessionCutByte: 11_840, sessionByteLength: null })
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

  it('carries every recorded run of one arm, each with its number and its own worktree, rather than collapsing repeats (prd53 ruling 1)', async () => {
    // Before prd53 this fixture recorded two runs sharing one handle and one
    // worktree — a shape `dispatchFork` can no longer produce (`armLeaf` gives
    // every run its own), so the fixture now records what actually happens.
    await mkdir(sessionDir, { recursive: true })
    const f = createEventFactory({ startTs: 1000 })
    f.forkDispatched({
      forkId: 'fork-2',
      arm: 1,
      run: 1,
      laneHandle: 'fork-2-arm-1',
      worktreePath: '/data/lab/worktrees/fork-2-arm-1',
    })
    f.forkDispatched({
      forkId: 'fork-2',
      arm: 1,
      run: 2,
      laneHandle: 'fork-2-arm-1-run-2',
      worktreePath: '/data/lab/worktrees/fork-2-arm-1-run-2',
    })
    await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')

    const recorder = new SessionRecorder('2000', sessionFilePath(sessionDir, '2000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/experiments' })
    const { experiments } = response.json() as {
      experiments: Array<{ arms: Array<{ runs: Array<{ run: number; worktreePath: string }> }> }>
    }
    expect(experiments[0]?.arms).toHaveLength(1)
    expect(experiments[0]?.arms[0]?.runs.map((run) => run.run)).toEqual([1, 2])
    expect(new Set(experiments[0]?.arms[0]?.runs.map((run) => run.worktreePath)).size).toBe(2)
  })

  it('reads a run recorded before prd53 — no run field at all — as run 1, never as missing', async () => {
    await mkdir(sessionDir, { recursive: true })
    const f = createEventFactory({ startTs: 1000 })
    f.forkDispatched({ forkId: 'fork-3', arm: 1, laneHandle: 'fork-3-arm-1', worktreePath: '/data/lab/worktrees/fork-3-arm-1' })
    await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')

    const recorder = new SessionRecorder('2000', sessionFilePath(sessionDir, '2000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/experiments' })
    const { experiments } = response.json() as { experiments: Array<{ arms: Array<{ runs: Array<{ run: number }> }> }> }
    expect(experiments[0]?.arms[0]?.runs[0]?.run).toBe(1)
  })

  /**
   * #409 — THE LIVE SESSION'S FOLD IS THE UNION, NOT THE BUFFER.
   *
   * The listing used to read the live session from `ctx.recorder.eventsSoFar()`
   * alone. But `lab/fork.ts` constructs its OWN `SessionRecorder` on the SAME
   * session file (`findResumableSession` resumes it) and appends through that,
   * so a launch reached the file and never the server's in-memory buffer: the
   * walkthrough of the stack base found a launch invisible in this route until
   * the server was rebooted. These two tests append through a second recorder,
   * exactly as the fork does, and read the listing back.
   */
  it('folds what the live session\'s log holds, not only the server\'s buffer — a launch is visible without a restart (#409)', async () => {
    await mkdir(sessionDir, { recursive: true })
    const liveId = '2000'
    const liveFile = sessionFilePath(sessionDir, liveId)
    const recorder = new SessionRecorder(liveId, liveFile)
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    // The server's own hand, through the live recorder.
    const server = createEventFactory({ startTs: 1000, idPrefix: 'server' })
    await recorder.record(server.forkCheckpoint({ lane: 'feature', checkpointId: 'ckpt-1' }))

    // Another hand entirely: a SECOND recorder on the same file, resumed from
    // what is already there — which is precisely what `lab/fork.ts` does.
    const fork = new SessionRecorder(liveId, liveFile, { resumeFrom: recorder.eventsSoFar() })
    const cli = createEventFactory({ startTs: 2000, idPrefix: 'cli' })
    await fork.record(
      cli.forkDispatched({
        forkId: 'fork-409',
        parentLane: 'feature',
        checkpointId: 'ckpt-1',
        arm: 1,
        laneHandle: 'fork-409-arm-1',
        worktreePath: '/data/lab/worktrees/fork-409-arm-1',
      }),
    )

    // No restart, no new app: the same running server answers.
    const experiments = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/experiments' })
    expect(experiments.statusCode).toBe(200)
    expect((experiments.json() as { experiments: Array<{ forkId: string }> }).experiments.map((e) => e.forkId)).toEqual([
      'fork-409',
    ])

    // …and the server's own write, which lives only in the buffer's newest
    // slice, is still there: the union is a union, not a swap.
    const checkpoints = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/checkpoints' })
    expect((checkpoints.json() as { checkpoints: Array<{ checkpointId: string }> }).checkpoints.map((c) => c.checkpointId)).toEqual([
      'ckpt-1',
    ])
  })

  it('keeps two events that genuinely share an id — createIdFactory restarts at one per process, so the id alone is not identity (#409)', async () => {
    // `createIdFactory('lab')` mints `lab-000001` upward from ONE in every
    // process, and both this file's measure route and `lab/fork.ts` used to
    // call it exactly like that. So the server's own write and the CLI's
    // really did collide on the id in one session file, and a dedupe on the
    // bare id would answer #409 by dropping one of the two writes it exists
    // to surface.
    //
    // #429 gave `createIdFactory` an optional `writer` tag that stops this
    // exact collision, and this file's own measure route and `lab/fork.ts`,
    // `lab/checkpoint.ts` and `lab/rd.ts` are now wired to pass one each (see
    // the next test, which proves it with their real tags). The fixture below
    // still builds the collision on purpose, through `createEventFactory`,
    // which mints with no tag of its own — this is the shape none of the four
    // real callers can produce any more, and exactly the shape a future
    // caller that forgets its own tag would reintroduce. It is what
    // `liveEventKey`'s belt-and-braces comment above is insurance against,
    // not a live defect in today's four writers.
    await mkdir(sessionDir, { recursive: true })
    const liveId = '2000'
    const liveFile = sessionFilePath(sessionDir, liveId)
    const recorder = new SessionRecorder(liveId, liveFile)
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const server = createEventFactory({ startTs: 1000, idPrefix: 'lab' })
    await recorder.record(
      server.forkDispatched({
        forkId: 'fork-from-the-server',
        parentLane: 'feature',
        checkpointId: 'ckpt-1',
        arm: 1,
        laneHandle: 'fork-from-the-server-arm-1',
        worktreePath: '/data/lab/worktrees/fork-from-the-server-arm-1',
      }),
    )

    const fork = new SessionRecorder(liveId, liveFile, { resumeFrom: recorder.eventsSoFar() })
    // A SECOND factory with the same prefix, starting its own count at one.
    const cli = createEventFactory({ startTs: 2000, idPrefix: 'lab' })
    const collided = cli.forkDispatched({
      forkId: 'fork-from-the-cli',
      parentLane: 'feature',
      checkpointId: 'ckpt-1',
      arm: 1,
      laneHandle: 'fork-from-the-cli-arm-1',
      worktreePath: '/data/lab/worktrees/fork-from-the-cli-arm-1',
    })
    expect(collided.id).toBe(server.all()[0]?.id) // the collision is real, not hypothetical
    await fork.record(collided)

    const response = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/experiments' })
    expect((response.json() as { experiments: Array<{ forkId: string }> }).experiments.map((e) => e.forkId).sort()).toEqual([
      'fork-from-the-cli',
      'fork-from-the-server',
    ])
  })

  it('a writer tag on createIdFactory keeps the same two events from colliding, wired with the real tags (#429)', () => {
    // Same shapes as the collision test above — only each side now names
    // itself with the ACTUAL tags #429's wiring gives them: `measure` for
    // this file's own measure route, `fork` for `lab/fork.ts`. This is the
    // exact pair the record used to collide on, proven closed with the real
    // vocabulary a reader of the log now sees, not a placeholder.
    const server = createEventFactory({ startTs: 1000, idPrefix: 'lab' })
    const serverId = createIdFactory('lab', 0, 'measure')
    const serverEvent = server.forkDispatched(
      {
        forkId: 'fork-from-the-server',
        parentLane: 'feature',
        checkpointId: 'ckpt-1',
        arm: 1,
        laneHandle: 'fork-from-the-server-arm-1',
        worktreePath: '/data/lab/worktrees/fork-from-the-server-arm-1',
      },
      { id: serverId() },
    )

    const cli = createEventFactory({ startTs: 2000, idPrefix: 'lab' })
    const cliId = createIdFactory('lab', 0, 'fork')
    const cliEvent = cli.forkDispatched(
      {
        forkId: 'fork-from-the-cli',
        parentLane: 'feature',
        checkpointId: 'ckpt-1',
        arm: 1,
        laneHandle: 'fork-from-the-cli-arm-1',
        worktreePath: '/data/lab/worktrees/fork-from-the-cli-arm-1',
      },
      { id: cliId() },
    )

    expect(serverEvent.id).toBe('lab-measure-000001')
    expect(cliEvent.id).toBe('lab-fork-000001')
    expect(serverEvent.id).not.toBe(cliEvent.id) // the collision above does not reach here
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

  it('scales by arms × runs when runs is given, states the lanes it counted, and refuses a runs that is not a positive integer (prd53 ruling 1; prd-55 ruling 7)', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const f = createEventFactory({ startTs: 5_000_000 - 10 * 60_000 })
    await recorder.record(f.llmCost({ lane: 'hot-lane', costUsd: 3.6, authoritative: true }))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => 5_000_000 })

    // The launch panel asks for arms × runs once runs per arm is set: every
    // run is its own spending lane, and an estimate scaled by arms alone
    // would understate a two-run experiment by half.
    const response = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/estimate?lane=hot-lane&arms=3&runs=2' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as Record<string, number | boolean>
    expect([body.arms, body.runs, body.lanes]).toEqual([3, 2, 6])
    expect(body.estimatedTotalUsd).toBeCloseTo(3.6 * 6, 5)

    // Without runs the answer still STATES one run and the lanes it counted,
    // so the panel prints the server's basis and never assumes the default.
    const alone = (await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/estimate?lane=hot-lane&arms=3' })).json() as Record<string, number>
    expect([alone.runs, alone.lanes]).toEqual([1, 3])

    const refused = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/estimate?lane=hot-lane&arms=3&runs=0' })
    expect(refused.statusCode).toBe(400)
    expect((refused.json() as { error: string }).error).toBe('"runs" must be a positive integer when present (prd53 ruling 1)')
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

describe('parseForkStdout', () => {
  it("reads forkId, checkpointId and, per run, the REAL arm number, laneHandle, worktreePath and 'launched' from a dispatch's stdout", () => {
    const stdout = [
      'fork fork-abc123 — 1 arm(s) of lane "feature" restored from checkpoint ckpt-1',
      '  arm 2  fork-abc123-arm-2',
      '    worktree  /data/lab/worktrees/fork-abc123-arm-2',
      '    session   /home/x/.claude/projects/y/z.jsonl (12 lines, 3 paths rewritten to this tree)',
      '    launch    ran: workmux add fork-abc123-arm-2 -b -a "bash scripts/lane-agent.sh opus"',
      '',
      'Compare them with: rhizomorph lab compare fork-abc123 --path /repo',
    ].join('\n')

    expect(parseForkStdout(stdout)).toEqual({
      forkId: 'fork-abc123',
      checkpointId: 'ckpt-1',
      runs: [
        {
          arm: 2,
          run: 1,
          laneHandle: 'fork-abc123-arm-2',
          worktreePath: '/data/lab/worktrees/fork-abc123-arm-2',
          launched: true,
        },
      ],
    })
  })

  it("reads every run of a multi-run dispatch — the second onward carrying its number, a launcher's extra session line skipped — and launched:false from 'not run' (prd53 ruling 1)", () => {
    const stdout = [
      'fork fork-xyz — 1 arm(s) × 2 run(s) of lane "feature" restored from checkpoint ckpt-1',
      '  arm 1  fork-xyz-arm-1',
      '    worktree  /data/lab/worktrees/fork-xyz-arm-1',
      '    session   /home/x/.claude/projects/y/z.jsonl (0 lines, 0 paths rewritten to this tree)',
      '    launch    not run — run it yourself: claude -p --strict-mcp-config -- /tmp/brief.md',
      '  arm 1 run 2  fork-xyz-arm-1-run-2',
      '    worktree  /data/lab/worktrees/fork-xyz-arm-1-run-2',
      '    session   /home/x/.claude/projects/y/z.jsonl (0 lines, 0 paths rewritten to this tree)',
      "    session   /elsewhere/z.jsonl (the launcher's own tree)",
      '    launch    ran: workmux add fork-xyz-arm-1-run-2 -b',
    ].join('\n')

    const parsed = parseForkStdout(stdout)
    expect(parsed?.runs.map((run) => [run.arm, run.run, run.launched])).toEqual([
      [1, 1, false],
      [1, 2, true],
    ])
    expect(parsed?.runs[1]?.worktreePath).toBe('/data/lab/worktrees/fork-xyz-arm-1-run-2')
  })

  it('returns null on unrecognised output rather than guessing at a shape', () => {
    expect(parseForkStdout('not the shape we expect')).toBeNull()
    expect(parseForkStdout('')).toBeNull()
    // A header with no run block underneath it is not a dispatch either.
    expect(parseForkStdout('fork fork-a — 1 arm(s) of lane "x" restored from checkpoint c')).toBeNull()
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

  /**
   * Writes an `rd.proposal` event straight to a session file, bypassing a
   * real R&D run — `recordOverrideIfNeeded`'s lookup reads the same fold any
   * other surface would, so a synthetic proposal is exactly what a real one
   * looks like on the record. `chosenCheckpointId` need not be a REAL,
   * restorable checkpoint: it is only ever compared as a string against the
   * launch's own `checkpointId`, never restored from.
   */
  async function seedProposal(proposalId: string, chosenCheckpointId: string, startTs: number): Promise<void> {
    const f = createEventFactory({ startTs })
    f.rdProposal({ proposalId, checkpointPick: { chosenCheckpointId, rejected: [] } })
    const dir = sessionDirFor(repoDir, dataRoot)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, sessionFileName(startTs)), eventsToJsonl(f.all()), 'utf8')
  }

  /** A fresh, never-before-used live recorder over this test's own `sessionDir` — what `sessionDir`/`recorder` options 2 need to look a proposal up and, if it applies, record an override. */
  function freshRecorder(id: string): SessionRecorder {
    return new SessionRecorder(id, sessionFilePath(sessionDirFor(repoDir, dataRoot), id))
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
  it(`refuses more than LAUNCH_CEILING_LANES (${LAUNCH_CEILING_LANES}) arms before touching the laboratory at all`, async () => {
    const neverRuns: Exec = async (command, argv) => {
      throw new Error(`nothing should have been executed, but got: ${command} ${argv.join(' ')}`)
    }
    const arms = Array.from({ length: LAUNCH_CEILING_LANES + 1 }, () => ({}))

    await expect(
      launchExperiment({ lane: 'x', checkpointId: 'y', arms }, { repoPath: repoDir, exec: neverRuns }),
    ).rejects.toThrow(new RegExp(`may not exceed the launch ceiling of ${LAUNCH_CEILING_LANES}`))
  })

  /** The other side of the ceiling: exactly LAUNCH_CEILING_LANES is not refused. */
  it(`dispatches exactly LAUNCH_CEILING_LANES (${LAUNCH_CEILING_LANES}) arms — the ceiling itself is accepted`, async () => {
    const checkpointId = await seedCheckpoint('lane-ceiling', () => 1_000_000)
    const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))
    const arms = Array.from({ length: LAUNCH_CEILING_LANES }, () => ({ model: 'opus' }))

    const result = await launchExperiment(
      { lane: 'lane-ceiling', checkpointId, arms },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )

    expect(result.failed).toBeNull()
    expect(result.arms).toHaveLength(LAUNCH_CEILING_LANES)
  })

  it(`refuses arms × runs above LAUNCH_CEILING_LANES (${LAUNCH_CEILING_LANES}) spending lanes before touching the laboratory — a run is a lane too`, async () => {
    const neverRuns: Exec = async (command, argv) => {
      throw new Error(`nothing should have been executed, but got: ${command} ${argv.join(' ')}`)
    }
    await expect(
      launchExperiment({ lane: 'x', checkpointId: 'y', arms: [{}, {}, {}], runs: 3 }, { repoPath: repoDir, exec: neverRuns }),
    ).rejects.toThrow(new RegExp(`spending lanes may not exceed the launch ceiling of ${LAUNCH_CEILING_LANES}`))
    await expect(
      launchExperiment({ lane: 'x', checkpointId: 'y', arms: [{}], runs: 0 }, { repoPath: repoDir, exec: neverRuns }),
    ).rejects.toThrow(/"runs" must be a positive integer/)
  })

  /**
   * prd55 ruling 4, end to end through the REAL dispatch: the route accepts the
   * proposal, it travels as `--proposal` into `lab/fork.ts`, and every
   * `fork.dispatched` the launch produces carries it. A launch nobody proposed
   * carries NO such key — absence has to mean "an operator chose this", never
   * "a proposal went missing".
   */
  it('carries the proposal a launch came from onto every recorded arm, and nothing at all when a hand chose it (prd55 ruling 4)', async () => {
    const checkpointId = await seedCheckpoint('lane-proposal', () => 1_000_000)
    // The proposal's own pick IS the checkpoint this launch uses — no
    // override to record, so this test's claim stays exactly what it always
    // was: the proposal id travels, and only that.
    await seedProposal('proposal-1', checkpointId, 1_500_000)
    const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))

    await launchExperiment(
      { lane: 'lane-proposal', checkpointId, arms: [{ model: 'opus' }], proposalId: 'proposal-1' },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000, sessionDir: sessionDirFor(repoDir, dataRoot), recorder: freshRecorder('9000000') },
    )
    await launchExperiment(
      { lane: 'lane-proposal', checkpointId, arms: [{ model: 'opus' }] },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_001 },
    )

    // Read from the LOG the launches wrote, not from the results they
    // returned: what the fold sees is what every surface will see.
    const dispatched = recordedEvents('fork.dispatched')
    const proposals = dispatched.map((event) => (event.payload as { proposalId?: string }).proposalId)
    expect(proposals).toContain('proposal-1')
    expect(proposals).toContain(undefined)
    // Absent means the key is not there at all, not an empty string.
    const byHand = dispatched.find((event) => (event.payload as { proposalId?: string }).proposalId === undefined)
    expect(byHand?.payload).not.toHaveProperty('proposalId')
    // The pick matched the launch — no override event exists.
    expect(recordedEvents('rd.override')).toHaveLength(0)
  })

  it('refuses a proposal id that names nothing, or one shaped like a flag, before anything is dispatched (prd55 ruling 4)', async () => {
    const neverRuns: Exec = async (command, argv) => {
      throw new Error(`nothing should have been executed, but got: ${command} ${argv.join(' ')}`)
    }
    await expect(
      launchExperiment({ lane: 'x', checkpointId: 'y', arms: [{}], proposalId: '' }, { repoPath: repoDir, exec: neverRuns }),
    ).rejects.toThrow(/"proposalId" must be a non-empty string/)
    await expect(
      launchExperiment({ lane: 'x', checkpointId: 'y', arms: [{}], proposalId: '--help' }, { repoPath: repoDir, exec: neverRuns }),
    ).rejects.toThrow(/may not begin with "-"/)
  })

  /**
   * prd-55 ruling 4 (wave 6 widening): the launch route itself records
   * `rd.override` — looked up in the fold by `proposalId`, compared against
   * the checkpoint THIS launch actually uses, before a single arm dispatches.
   */
  describe('a launch naming a proposalId records an override exactly when the checkpoints disagree (prd-55 ruling 4)', () => {
    it("records rd.override, naming BOTH checkpoints, before anything dispatches — the operator's choice is never re-attributed", async () => {
      const checkpointId = await seedCheckpoint('lane-override', () => 1_000_000)
      await seedProposal('proposal-override-1', 'ckpt-the-hand-picked', 1_500_000)
      const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))

      const result = await launchExperiment(
        { lane: 'lane-override', checkpointId, arms: [{ model: 'opus' }], proposalId: 'proposal-override-1' },
        {
          repoPath: repoDir,
          exec,
          dataRoot,
          claudeProjectsRoot,
          now: () => 2_000_000,
          sessionDir: sessionDirFor(repoDir, dataRoot),
          recorder: freshRecorder('9100000'),
        },
      )

      expect(result.failed).toBeNull()
      const overrides = recordedEvents('rd.override')
      expect(overrides).toHaveLength(1)
      expect(overrides[0]?.payload).toMatchObject({
        lane: 'lane-override',
        proposalId: 'proposal-override-1',
        agentCheckpointId: 'ckpt-the-hand-picked',
        operatorCheckpointId: checkpointId,
      })
    })

    it('records the override BEFORE dispatching — it survives even when the arm itself then fails to dispatch', async () => {
      // workmux fails on purpose: the launch's own arm never actually
      // dispatches (a PARTIAL experiment, prd53 ruling 7), and the override
      // is still on the record — proof it was written before the dispatch
      // loop even started, not as a side effect of a successful one.
      const checkpointId = await seedCheckpoint('lane-override-order', () => 1_000_000)
      await seedProposal('proposal-override-2', 'ckpt-the-hand-picked-2', 1_500_000)
      // The arm must FAIL for this test to mean anything, and prd-57 ruling 8
      // removed the `workmux add` spawn that used to be the failure point. The
      // restore is where an arm can fail now.
      const exec = execWithStubs((command, args) =>
        command === 'git' && args[0] === 'worktree' && args[1] === 'add'
          ? { stdout: '', stderr: 'fatal: could not create work tree dir', code: 128, failed: true }
          : null,
      )

      const result = await launchExperiment(
        { lane: 'lane-override-order', checkpointId, arms: [{ model: 'opus' }], proposalId: 'proposal-override-2' },
        {
          repoPath: repoDir,
          exec,
          dataRoot,
          claudeProjectsRoot,
          now: () => 2_000_000,
          sessionDir: sessionDirFor(repoDir, dataRoot),
          recorder: freshRecorder('9200000'),
        },
      )

      expect(result.failed).not.toBeNull() // the arm itself did not dispatch…
      expect(recordedEvents('rd.override')).toHaveLength(1) // …and the override still landed
    })

    it("a launch on the proposal's own pick records nothing — no override for a choice nobody changed", async () => {
      const checkpointId = await seedCheckpoint('lane-no-override', () => 1_000_000)
      await seedProposal('proposal-no-override', checkpointId, 1_500_000)
      const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))

      await launchExperiment(
        { lane: 'lane-no-override', checkpointId, arms: [{ model: 'opus' }], proposalId: 'proposal-no-override' },
        {
          repoPath: repoDir,
          exec,
          dataRoot,
          claudeProjectsRoot,
          now: () => 2_000_000,
          sessionDir: sessionDirFor(repoDir, dataRoot),
          recorder: freshRecorder('9300000'),
        },
      )

      expect(recordedEvents('rd.override')).toHaveLength(0)
    })

    /**
     * THE ID MUST ADVANCE, and every assertion above this one survives it not
     * advancing — they all count overrides (`toHaveLength(0|1)`) and none reads
     * an id. The defect this pins is scope, not spelling: `recordOverrideIfNeeded`
     * runs once per launch, so a factory built inside it restarts at one and
     * stamps `lab-000001` on every override a session records.
     *
     * Two launches, ONE recorder — the same session file, which is the scope
     * `createIdFactory` promises uniqueness within.
     */
    it('two overrides in one session mint distinct, advancing ids — the id is seeded from the record, not restarted (#429)', async () => {
      const recorder = freshRecorder('9350000')
      for (const n of [1, 2]) {
        const lane = `lane-two-overrides-${n}`
        const checkpointId = await seedCheckpoint(lane, () => 1_000_000 + n)
        await seedProposal(`proposal-two-overrides-${n}`, 'ckpt-the-hand-picked', 1_500_000 + n)
        await launchExperiment(
          { lane, checkpointId, arms: [{ model: 'opus' }], proposalId: `proposal-two-overrides-${n}` },
          {
            repoPath: repoDir,
            exec: execWithStubs((command) => (command === 'workmux' ? OK : null)),
            dataRoot,
            claudeProjectsRoot,
            now: () => 2_000_000 + n,
            sessionDir: sessionDirFor(repoDir, dataRoot),
            recorder,
          },
        )
      }

      const ids = recordedEvents('rd.override').map((event) => event.id)
      expect(ids).toHaveLength(2)
      // Stated as the exact pair, not as `new Set(ids).size`: a set assertion
      // passes for ANY two distinct ids, including a random one, and this is a
      // claim about a readable counter that advances by one.
      expect(ids).toEqual(['lab-override-000001', 'lab-override-000002'])
    })

    it('an unknown proposalId is refused by name, before anything is dispatched', async () => {
      const neverRuns: Exec = async (command, argv) => {
        throw new Error(`nothing should have been executed, but got: ${command} ${argv.join(' ')}`)
      }
      await expect(
        launchExperiment(
          { lane: 'x', checkpointId: 'y', arms: [{}], proposalId: 'proposal-nobody-recorded' },
          { repoPath: repoDir, exec: neverRuns, dataRoot, sessionDir: sessionDirFor(repoDir, dataRoot), recorder: freshRecorder('9400000') },
        ),
      ).rejects.toThrow(/"proposalId" names no proposal this repo has recorded: proposal-nobody-recorded/)
    })
  })

  it('one launch is ONE experiment: every arm and every run folds under the forkId the launch minted, and no two share a worktree (prd53 ruling 1)', async () => {
    const checkpointId = await seedCheckpoint('lane-one-fork', () => 1_000_000)
    const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))

    const result = await launchExperiment(
      { lane: 'lane-one-fork', checkpointId, arms: [{ model: 'opus' }, { model: 'sonnet' }], runs: 2 },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )

    expect(result.failed).toBeNull()
    expect(result.arms.map((arm) => arm.forkId)).toEqual([result.forkId, result.forkId])
    expect(result.arms.map((arm) => arm.runs.map((run) => run.run))).toEqual([
      [1, 2],
      [1, 2],
    ])

    // The law is read from the LOG the launch wrote, not from the result it
    // returned: what the fold sees is what every surface will see.
    const dispatched = readdirSync(dataRoot, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) =>
        readFileSync(path.join(dataRoot, file), 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as RhizomorphEvent),
      )
      .filter((event) => event.type === 'fork.dispatched')
    const state = reduceAll(dispatched)

    expect(Object.keys(state.forks.byFork)).toEqual([result.forkId])
    expect(state.forks.byFork[result.forkId]).toHaveLength(2 * 2)
    expect(state.forks.byArm[armKey(result.forkId, 1)]).toHaveLength(2)
    expect(state.forks.byArm[armKey(result.forkId, 2)]).toHaveLength(2)
    expect(new Set(state.forks.dispatches.map((d) => d.worktreePath)).size).toBe(4)
    expect(new Set(state.forks.dispatches.map((d) => d.laneHandle)).size).toBe(4)
    expect(state.forks.dispatches.map((d) => d.model)).toEqual(['opus', 'opus', 'sonnet', 'sonnet'])
  })

  /** Every event of one type the laboratory wrote under `dataRoot` — read from the LOG, never from a result object. */
  function recordedEvents(type: string): RhizomorphEvent[] {
    return readdirSync(dataRoot, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) =>
        readFileSync(path.join(dataRoot, file), 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as RhizomorphEvent),
      )
      .filter((event) => event.type === type)
  }

  it('a launch above the ceiling refuses by name and override before the laboratory runs; a declared override lets it through and lands on EVERY fork.dispatched (prd53 ruling 6)', async () => {
    expect(LAUNCH_CEILING_LANES).toBe(8)
    const neverRuns: Exec = async (command, argv) => {
      throw new Error(`nothing should have been executed, but got: ${command} ${argv.join(' ')}`)
    }
    await expect(
      launchExperiment({ lane: 'x', checkpointId: 'y', arms: [{}, {}, {}], runs: 3 }, { repoPath: repoDir, exec: neverRuns }),
    ).rejects.toThrow(/9 spending lanes may not exceed the launch ceiling of 8 \(the default\).*"ceilingOverride": 9/)
    await expect(
      launchExperiment({ lane: 'x', checkpointId: 'y', arms: [{}, {}, {}], runs: 3, ceilingOverride: 8 }, { repoPath: repoDir, exec: neverRuns }),
    ).rejects.toThrow(/the launch ceiling of 8 \(your "ceilingOverride"\)/)
    await expect(
      launchExperiment({ lane: 'x', checkpointId: 'y', arms: [{}], ceilingOverride: 0 }, { repoPath: repoDir, exec: neverRuns }),
    ).rejects.toThrow(/"ceilingOverride" must be a positive integer/)

    const checkpointId = await seedCheckpoint('lane-override', () => 1_000_000)
    const exec = execWithStubs((command) => (command === 'workmux' ? OK : null))
    const result = await launchExperiment(
      { lane: 'lane-override', checkpointId, arms: [{ model: 'opus' }], runs: 9, ceilingOverride: 9 },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )
    expect(result.failed).toBeNull()
    expect(result.arms[0]?.runs).toHaveLength(9)

    const dispatched = recordedEvents('fork.dispatched').filter((event) => (event.payload as { forkId: string }).forkId === result.forkId)
    expect(dispatched).toHaveLength(9)
    expect(dispatched.map((event) => (event.payload as { ceilingOverride?: number }).ceilingOverride)).toEqual(Array(9).fill(9))
  })

  it('measuring runs the gate in every run\'s worktree through runCli, records one fork.measured per run with its provenance, and the listing then carries the outcome per run — and nothing before that (prd53 ruling 3)', async () => {
    const checkpointId = await seedCheckpoint('lane-measure', () => 1_000_000)
    let gateRuns = 0
    const exec = execWithStubs((command) => {
      if (command === 'workmux') return OK
      if (command === 'fake-gate') {
        gateRuns += 1
        return gateRuns === 2 ? { stdout: '', stderr: '1 test failed', code: 1, failed: true } : OK
      }
      return null
    })
    const launched = await launchExperiment(
      { lane: 'lane-measure', checkpointId, arms: [{ model: 'opus' }], runs: 2 },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )
    expect(launched.failed).toBeNull()

    const sessionDir = sessionDirFor(repoDir, dataRoot)
    const recorder = new SessionRecorder('3000', sessionFilePath(sessionDir, '3000'))
    const app = buildApp({ repoPath: repoDir, repoName: 'repo', sessionDir, recorder })
    const listing = async () => {
      const response = await app.inject({ method: 'GET', headers: capabilityHeaders(app), url: '/api/lab/experiments' })
      const { experiments } = response.json() as {
        experiments: Array<{ forkId: string; arms: Array<{ runs: Array<{ run: number; outcome?: Record<string, unknown> }> }> }>
      }
      const found = experiments.find((experiment) => experiment.forkId === launched.forkId)
      if (found === undefined) throw new Error('the launched experiment is missing from the listing')
      return found
    }

    // Before measuring: two runs, neither carrying an outcome — nothing stands in for a verdict nobody gave.
    const before = await listing()
    expect(before.arms[0]?.runs.map((run) => [run.run, 'outcome' in run])).toEqual([
      [1, false],
      [2, false],
    ])

    const result = await measureExperiment(
      { forkId: launched.forkId, verifyCommand: 'fake-gate --ci' },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 3_000_000, recorder },
    )

    expect(gateRuns).toBe(2)
    expect(result.verifyCommand).toBe('fake-gate --ci')
    expect(result.measured.map((run) => [run.arm, run.run, run.verified, run.verifiedDetail])).toEqual([
      [1, 1, 'pass', null],
      [1, 2, 'fail', '1 test failed'],
    ])

    const recorded = recorder.eventsSoFar().filter((event) => event.type === 'fork.measured')
    expect(recorded).toHaveLength(2)
    expect(recorded.map((event) => (event.payload as { source: string }).source)).toEqual(['measure-route', 'measure-route'])
    // #429: this route names itself, so its ids read as `lab-measure-<n>` —
    // ordered, and never confusable with `lab/fork.ts`, `lab/checkpoint.ts` or
    // `lab/rd.ts`'s own writes into the same session file.
    expect(recorded.map((event) => event.id)).toEqual(['lab-measure-000001', 'lab-measure-000002'])

    // After measuring: each run carries ITS OWN verdict, with the provenance.
    const after = await listing()
    expect(after.arms[0]?.runs.map((run) => run.outcome?.verified)).toEqual(['pass', 'fail'])
    expect(after.arms[0]?.runs[0]?.outcome?.provenance).toEqual({
      source: 'measure-route',
      verifyCommand: 'fake-gate --ci',
      measuredAt: 3_000_000,
    })
    expect(after.arms[0]?.runs[0]?.outcome?.costUsd).toBeNull()
    expect(after.arms[0]?.runs[1]?.outcome?.verifiedDetail).toBe('1 test failed')

    await app.close()
  })

  it('a measure request is refused before the laboratory runs when malformed, and an unknown fork is named as such rather than crashing', async () => {
    const neverRuns: Exec = async (command, argv) => {
      throw new Error(`nothing should have been executed, but got: ${command} ${argv.join(' ')}`)
    }
    const recorder = new SessionRecorder('4000', sessionFilePath(sessionDirFor(repoDir, dataRoot), '4000'))
    const refuse = (body: unknown) => measureExperiment(body, { repoPath: repoDir, exec: neverRuns, dataRoot, recorder })
    await expect(refuse({})).rejects.toThrow(MeasureValidationError)
    await expect(refuse({ forkId: '' })).rejects.toThrow(/"forkId"/)
    await expect(refuse({ forkId: '--help' })).rejects.toThrow(/may not begin with "-"/)
    await expect(refuse({ forkId: 'fork-x', verifyCommand: '' })).rejects.toThrow(/"verifyCommand"/)
    await expect(refuse({ forkId: 'fork-x', verifyCommand: '--no-verify' })).rejects.toThrow(/may not begin with "-"/)

    await seedCheckpoint('lane-unknown', () => 1_000_000)
    await expect(
      measureExperiment({ forkId: 'fork-never-recorded' }, { repoPath: repoDir, exec: realExec, dataRoot, claudeProjectsRoot, recorder }),
    ).rejects.toThrow(MeasureUnknownForkError)
    expect(recorder.eventsSoFar()).toEqual([])
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
        // A small, real lock ceiling (100ms) — far below any per-exec
        // `withTimeout` ceiling #8 wires into this same call chain. The call
        // `first` is wedged on is `restoreWorkspace`'s `git worktree add`, so
        // that ceiling is `RESTORE_EXEC_TIMEOUT_MS` (120s), not `fork.ts`'s
        // `FORK_EXEC_TIMEOUT_MS` — see `lab/fork.ts:259` for why the restore
        // path is deliberately left for `restore.ts` to bound. A ceiling here
        // on the order of a per-exec one would let that unrelated timeout fire
        // first once fake time is advanced past it, unwinding `first`'s hang
        // on its own and confounding what this test means to isolate:
        // `withLabCliLock`'s OWN ceiling, not the exec-level one.
        //
        // Belt and braces either way: `firstExec` is an injected mock that
        // ignores `options.timeoutMs` entirely, so no per-exec timer exists
        // here for fake time to advance onto. The margin is what keeps that
        // true if this test is ever pointed at a real exec.
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
    // FALSE since prd-57 ruling 8, and it is the ruling rather than a
    // regression: an arm is restored and handed its command, never started.
    // `claude -p` runs a whole turn to completion, so spawning one per arm
    // would serialise the experiment inside a launch ceiling a real turn
    // exceeds — and spend the operator's money inside a loop. The route still
    // reports the field; what changed is what the laboratory does.
    expect(arm?.launched).toBe(false)
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
    // Each arm is its own independently-restored reality — never sharing a
    // worktree — and every one of them is an arm of the SAME experiment (prd53
    // ruling 1). Before prd53 this line asserted three fork ids: that was the
    // fragmentation that kept the comparison surface empty, not a law.
    expect(new Set(result.arms.map((a) => a.forkId))).toEqual(new Set([result.forkId]))
    expect(new Set(result.arms.map((a) => a.worktreePath)).size).toBe(3)
  })

  it("stops at the first failing arm and keeps what already dispatched — a fork's spend is real and is never discarded (prd12 ruling 3)", async () => {
    const checkpointId = await seedCheckpoint('lane-d', () => 1_000_000)
    let worktreeAdds = 0
    const exec = execWithStubs((command, args) => {
      if (command !== 'git' || args[0] !== 'worktree' || args[1] !== 'add') return null
      worktreeAdds += 1
      // prd-57 ruling 8 removed the `workmux add` spawn this used to fail.
      // The claim is unchanged — whatever already dispatched is kept, because a
      // fork's spend is real — so the failure moved into the RESTORE.
      return worktreeAdds === 1 ? null : { stdout: '', stderr: 'fatal: could not create work tree dir', code: 128, failed: true }
    })

    const result = await launchExperiment(
      { lane: 'lane-d', checkpointId, arms: [{ model: 'opus' }, { model: 'sonnet' }, { model: 'haiku' }] },
      { repoPath: repoDir, exec, dataRoot, claudeProjectsRoot, now: () => 2_000_000 },
    )

    expect(result.arms).toHaveLength(1)
    expect(result.arms[0]?.model).toBe('opus')
    expect(result.failed?.arm).toBe(2)
    expect(result.failed?.error).toMatch(/could not create work tree dir/)
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
      // Gated on the RESTORE's worktree add since prd-57 ruling 8 — the slow
      // call this test needs is no longer a launcher's, and the thing under
      // test (a console.error raised outside the lab during a slow fork) is
      // unchanged by which call is slow.
      if (command !== 'git' || args[0] !== 'worktree' || args[1] !== 'add') {
        return realExec(command, args, execOptions)
      }
      markWorkmuxStarted()
      await workmuxGate
      return { stdout: '', stderr: 'fatal: could not create work tree dir', code: 128, failed: true }
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
      expect(result.failed?.error).toMatch(/could not create work tree dir/)
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

describe('POST /api/lab/rd (prd-55 ruling 1 — the R&D hand, gated, reached through runCli)', () => {
  let repoPath: string
  let sessionDir: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-rd-route-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-rd-route-dir-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  function authorised(app: ReturnType<typeof buildApp>): Record<string, string> {
    return { [CAPABILITY_TOKEN_HEADER]: app.capabilityToken }
  }

  const BODY = { lane: 'w5b-412', model: 'opus' }

  /**
   * The gate, on the route that spends the MOST per call in this file: an R&D
   * run is a real model call billed to the operator. Asserting the status is
   * not enough — `runRdExperiment` must never be entered, because a 401
   * arriving after the hand was already spawned would be a gate in name only,
   * exactly as #234 found for the launch.
   */
  it('refuses a tokenless run before the laboratory is touched — a bare curl never spends the operator money', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({ method: 'POST', url: '/api/lab/rd', payload: BODY })

    expect(response.statusCode).toBe(401)
    expect((response.json() as { error: string }).error).toContain(CAPABILITY_TOKEN_HEADER)
    expect(recorder.eventsSoFar()).toEqual([])
  })

  it('refuses a wrong token just as flatly — a guess is not a capability', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })

    const response = await app.inject({
      method: 'POST',
      url: '/api/lab/rd',
      headers: { [CAPABILITY_TOKEN_HEADER]: 'not-the-token' },
      payload: BODY,
    })

    expect(response.statusCode).toBe(401)
    expect(recorder.eventsSoFar()).toEqual([])
  })

  it('refuses on a replayed record — there is no repo whose record the hand could read', async () => {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, readOnly: true })

    const response = await app.inject({ method: 'POST', url: '/api/lab/rd', headers: authorised(app), payload: BODY })

    expect(response.statusCode).toBe(409)
    expect((response.json() as { error: string }).error).toContain('replaying a session record')
  })

  describe('the body is refused at the boundary, before anything is spawned', () => {
    async function refusal(payload: Record<string, unknown>): Promise<{ status: number; error: string }> {
      const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
      const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })
      const response = await app.inject({ method: 'POST', url: '/api/lab/rd', headers: authorised(app), payload })
      return { status: response.statusCode, error: (response.json() as { error: string }).error }
    }

    it('a run with no lane, or no model, is 400 in the operator’s own vocabulary', async () => {
      expect(await refusal({ model: 'opus' })).toMatchObject({ status: 400, error: expect.stringContaining('"lane"') })
      expect(await refusal({ lane: 'x' })).toMatchObject({
        status: 400,
        error: expect.stringContaining('does not choose its own model'),
      })
    })

    it('a third corpus is refused, and the refusal says why there is no third', async () => {
      const { status, error } = await refusal({ ...BODY, corpus: 'everything' })
      expect(status).toBe(400)
      expect(error).toContain('second declared act')
    })

    it('a model the grammar refuses never reaches argv — the same sentence the launch says (#234)', async () => {
      const { status, error } = await refusal({ ...BODY, model: 'opus; rm -rf /' })
      expect(status).toBe(400)
      expect(error).toContain('this instrument refuses')
    })

    it('a flag-shaped lane is refused, because parseLabRdArgs scans raw argv for --help before -- can cover it', async () => {
      const { status, error } = await refusal({ ...BODY, lane: '--help' })
      expect(status).toBe(400)
      expect(error).toContain('may not begin with "-"')
    })

    it('an agent command that is really a command line is refused — a binary name is one word', async () => {
      const { status, error } = await refusal({ ...BODY, agentCommand: 'claude --dangerously-skip-permissions' })
      expect(status).toBe(400)
      expect(error).toContain('one word, not a command line')
    })

    it('a maxTurns that is not a count is refused', async () => {
      expect(await refusal({ ...BODY, maxTurns: 0 })).toMatchObject({ status: 400 })
      expect(await refusal({ ...BODY, maxTurns: 2.5 })).toMatchObject({ status: 400 })
    })
  })

  /**
   * The end-to-end pass, through the REAL `runCli` and the REAL engine, with
   * only the subprocess faked. This is what proves the route reaches the
   * laboratory the way the namespace law requires — `runCli(['lab','rd',…])`,
   * in-process — rather than by an import this file is forbidden to make.
   */
  describe('through the real CLI, with only the subprocess faked', () => {
    /** The whole `claude -p --output-format json` envelope, around one R&D document. */
    function handExec(document: string, onPath = true): Exec {
      return async (command, args) => {
        if (args[0] === '--version') {
          return onPath
            ? { stdout: '2.1.266 (Claude Code)\n', stderr: '', code: 0, failed: false }
            : { stdout: '', stderr: '', code: null, failed: true, errorMessage: `spawn ${command} ENOENT` }
        }
        return {
          stdout: JSON.stringify({
            result: document,
            total_cost_usd: 0.0421,
            duration_ms: 8123,
            num_turns: 1,
            session_id: 's',
          }),
          stderr: '',
          code: 0,
          failed: false,
        }
      }
    }

    const CLEAN = JSON.stringify({
      patterns: [
        {
          patternId: 'pattern-slow-gate',
          shape: 'the gate is the slowest step',
          sourceItems: ['a', 'b'],
          count: 2,
          heldBack: false,
        },
      ],
      proposals: [
        {
          proposalId: 'proposal-1',
          patternId: 'pattern-slow-gate',
          varies: 'gate',
          arms: [
            { model: null, briefDigest: null, checkpointId: null, gateCommand: 'npm test' },
            { model: null, briefDigest: null, checkpointId: null, gateCommand: 'npm run typecheck' },
          ],
          checkpointPick: { chosenCheckpointId: 'ckpt-1', rejected: [] },
        },
      ],
    })

    const CONFOUNDED = JSON.stringify({
      patterns: [
        {
          patternId: 'pattern-slow-gate',
          shape: 'the gate is the slowest step',
          sourceItems: ['a', 'b'],
          count: 2,
          heldBack: false,
        },
      ],
      proposals: [
        {
          proposalId: 'proposal-2',
          patternId: 'pattern-slow-gate',
          varies: 'gate',
          arms: [
            { model: 'opus', briefDigest: null, checkpointId: null, gateCommand: 'npm test' },
            { model: 'sonnet', briefDigest: null, checkpointId: null, gateCommand: 'npm run typecheck' },
          ],
          checkpointPick: { chosenCheckpointId: 'ckpt-1', rejected: [] },
        },
      ],
    })

    it('runs the hand and answers with the patterns, the proposal and the CLI’s own provenance', async () => {
      const result = await runRdExperiment(BODY, { repoPath, exec: handExec(CLEAN), dataRoot: sessionDir })

      expect(result.available).toBe(true)
      expect(result.lane).toBe('w5b-412')
      expect(result.patterns.map((pattern) => pattern.patternId)).toEqual(['pattern-slow-gate'])
      expect(result.proposals).toHaveLength(1)
      expect(result.refusals).toEqual([])
      expect(result.provenance).toMatchObject({ model: 'opus', total_cost_usd: 0.0421, corpus: 'local' })
      expect(result.turns).toBe(1)
      // Three since prd55 ruling 1 (#430): the patterns, the proposal, and the
      // bill. The run's cost is booked as spend, "like a fork's".
      expect(result.eventIds).toHaveLength(3)

      // And the third really IS the booking, read back off the LOG rather than
      // off the result object — a count alone would tolerate any third event.
      const written = readFileSync(result.recordedTo as string, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as RhizomorphEvent)
      expect(written.map((event) => event.id)).toEqual(result.eventIds)
      expect(written.map((event) => event.type)).toEqual(['rd.patterns', 'rd.proposal', 'llm.cost'])

      const booked = written[2] as RhizomorphEvent & { payload: Record<string, unknown> }
      // Sourced to the lab, never to a collector: no transcript was tailed for
      // this call and no OTLP receiver saw it.
      expect(booked.source).toBe('lab')
      // The figure is the CLI's own, the same one the provenance carries — so
      // the R&D tab's provenance line and the ledger cannot disagree.
      expect(booked.payload.costUsd).toBe(result.provenance?.total_cost_usd)
      expect(booked.payload).toMatchObject({ lane: 'w5b-412', authoritative: true, model: 'opus' })
    })

    it('a two-dimension proposal comes back REFUSED, in core’s own words, and never as a proposal', async () => {
      const result = await runRdExperiment(BODY, { repoPath, exec: handExec(CONFOUNDED), dataRoot: sessionDir })

      expect(result.proposals).toEqual([])
      // prd-55 ruling 9 (wave 6 widening): the route's own answer carries the
      // hand's raw result text too, so the tab's <details> has something real
      // to show — bounded, but this fixture is well under the bound.
      expect(result.refusals).toEqual([{ patternId: 'pattern-slow-gate', reason: RD_MULTI_DIMENSION_REFUSAL, rawResult: CONFOUNDED }])
    })

    it('no claude on PATH is a 200 carrying the sentence, not an error — ruling 9 draws it as a state', async () => {
      const result = await runRdExperiment(BODY, { repoPath, exec: handExec(CLEAN, false), dataRoot: sessionDir })

      expect(result.available).toBe(false)
      expect(result.reason).toBe("no claude on this machine's PATH — the R&D hand is your CLI, installed by you")
      expect(result.recordedTo).toBeNull()
      expect(result.eventIds).toEqual([])
    })

    it('the tracker corpus is carried through the CLI and recorded on the provenance', async () => {
      const result = await runRdExperiment(
        { ...BODY, corpus: 'local+tracker' },
        { repoPath, exec: handExec(CLEAN), dataRoot: sessionDir },
      )

      expect(result.corpus.choice).toBe('local+tracker')
      expect(result.provenance).toMatchObject({ corpus: 'local+tracker' })
    })
  })
})

describe('POST/GET /api/lab/comparisons (prd-14 ruling 5, #213)', () => {
  let repoPath: string
  let sessionDir: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-comparisons-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-comparisons-dir-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  const NOW = 1_700_000_000_000
  const SAVED_AT = '2023-11-14T22:13:20.000Z'
  const INPUT = {
    arms: [
      {
        id: 'a',
        model: 'opus',
        brief: 'brief-x',
        runs: [
          { id: 'r1', status: 'complete', verdict: 'pass', value: 4 },
          { id: 'r2', status: 'pending', note: 'not measured yet — no outcome is invented in its place' },
          { id: 'r3', status: 'complete', verdict: 'fail', value: 2, detail: 'timed out' },
          { id: 'r4', status: 'complete', verdict: 'pass', value: null, note: 'judged, but no cost is booked to its lane yet' },
        ],
      },
    ],
  }

  function authorised(app: ReturnType<typeof buildApp>): Record<string, string> {
    return { [CAPABILITY_TOKEN_HEADER]: app.capabilityToken }
  }

  function makeApp(opts: { readOnly?: boolean } = {}) {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    return buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => NOW, ...opts })
  }

  describe('requires the capability token', () => {
    it('401s a tokenless POST — the handler never ran, so no comparisons/ dir was ever created', async () => {
      const app = makeApp()
      const response = await app.inject({ method: 'POST', url: '/api/lab/comparisons', payload: { input: INPUT } })
      expect(response.statusCode).toBe(401)
      expect(existsSync(path.join(sessionDir, 'comparisons'))).toBe(false)
    })

    it('401s a tokenless GET on both reads', async () => {
      const app = makeApp()
      expect((await app.inject({ method: 'GET', url: '/api/lab/comparisons' })).statusCode).toBe(401)
      expect(
        (await app.inject({ method: 'GET', url: '/api/lab/comparisons/00000000-0000-4000-8000-000000000000' }))
          .statusCode,
      ).toBe(401)
    })

    it('401s a wrong token on the POST', async () => {
      const app = makeApp()
      const response = await app.inject({
        method: 'POST',
        url: '/api/lab/comparisons',
        headers: { [CAPABILITY_TOKEN_HEADER]: 'not-the-real-token' },
        payload: { input: INPUT },
      })
      expect(response.statusCode).toBe(401)
    })
  })

  it('409s the save in readOnly mode, but the reads still answer — nowhere durable to save, nothing wrong with reading', async () => {
    const app = makeApp({ readOnly: true })
    const post = await app.inject({
      method: 'POST',
      url: '/api/lab/comparisons',
      headers: authorised(app),
      payload: { input: INPUT },
    })
    expect(post.statusCode).toBe(409)
    expect((post.json() as { error: string }).error).toContain('nowhere durable to save a comparison')

    const list = await app.inject({ method: 'GET', url: '/api/lab/comparisons', headers: authorised(app) })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual({ comparisons: [] })
  })

  it('400s a body with no "input"', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/lab/comparisons',
      headers: authorised(app),
      payload: {},
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: string }).error).toBe('body must be a JSON object carrying an "input" comparison')
  })

  it("400s an input whose arm is missing fields — the parser's own sentence, unchanged by the route", async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/lab/comparisons',
      headers: authorised(app),
      payload: { input: { arms: [{ id: 'a' }] } },
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: string }).error).toBe('arm is missing one of id, model, brief, runs')
  })

  it('saves, lists and reads back a comparison — the happy path, whole body', async () => {
    const app = makeApp()

    const post = await app.inject({
      method: 'POST',
      url: '/api/lab/comparisons',
      headers: authorised(app),
      payload: { input: INPUT },
    })
    expect(post.statusCode).toBe(200)
    const { id, savedAt } = post.json() as { id: string; savedAt: string }
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(savedAt).toBe(SAVED_AT)

    const read = await app.inject({ method: 'GET', url: `/api/lab/comparisons/${id}`, headers: authorised(app) })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({ id, available: true, artifact: { version: 1, savedAt, input: INPUT } })

    const list = await app.inject({ method: 'GET', url: '/api/lab/comparisons', headers: authorised(app) })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual({
      comparisons: [{ id, available: true, savedAt, arms: 1, sizeBytes: expect.any(Number) }],
    })
  })

  it('repeated POSTs get distinct ids, and the listing grows', async () => {
    const app = makeApp()
    const ids = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const post = await app.inject({
        method: 'POST',
        url: '/api/lab/comparisons',
        headers: authorised(app),
        payload: { input: INPUT },
      })
      expect(post.statusCode).toBe(200)
      ids.add((post.json() as { id: string }).id)
    }
    expect(ids.size).toBe(3)

    const list = await app.inject({ method: 'GET', url: '/api/lab/comparisons', headers: authorised(app) })
    expect((list.json() as { comparisons: unknown[] }).comparisons).toHaveLength(3)
  })

  it('404s a well-formed but unknown id', async () => {
    const app = makeApp()
    const id = '00000000-0000-4000-8000-000000000000'
    const response = await app.inject({ method: 'GET', url: `/api/lab/comparisons/${id}`, headers: authorised(app) })
    expect(response.statusCode).toBe(404)
    expect((response.json() as { error: string }).error).toBe(`no comparison with id "${id}"`)
  })

  it('400s a malformed id, and a traversal-shaped one never reads a real session file', async () => {
    const app = makeApp()
    await writeFile(path.join(sessionDir, sessionFileName(1000)), '{}\n', 'utf8')

    const traversal = await app.inject({
      method: 'GET',
      url: '/api/lab/comparisons/..%2Fsession-1000.jsonl',
      headers: authorised(app),
    })
    expect(traversal.statusCode).toBe(400)
    expect((traversal.json() as { error: string }).error).toBe('comparison id must be a UUID')

    const malformed = await app.inject({
      method: 'GET',
      url: '/api/lab/comparisons/not-a-uuid',
      headers: authorised(app),
    })
    expect(malformed.statusCode).toBe(400)
    expect((malformed.json() as { error: string }).error).toBe('comparison id must be a UUID')
  })

  it("the issue's mutation, through the route: a version-3 rewrite refuses by name, on both the by-id read and the listing (moved from 2 to 3 since prd14 ruling 6 made 2 a real, accepted version)", async () => {
    const app = makeApp()
    const post = await app.inject({
      method: 'POST',
      url: '/api/lab/comparisons',
      headers: authorised(app),
      payload: { input: INPUT },
    })
    const { id } = post.json() as { id: string }

    const filePath = path.join(sessionDir, 'comparisons', `comparison-${id}.json`)
    const before = readFileSync(filePath, 'utf8')
    await writeFile(filePath, before.replace('"version": 1', '"version": 3'), 'utf8')

    const read = await app.inject({ method: 'GET', url: `/api/lab/comparisons/${id}`, headers: authorised(app) })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({ id, available: false, reason: 'unsupported comparison artifact version: 3' })

    const list = await app.inject({ method: 'GET', url: '/api/lab/comparisons', headers: authorised(app) })
    expect(list.json()).toEqual({
      comparisons: [{ id, available: false, reason: 'unsupported comparison artifact version: 3', sizeBytes: expect.any(Number) }],
    })
  })

  it("the app also saves a v2 artifact when the body's input carries a measure, and reads it back with every run fact intact (prd14 ruling 6)", async () => {
    const app = makeApp()
    const provenance = { verifyCommand: 'npm test', source: 'compare-cli', measuredAt: 1000 }
    // `measure`/`provenance` ride inside `input` on the wire, same as `save.ts`
    // sends them (the body is still exactly `{ input }`) — the route extracts
    // them from there, and what gets STORED strips them back out of `.input`
    // to the artifact's own top level.
    const wireInput = {
      arms: [{ id: 'a1', model: 'opus', brief: 'x', runs: [{ id: 'r1', status: 'complete', verdict: 'pass', cost: 4, duration: 900, commits: 2 }] }],
      measure: 'cost',
      provenance,
    }
    const post = await app.inject({
      method: 'POST',
      url: '/api/lab/comparisons',
      headers: authorised(app),
      payload: { input: wireInput },
    })
    expect(post.statusCode).toBe(200)
    const { id, savedAt } = post.json() as { id: string; savedAt: string }

    const read = await app.inject({ method: 'GET', url: `/api/lab/comparisons/${id}`, headers: authorised(app) })
    expect(read.json()).toEqual({
      id,
      available: true,
      artifact: { version: 2, savedAt, measure: 'cost', provenance, input: { arms: wireInput.arms } },
    })
  })

  it('a v2 save with a malformed run field refuses by name, exactly as the v1 route does', async () => {
    const app = makeApp()
    const post = await app.inject({
      method: 'POST',
      url: '/api/lab/comparisons',
      headers: authorised(app),
      payload: {
        input: {
          arms: [{ id: 'a1', model: 'opus', brief: 'x', runs: [{ id: 'r1', status: 'complete', verdict: 'pass', cost: '4', duration: 1, commits: 1 }] }],
          measure: 'cost',
        },
      },
    })
    expect(post.statusCode).toBe(400)
    expect((post.json() as { error: string }).error).toBe('complete run r1 has a cost field that is neither a number nor null')
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
