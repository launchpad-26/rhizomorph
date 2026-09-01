import { fetchSessions } from '@rhizomorph/web/replay/api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/sessions`'s contract test (prd-29 w3, #61) — the read axis's first
 * row. The REAL served page, the REAL `readCapabilityToken`, the REAL
 * `capabilityRead`, the REAL `fetchSessions`, the REAL gate — `h.fetch` is
 * wired in as `globalThis.fetch` (`routeGlobalFetchThroughHarness`), the one
 * substitution point a read seam's default `fetchImpl` leaves open, so every
 * call below passes NO `fetchImpl` at all.
 */
describe('contract: session listing is gated (prd-29 ruling 1)', () => {
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
    const sessions = await fetchSessions()

    // The harness's own default session (id '1000') is really on disk — a
    // real answer, not an empty vacuity.
    expect(sessions.length).toBeGreaterThan(0)
    expect(sessions.map((s) => s.id)).toContain('1000')
  })

  it('a tampered token is refused by the real gate', async () => {
    tamperCapabilityToken()

    await expect(fetchSessions()).rejects.toThrow(/responded 401/)
  })

  it('a page served without the token still reaches the wire bare, and the server answers its own honest 401 (ADR-0012 dev gap)', async () => {
    stripCapabilityToken()

    await expect(fetchSessions()).rejects.toThrow(/responded 401/)
  })
})
