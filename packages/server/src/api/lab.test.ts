import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFileName } from '../log/paths.js'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'

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
