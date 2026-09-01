import { fetchLabCheckpoints } from '@rhizomorph/web/lab/api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/lab/checkpoints`'s contract test (prd-29 w3, #61). The REAL served
 * page, the REAL `capabilityRead`, the REAL `fetchLabCheckpoints`, the REAL
 * gate — `h.fetch` routed in as `globalThis.fetch`.
 */
describe('contract: lab checkpoint listing is gated (prd-29 ruling 1)', () => {
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
    // No `fork.checkpoint` has ever been captured in this harness's fresh
    // repo — a real, honest empty list is exactly what the real route folds
    // to, and this proves the request reached it rather than being refused.
    const checkpoints = await fetchLabCheckpoints()

    expect(checkpoints).toEqual([])
  })

  it('a tampered token is refused by the real gate', async () => {
    tamperCapabilityToken()

    await expect(fetchLabCheckpoints()).rejects.toThrow(/responded 401/)
  })

  it('a page served without the token still reaches the wire bare, and the server answers its own honest 401 (ADR-0012 dev gap)', async () => {
    stripCapabilityToken()

    await expect(fetchLabCheckpoints()).rejects.toThrow(/responded 401/)
  })
})
