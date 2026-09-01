import { loadLaneIndexEntry } from '@rhizomorph/web/lane-page/laneIndex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/lane-index/:handle`'s contract test (prd-29 w3, #61) — the lane
 * axis's own "one lane" row (prd-31 ruling 5, #556). The `swallows` shape:
 * `loadLaneIndexEntry` never throws on a refusal, it carries the server's own
 * `reason` text through its return, so coverage needs both that text and a
 * DIRECT `h.app.inject` 401 check on the same route.
 *
 * The harness's fresh repo has never named any lane at all, so a handle
 * nothing matches is a genuine, deterministic "not found" — the server's own
 * `unknownLaneReason` (`server/src/api/lane-index.ts`), reached because the
 * gate accepted the request rather than refusing it. That is a real,
 * distinguishing answer from the 401 case below, where the same client
 * carries the SECURITY GATE's sentence instead — proving the token was never
 * checked against the index at all.
 */
describe('contract: one lane\'s index entry is gated (prd-29 ruling 1)', () => {
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
    const state = await loadLaneIndexEntry('no-such-lane-xyz')

    expect(state.status).toBe('absent')
    expect(state.entry).toBeNull()
    // The server's own `unknownLaneReason` — this harness's repo has never
    // named a lane, so the index holds none at all.
    expect(state.reason).toBe(
      'NO LANE "no-such-lane-xyz" IN ANY RECORDING — searched every lane handle, branch, worktree name and ' +
        'issue number in this repo\'s session directory and none of them is it; the index holds no lanes at all',
    )
  })

  it('a tampered token is refused by the real gate — the client carries the SECURITY GATE\'s own sentence, and the server itself answers 401', async () => {
    tamperCapabilityToken()

    const state = await loadLaneIndexEntry('no-such-lane-xyz')
    expect(state.status).toBe('absent')
    expect(state.entry).toBeNull()
    // The gate's own sentence, not the index's — carried through verbatim by
    // `loadLaneIndexEntry`'s `record?.error` read, proving the request never
    // reached `unknownLaneReason` at all.
    expect(state.reason).toBe(
      'missing or invalid x-rhizomorph-capability header — this route requires the per-process capability token',
    )

    const direct = await h.app.inject({
      method: 'GET',
      url: '/api/lane-index/no-such-lane-xyz',
      headers: { 'x-rhizomorph-capability': '0'.repeat(64) },
    })
    expect(direct.statusCode).toBe(401)
  })

  it('a page served without the token still reaches the wire bare — the client carries the SECURITY GATE\'s own sentence, and the server itself answers 401', async () => {
    stripCapabilityToken()

    const state = await loadLaneIndexEntry('no-such-lane-xyz')
    expect(state.status).toBe('absent')
    expect(state.reason).toBe(
      'missing or invalid x-rhizomorph-capability header — this route requires the per-process capability token',
    )

    const direct = await h.app.inject({ method: 'GET', url: '/api/lane-index/no-such-lane-xyz' })
    expect(direct.statusCode).toBe(401)
  })
})
