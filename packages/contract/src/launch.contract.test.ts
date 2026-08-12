import { requestLaunch } from '@rhizomorph/web/lab/launch'
import { missingTokenMessage } from '@rhizomorph/web/recordings/capability-guidance'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContractHarness, type ContractHarness, stripCapabilityToken, tamperCapabilityToken } from './harness.js'

/**
 * `/api/lab/launch`'s contract test (prd-24 ruling 1) — moved here from
 * `web/src/lab/launch/launch.test.ts`'s seam block, claims intact.
 *
 * What it deliberately does NOT do is complete a launch: that forks a real
 * worktree and dispatches a real agent that spends real money, which is not a
 * thing a test suite may do. The request carries a body the route's own
 * validation refuses, so a **400 proves the token was accepted** — the gate
 * runs as a `preHandler`, strictly before the handler that answers 400 can be
 * reached, so the two answers cannot be confused. `api/lab.test.ts` covers
 * the dispatch itself against a stubbed `exec`.
 */
describe('contract: laboratory launch (#234, #310)', () => {
  /** A request the route's OWN validation refuses — so the answer distinguishes the gate from the handler. */
  const MALFORMED = { lane: '', checkpointId: 'ckpt-1', arms: [{}] }

  let h: ContractHarness

  beforeEach(async () => {
    h = await buildContractHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  it('the token the server stamped is the token the client sends and the gate accepts — the request reaches the handler', async () => {
    // Not a 401: the gate passed, and what came back is the handler's own
    // complaint about the lane. That is the whole claim of this test.
    await expect(requestLaunch(MALFORMED, h.fetch)).rejects.toThrow(/could not launch — .*lane/)
  })

  it("a tampered token is refused by the real gate, and the server's own sentence crosses back, with the #406 remedy appended", async () => {
    tamperCapabilityToken()

    await expect(requestLaunch(MALFORMED, h.fetch)).rejects.toThrow(
      /missing or invalid x-rhizomorph-capability/,
    )
    await expect(requestLaunch(MALFORMED, h.fetch)).rejects.toThrow(/reload this page/i)
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    stripCapabilityToken()
    const transport = vi.fn(h.fetch)

    await expect(requestLaunch(MALFORMED, transport)).rejects.toThrow(
      missingTokenMessage('launch'),
    )
    expect(transport).not.toHaveBeenCalled()
  })
})
