import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadLaneManifest } from '@rhizomorph/web/fleet/manifest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/lanes`'s contract test (prd-29 w3, #61) — the read axis's `swallows`
 * shape: `loadLaneManifest` never throws on a refusal, it resolves to the
 * `absent` state, so coverage here needs a DIRECT `h.app.inject` 401 check on
 * the same route as well as the client's own return value. The REAL served
 * page, the REAL `capabilityRead`, the REAL `loadLaneManifest`, the REAL gate
 * — `h.fetch` routed in as `globalThis.fetch`.
 */
describe('contract: the lane manifest is gated (prd-29 ruling 1)', () => {
  let h: ContractHarness
  let restoreFetch: () => void

  beforeEach(async () => {
    h = await buildContractHarness()
    restoreFetch = routeGlobalFetchThroughHarness(h.fetch)
    // A real `.swarm/lanes.json`, on disk at the real watched repo path — so
    // the happy path below reads a REAL manifest, not the honest-absent state
    // an unwritten one would fold to.
    await mkdir(path.join(h.repoPath, '.swarm'), { recursive: true })
    await writeFile(
      path.join(h.repoPath, '.swarm', 'lanes.json'),
      JSON.stringify({
        version: 1,
        lanes: [{ handle: '61-contract-coverage', branch: '61-contract-coverage-read-axis', fence: ['packages/contract/**'] }],
      }),
      'utf8',
    )
  })

  afterEach(async () => {
    restoreFetch()
    await h.close()
  })

  it('succeeds end to end: the token the server stamped is the token the client sends and the gate accepts', async () => {
    const state = await loadLaneManifest()

    expect(state.status).toBe('ready')
    expect(state.manifest).not.toBeNull()
    expect(state.manifest?.['61-contract-coverage']).toMatchObject({
      handle: '61-contract-coverage',
      fence: ['packages/contract/**'],
    })
  })

  it('a tampered token is refused by the real gate — the client swallows it to `absent`, and the server itself answers 401', async () => {
    tamperCapabilityToken()

    const state = await loadLaneManifest()
    expect(state).toEqual({ manifest: null, status: 'absent' })

    // The client's own return value cannot distinguish "the gate refused"
    // from "the server had nothing to say" — this direct check on the same
    // route is what actually proves the refusal happened.
    const direct = await h.app.inject({
      method: 'GET',
      url: '/api/lanes',
      headers: { 'x-rhizomorph-capability': '0'.repeat(64) },
    })
    expect(direct.statusCode).toBe(401)
  })

  it('a page served without the token still reaches the wire bare — the client swallows it to `absent`, and the server itself answers 401', async () => {
    stripCapabilityToken()

    const state = await loadLaneManifest()
    expect(state).toEqual({ manifest: null, status: 'absent' })

    const direct = await h.app.inject({ method: 'GET', url: '/api/lanes' })
    expect(direct.statusCode).toBe(401)
  })
})
