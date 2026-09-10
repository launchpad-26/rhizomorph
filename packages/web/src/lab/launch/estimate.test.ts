import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../../replay/api.js'
import { fetchLabEstimate } from './estimate.js'

function answering(payload: unknown, status = 200): FetchLike {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })) as unknown as FetchLike
}

describe('fetchLabEstimate', () => {
  it('asks the exact route with lane and arms as query params', async () => {
    let seenUrl: string | undefined
    const fetchImpl = (async (url: string | URL | Request) => {
      seenUrl = String(url)
      return { ok: true, status: 200, json: async () => ({ lane: 'feature', arms: 3, available: false, reason: 'x' }) }
    }) as unknown as FetchLike

    await fetchLabEstimate('feature', 3, fetchImpl)
    expect(seenUrl).toBe('/api/lab/estimate?lane=feature&arms=3')
  })

  it('reports an available estimate with its basis', async () => {
    const fetchImpl = answering({
      lane: 'feature',
      arms: 3,
      available: true,
      windowMs: 3_600_000,
      costUsdPerHour: 1.6,
      estimatedTotalUsd: 4.8,
    })

    const estimate = await fetchLabEstimate('feature', 3, fetchImpl)
    expect(estimate).toEqual({
      lane: 'feature',
      arms: 3,
      available: true,
      windowMs: 3_600_000,
      costUsdPerHour: 1.6,
      estimatedTotalUsd: 4.8,
    })
  })

  it('reports "cannot be established" honestly, never a fabricated number', async () => {
    const fetchImpl = answering({ lane: 'idle', arms: 2, available: false, reason: '"idle" has no recorded spend' })

    const estimate = await fetchLabEstimate('idle', 2, fetchImpl)
    expect(estimate.available).toBe(false)
    expect(estimate.reason).toMatch(/no recorded spend/)
    expect(estimate.costUsdPerHour).toBeUndefined()
    expect(estimate.estimatedTotalUsd).toBeUndefined()
  })

  it('throws the server refusal rather than returning a half-believed answer', async () => {
    const fetchImpl = answering({ error: 'lane and arms query params are required' }, 400)
    await expect(fetchLabEstimate('', 0, fetchImpl)).rejects.toThrow(/lane and arms query params are required/)
  })

  it('throws on a response shaped like nothing this console recognises', async () => {
    const fetchImpl = answering({ nonsense: true })
    await expect(fetchLabEstimate('feature', 3, fetchImpl)).rejects.toThrow(/something other than an estimate/)
  })
})

describe('fetchLabEstimate — arms × runs (prd53 ruling 1; prd-55 ruling 7)', () => {
  it('asks for arms alone when given a count, and adds runs as its own query param when given arms × runs', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url))
      return { ok: true, status: 200, json: async () => ({ lane: 'feature', arms: 3, runs: 2, lanes: 6, available: false, reason: 'x' }) }
    }) as unknown as FetchLike

    await fetchLabEstimate('feature', 3, fetchImpl)
    await fetchLabEstimate('feature', { arms: 3, runs: 2 }, fetchImpl)
    expect(seen).toEqual(['/api/lab/estimate?lane=feature&arms=3', '/api/lab/estimate?lane=feature&arms=3&runs=2'])
  })

  it("carries the runs and lanes the server counted — the server's figures, never a product formed here", async () => {
    const estimate = await fetchLabEstimate(
      'feature',
      { arms: 3, runs: 2 },
      answering({ lane: 'feature', arms: 3, runs: 2, lanes: 6, available: true, windowMs: 3_600_000, costUsdPerHour: 1.6, estimatedTotalUsd: 9.6 }),
    )
    expect(estimate).toEqual({ lane: 'feature', arms: 3, runs: 2, lanes: 6, available: true, windowMs: 3_600_000, costUsdPerHour: 1.6, estimatedTotalUsd: 9.6 })
  })

  it("an answer that states no lanes is read as it stands — the arm count alone, with nothing multiplied in", async () => {
    // A server from before prd53 answered without `runs` and `lanes`. The panel
    // then says "3 arm(s)" and no more; the mutation this pins is a parser that
    // fills `lanes: arms * 1` in on the server's behalf.
    const estimate = await fetchLabEstimate('feature', 3, answering({ lane: 'feature', arms: 3, available: false, reason: 'no spend' }))
    expect(estimate).toEqual({ lane: 'feature', arms: 3, available: false, reason: 'no spend' })
    expect(estimate).not.toHaveProperty('lanes')
    expect(estimate).not.toHaveProperty('runs')
  })
})
