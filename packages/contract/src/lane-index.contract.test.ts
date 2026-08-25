import { fetchLaneIndex } from '@rhizomorph/web/recordings/laneIndex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/lane-index`'s contract test (prd-29 w3, #61) — the lane axis's own
 * "whole index" row (prd-31 ruling 8 / S4, #558). The REAL served page, the
 * REAL `capabilityRead`, the REAL `fetchLaneIndex`, the REAL gate — `h.fetch`
 * routed in as `globalThis.fetch`.
 */
describe('contract: the lane index is gated (prd-29 ruling 1)', () => {
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
    // Nothing in this harness's fresh repo has ever named a lane — a real,
    // honest empty index is what the real route folds to, and this proves
    // the request reached it rather than being refused.
    const page = await fetchLaneIndex()

    expect(page).toEqual({ lanes: [], unreadableSessionIds: [] })
  })

  it('a tampered token is refused by the real gate', async () => {
    tamperCapabilityToken()

    await expect(fetchLaneIndex()).rejects.toThrow(/responded 401/)
  })

  it('a page served without the token still reaches the wire bare, and the server answers its own honest 401 (ADR-0012 dev gap)', async () => {
    stripCapabilityToken()

    await expect(fetchLaneIndex()).rejects.toThrow(/responded 401/)
  })
})
