import { fetchSessionEvents } from '@rhizomorph/web/replay/api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/sessions/:id/events`'s contract test (prd-29 w3, #61). The REAL
 * served page, the REAL `capabilityRead`, the REAL `fetchSessionEvents`, the
 * REAL gate — `h.fetch` routed in as `globalThis.fetch`, so every call below
 * passes no `fetchImpl`.
 */
describe('contract: session event log is gated (prd-29 ruling 1)', () => {
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
    const read = await fetchSessionEvents('1000')

    // The harness's default session (id '1000') carries a real
    // `session.started` event on disk — a real answer, not an empty vacuity.
    expect(read.events.length).toBeGreaterThan(0)
    expect(read.events.map((e) => e.type)).toContain('session.started')
  })

  it('a tampered token is refused by the real gate', async () => {
    tamperCapabilityToken()

    await expect(fetchSessionEvents('1000')).rejects.toThrow(/responded 401/)
  })

  it('a page served without the token still reaches the wire bare, and the server answers its own honest 401 (ADR-0012 dev gap)', async () => {
    stripCapabilityToken()

    await expect(fetchSessionEvents('1000')).rejects.toThrow(/responded 401/)
  })
})
