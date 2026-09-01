import { fetchDoctor } from '@rhizomorph/web/connect/meta'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/doctor`'s contract test (prd-29 w3 / #59, #61). `readJson`'s
 * `swallows` shape: `fetchDoctor` falls back to `{ kind: 'absent' }` on any
 * failure, so coverage needs a DIRECT `h.app.inject` 401 check to prove a
 * refusal actually happened, distinct from a real, empty `checks: []`.
 */
describe('contract: /api/doctor is gated (prd-29 ruling 7, #59)', () => {
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
    const reading = await fetchDoctor()

    // Real checks the real doctor route actually ran — never the absent
    // fallback.
    expect(reading.kind).toBe('checks')
    if (reading.kind === 'checks') {
      expect(reading.checks.length).toBeGreaterThan(0)
    }
  })

  it('a tampered token is refused by the real gate — the client swallows it to absent, and the server itself answers 401', async () => {
    tamperCapabilityToken()

    await expect(fetchDoctor()).resolves.toEqual({ kind: 'absent' })

    const direct = await h.app.inject({
      method: 'GET',
      url: '/api/doctor',
      headers: { 'x-rhizomorph-capability': '0'.repeat(64) },
    })
    expect(direct.statusCode).toBe(401)
  })

  it('a page served without the token still reaches the wire bare — the client swallows it to absent, and the server itself answers 401', async () => {
    stripCapabilityToken()

    await expect(fetchDoctor()).resolves.toEqual({ kind: 'absent' })

    const direct = await h.app.inject({ method: 'GET', url: '/api/doctor' })
    expect(direct.statusCode).toBe(401)
  })
})
