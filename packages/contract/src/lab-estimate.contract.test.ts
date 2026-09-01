import { fetchLabEstimate } from '@rhizomorph/web/lab/launch/estimate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/lab/estimate`'s contract test (prd-29 w3, #61). The REAL served
 * page, the REAL `capabilityRead`, the REAL `fetchLabEstimate`, the REAL
 * gate — `h.fetch` routed in as `globalThis.fetch`.
 */
describe('contract: lab launch estimate is gated (prd-29 ruling 1)', () => {
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
    // No lane has any recorded spend in this harness's fresh repo — the real
    // route's own honest `available: false` (ruling 4: never a fabricated
    // $0.00), reached because the gate accepted the request, not refused it.
    const estimate = await fetchLabEstimate('no-such-lane', 1)

    expect(estimate.available).toBe(false)
    expect(estimate.reason).toMatch(/has no recorded spend in the last hour/)
  })

  it('a tampered token is refused by the real gate, and the server\'s own sentence crosses back', async () => {
    tamperCapabilityToken()

    await expect(fetchLabEstimate('no-such-lane', 1)).rejects.toThrow(/missing or invalid x-rhizomorph-capability/)
  })

  it('a page served without the token still reaches the wire bare, and the server answers its own honest 401 (ADR-0012 dev gap)', async () => {
    stripCapabilityToken()

    await expect(fetchLabEstimate('no-such-lane', 1)).rejects.toThrow(/missing or invalid x-rhizomorph-capability/)
  })
})
