import { fetchMeta } from '@rhizomorph/web/connect/meta'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  HARNESS_LIVE_SESSION_ID,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/meta`'s contract test (prd-29 w3 / #59, #61). `readJson`'s `swallows`
 * shape: `fetchMeta` collapses every failure — no fetch, a rejected request,
 * a non-2xx, an unparsable body — onto the same `null`, so coverage needs a
 * DIRECT `h.app.inject` 401 check to prove a refusal actually happened.
 */
describe('contract: /api/meta is gated (prd-29 ruling 7, #59)', () => {
  let h: ContractHarness
  let restoreFetch: () => void

  beforeEach(async () => {
    h = await buildContractHarness()
    restoreFetch = routeGlobalFetchThroughHarness(h.fetch)
  })

  afterEach(async () => {
    restoreFetch()
    await h.close()
  })

  it('succeeds end to end: the token the server stamped is the token the client sends and the gate accepts', async () => {
    const meta = await fetchMeta()

    // Real, non-null facts about the real harness instance — never an
    // absent/error value.
    expect(meta).not.toBeNull()
    expect(meta?.sessionId).toBe(HARNESS_LIVE_SESSION_ID)
    expect(meta?.repoPath).toBe(h.repoPath)
  })

  it('a tampered token is refused by the real gate — the client swallows it to null, and the server itself answers 401', async () => {
    tamperCapabilityToken()

    await expect(fetchMeta()).resolves.toBeNull()

    const direct = await h.app.inject({
      method: 'GET',
      url: '/api/meta',
      headers: { 'x-rhizomorph-capability': '0'.repeat(64) },
    })
    expect(direct.statusCode).toBe(401)
  })

  it('a page served without the token still reaches the wire bare — the client swallows it to null, and the server itself answers 401', async () => {
    stripCapabilityToken()

    await expect(fetchMeta()).resolves.toBeNull()

    const direct = await h.app.inject({ method: 'GET', url: '/api/meta' })
    expect(direct.statusCode).toBe(401)
  })
})
