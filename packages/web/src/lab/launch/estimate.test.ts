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
