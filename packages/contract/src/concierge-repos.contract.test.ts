import { fetchRepos } from '@rhizomorph/web/connect/meta'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/concierge/repos`'s contract test (prd-29 w3 / #58, #61). `readJson`'s
 * `swallows` shape: `fetchRepos` falls back to `{ kind: 'absent' }` on any
 * failure, so coverage needs a DIRECT `h.app.inject` 401 check to prove a
 * refusal actually happened, distinct from a real `kind: 'repos'` answer.
 */
describe('contract: /api/concierge/repos is gated (prd-29 ruling 7, #58)', () => {
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
    const reading = await fetchRepos()

    // A real answer from the real (non-replay) discovery route — never the
    // absent fallback.
    expect(reading.kind).toBe('repos')
  })

  it('a tampered token is refused by the real gate — the client swallows it to absent, and the server itself answers 401', async () => {
    tamperCapabilityToken()

    await expect(fetchRepos()).resolves.toEqual({ kind: 'absent' })

    const direct = await h.app.inject({
      method: 'GET',
      url: '/api/concierge/repos',
      headers: { 'x-rhizomorph-capability': '0'.repeat(64) },
    })
    expect(direct.statusCode).toBe(401)
  })

  it('a page served without the token still reaches the wire bare — the client swallows it to absent, and the server itself answers 401', async () => {
    stripCapabilityToken()

    await expect(fetchRepos()).resolves.toEqual({ kind: 'absent' })

    const direct = await h.app.inject({ method: 'GET', url: '/api/concierge/repos' })
    expect(direct.statusCode).toBe(401)
  })
})
