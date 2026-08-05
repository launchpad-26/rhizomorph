import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../replay/api.js'
import { fetchLabCheckpoints, fetchLabExperiments } from './api.js'

function fetchImplFor(url: string, body: unknown, ok = true, status = 200): FetchLike {
  return (async (input: string | URL | Request) => {
    const href = String(input)
    if (href === url) {
      return { ok, status, json: async () => body } as Response
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

const CHECKPOINT = {
  eventId: 'evt-1',
  lane: 'feature',
  checkpointId: 'ckpt-1',
  capturedAt: 1000,
  capturedBy: 'operator',
  snapshotRef: 'refs/rhizomorph/checkpoints/ckpt-1',
  snapshotSha: 'sha-1',
  headSha: 'sha-0',
}

const EXPERIMENT = {
  forkId: 'fork-1',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    {
      arm: 1,
      treatment: { model: 'opus', promptDigest: null },
      runs: [{ eventId: 'evt-2', dispatchedAt: 1100, laneHandle: 'fork-1-arm-1', worktreePath: '/tmp/arm-1' }],
    },
  ],
}

describe('fetchLabCheckpoints', () => {
  it('parses every checkpoint the server folded', async () => {
    const fetchImpl = fetchImplFor('/api/lab/checkpoints', { checkpoints: [CHECKPOINT] })
    expect(await fetchLabCheckpoints(fetchImpl)).toEqual([CHECKPOINT])
  })

  it('returns an honest empty list when the server has captured none yet', async () => {
    const fetchImpl = fetchImplFor('/api/lab/checkpoints', { checkpoints: [] })
    expect(await fetchLabCheckpoints(fetchImpl)).toEqual([])
  })

  it('throws — never silently empties — on a non-ok response', async () => {
    const fetchImpl = fetchImplFor('/api/lab/checkpoints', {}, false, 500)
    await expect(fetchLabCheckpoints(fetchImpl)).rejects.toThrow('/api/lab/checkpoints responded 500')
  })

  it('throws on a malformed checkpoint rather than rendering a half-built row', async () => {
    const fetchImpl = fetchImplFor('/api/lab/checkpoints', { checkpoints: [{ lane: 'feature' }] })
    await expect(fetchLabCheckpoints(fetchImpl)).rejects.toThrow(/does not recognise/)
  })
})

describe('fetchLabExperiments', () => {
  it('parses every experiment, arms and runs intact', async () => {
    const fetchImpl = fetchImplFor('/api/lab/experiments', { experiments: [EXPERIMENT] })
    expect(await fetchLabExperiments(fetchImpl)).toEqual([EXPERIMENT])
  })

  it('returns an honest empty list when no experiment has run yet', async () => {
    const fetchImpl = fetchImplFor('/api/lab/experiments', { experiments: [] })
    expect(await fetchLabExperiments(fetchImpl)).toEqual([])
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = fetchImplFor('/api/lab/experiments', {}, false, 503)
    await expect(fetchLabExperiments(fetchImpl)).rejects.toThrow('/api/lab/experiments responded 503')
  })
})
